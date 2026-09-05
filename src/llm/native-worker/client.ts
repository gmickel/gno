import type { ApprovedModel, NativeRequest, NativeResponse } from "./protocol";
import type { NativeRuntimeConfig } from "./runtime-config";

import { NativeWorkerError } from "./errors";
import {
  frameNativeMessage,
  NativeFrameDecoder,
  NativeRequestLedger,
  parseNativeRequest,
} from "./protocol";
import {
  nativeWorkerEnvironment,
  NativeRuntimeConfigSchema,
  NativeRegistrationSchema,
  wireError,
} from "./runtime-config";

type Input = NativeRequest extends infer R
  ? R extends NativeRequest
    ? Omit<R, "version" | "generation" | "requestId">
    : never
  : never;
type Child = ReturnType<typeof Bun.spawn>;
interface Pending {
  request: NativeRequest;
  resolve(value: NativeResponse["result"]): void;
}
interface Owner {
  generation: number;
  child: Child;
  ledger: NativeRequestLedger;
  decoder: NativeFrameDecoder;
  pending: Pending[];
  ready: boolean;
  busy: boolean;
  retiring: boolean;
  timer?: ReturnType<typeof setTimeout>;
  retirement?: Promise<void>;
  drain: Set<() => void>;
}
export interface NativeWorkerClientOptions {
  models: readonly ApprovedModel[];
  loadTimeout: number;
  inferenceTimeout: number;
  warmModelTtl?: number;
  /** Internal fault-test launch seam; never populated from caller configuration. */
  entryPath?: string;
}

/** One process generation, one active operation and 64 waiting logical calls. */
export class NativeWorkerClient {
  private owner?: Owner;
  private generation = 0;
  private requestId = 0;
  private closed = false;
  private leases = 0;
  private idleOwner?: Owner;
  private registration: Promise<void> = Promise.resolve();
  private readonly options: NativeWorkerClientOptions;

  constructor(options: NativeWorkerClientOptions) {
    this.options = { ...options, models: structuredClone(options.models) };
    process.once("exit", this.onParentExit);
  }

  private readonly onParentExit = (): void => {
    this.owner?.child.kill("SIGKILL");
  };

  get processId(): number | undefined {
    return this.owner?.child.pid;
  }
  get currentGeneration(): number {
    return this.generation;
  }

  acquireLease(): { release(): void } {
    if (this.closed) throw new NativeWorkerError("exited");
    this.leases++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.leases--;
        const owner = this.idleOwner;
        if (
          !this.leases &&
          owner &&
          this.owner === owner &&
          !owner.pending.length &&
          !owner.busy
        )
          void this.retire(owner);
      },
    };
  }

  async disposeModel(uri: string): Promise<void> {
    const operation = this.registration.then(async () => {
      const owner = this.owner;
      if (
        !owner ||
        !this.options.models.some((entry) => entry.modelUri === uri)
      )
        return;
      if (owner.pending.length || owner.busy)
        await new Promise<void>((resolve) => owner.drain.add(resolve));
      // The child lease intentionally keeps models alive: process retirement is
      // the only complete native allocation release. Other roles reload lazily.
      await this.retire(owner);
    });
    this.registration = operation.catch(() => {});
    await operation;
  }

  /** Only the parent model-selection/policy layer may approve these descriptors. */
  registerModel(model: ApprovedModel): Promise<void> {
    const descriptor = NativeRegistrationSchema.parse({
      register: model,
    }).register;
    const operation = this.registration.then(async () => {
      if (this.closed) throw new NativeWorkerError("exited");
      const existing = this.options.models.find(
        (entry) => entry.id === descriptor.id
      );
      if (existing && JSON.stringify(existing) === JSON.stringify(descriptor))
        return;
      const models = [
        ...this.options.models.filter((entry) => entry.id !== descriptor.id),
        descriptor,
      ];
      NativeRuntimeConfigSchema.parse({
        generation: Math.max(1, this.generation),
        models,
        loadTimeout: this.options.loadTimeout,
        inferenceTimeout: this.options.inferenceTimeout,
        warmModelTtl: this.options.warmModelTtl ?? 300_000,
      });
      const owner = this.owner;
      if (existing && owner) {
        if (owner.pending.length || owner.busy)
          await new Promise<void>((resolve) => owner.drain.add(resolve));
        await this.retire(owner);
      } else if (owner && !owner.retiring) {
        owner.child.send({ register: descriptor });
      }
      this.options.models = models;
    });
    this.registration = operation.catch(() => {});
    return operation;
  }

  async request(input: Input): Promise<NativeResponse["result"]> {
    await this.registration;
    if (this.closed)
      return {
        ok: false,
        error: wireError(new NativeWorkerError("exited").detail),
      };
    if (this.owner?.retiring) await this.owner.retirement;
    if (this.closed)
      return {
        ok: false,
        error: wireError(new NativeWorkerError("exited").detail),
      };
    if (input.op === "dispose" && !this.owner) return { ok: true, value: null };
    try {
      const owner = this.owner ?? this.start();
      const request = parseNativeRequest(
        {
          ...input,
          version: 1,
          generation: owner.generation,
          requestId: ++this.requestId,
        },
        owner.generation,
        this.options.models
      );
      owner.ledger.admit(request);
      return new Promise((resolve) => {
        owner.pending.push({ request, resolve });
        if (owner.pending.length === 1 && owner.ready) this.sendNext(owner);
      });
    } catch (cause) {
      return {
        ok: false,
        error: wireError(
          (cause instanceof NativeWorkerError
            ? cause
            : new NativeWorkerError("exited")
          ).detail
        ),
      };
    }
  }

  private start(): Owner {
    // A compiled executable cannot interpret an external TS entry: invoking it
    // here would recursively launch the CLI. npm/desktop ship the source runtime.
    if (import.meta.dir.includes("$bunfs"))
      throw new NativeWorkerError("exited");
    const config: NativeRuntimeConfig = NativeRuntimeConfigSchema.parse({
      generation: ++this.generation,
      models: this.options.models,
      loadTimeout: this.options.loadTimeout,
      inferenceTimeout: this.options.inferenceTimeout,
      warmModelTtl: this.options.warmModelTtl ?? 300_000,
    });
    // IPC callbacks execute after this synchronous ownership publication.
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "--no-env-file",
        this.options.entryPath ?? `${import.meta.dir}/entry.ts`,
        JSON.stringify(config),
      ],
      env: nativeWorkerEnvironment(),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
      serialization: "advanced",
      ipc: (message) => this.receive(owner, message),
    });
    const owner: Owner = {
      generation: config.generation,
      child,
      ledger: new NativeRequestLedger(config.generation),
      decoder: new NativeFrameDecoder(config.generation),
      pending: [],
      ready: false,
      busy: false,
      retiring: false,
      drain: new Set(),
    };
    this.owner = owner;
    owner.timer = setTimeout(
      () => this.fail(owner, new NativeWorkerError("timeout")),
      this.options.loadTimeout
    );
    void child.exited.then(() => {
      this.fail(owner, new NativeWorkerError("exited"));
      if (this.owner === owner) this.owner = undefined;
    });
    return owner;
  }

  private receive(owner: Owner, message: unknown): void {
    if (owner.retiring || this.owner !== owner) return;
    try {
      if (message === "ready") {
        if (owner.ready) throw new NativeWorkerError("protocol");
        owner.ready = true;
        clearTimeout(owner.timer);
        this.sendNext(owner);
        return;
      }
      if (message === "idle") {
        this.idleOwner = owner;
        if (!this.leases && !owner.pending.length && !owner.busy)
          void this.retire(owner);
        return;
      }
      if (!(message instanceof Uint8Array))
        throw new NativeWorkerError("protocol");
      const decoded = owner.decoder.push(message);
      if (decoded === undefined) return;
      const response = owner.ledger.settle(decoded);
      const pending = owner.pending[0];
      if (pending?.request.requestId !== response.requestId)
        throw new NativeWorkerError("protocol");
      clearTimeout(owner.timer);
      owner.pending.shift();
      pending.resolve(response.result);
      // Promise delivery has been queued before acknowledging settlement.
      queueMicrotask(() => {
        if (owner.retiring) return;
        try {
          owner.child.send({ ack: response.requestId });
          owner.busy = false;
          if (!owner.pending.length) {
            for (const resolve of owner.drain) resolve();
            owner.drain.clear();
          }
          this.sendNext(owner);
        } catch {
          this.fail(owner, new NativeWorkerError("exited"));
        }
      });
    } catch (cause) {
      this.fail(
        owner,
        cause instanceof NativeWorkerError
          ? cause
          : new NativeWorkerError("protocol")
      );
    }
  }

  private sendNext(owner: Owner): void {
    const pending = owner.pending[0];
    if (!pending || owner.retiring || owner.busy) return;
    this.idleOwner = undefined;
    owner.busy = true;
    clearTimeout(owner.timer);
    owner.timer = setTimeout(
      () => this.fail(owner, new NativeWorkerError("timeout")),
      this.options.loadTimeout + this.options.inferenceTimeout
    );
    try {
      for (const frame of frameNativeMessage(pending.request))
        owner.child.send(frame);
    } catch {
      this.fail(owner, new NativeWorkerError("exited"));
    }
  }

  private fail(owner: Owner, error: NativeWorkerError): void {
    if (!owner.retiring) {
      for (const response of owner.ledger.failAll(error)) {
        owner.pending
          .find((entry) => entry.request.requestId === response.requestId)
          ?.resolve(response.result);
      }
      owner.pending.length = 0;
      void this.retire(owner, true);
    }
  }

  private retire(owner: Owner, force = false): Promise<void> {
    if (owner.retirement) return owner.retirement;
    owner.retiring = true;
    for (const resolve of owner.drain) resolve();
    owner.drain.clear();
    clearTimeout(owner.timer);
    owner.decoder.reset();
    owner.retirement = (async () => {
      const killTimer = setTimeout(() => owner.child.kill("SIGKILL"), 1000);
      try {
        if (force) owner.child.kill("SIGKILL");
        else owner.child.send("shutdown");
      } catch {
        owner.child.kill("SIGKILL");
      } finally {
        await owner.child.exited;
        clearTimeout(killTimer);
        if (this.owner === owner) this.owner = undefined;
      }
    })();
    return owner.retirement;
  }

  async dispose(): Promise<void> {
    this.closed = true;
    process.removeListener("exit", this.onParentExit);
    const owner = this.owner;
    if (!owner) return;
    for (const response of owner.ledger.failAll(
      new NativeWorkerError("exited")
    )) {
      owner.pending
        .find((entry) => entry.request.requestId === response.requestId)
        ?.resolve(response.result);
    }
    owner.pending.length = 0;
    await this.retire(owner);
  }
}
