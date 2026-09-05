import type { ModelLifecycleStats } from "../nodeLlamaCpp/lifecycle";
import type { InferenceOptions } from "../types";
import type { Owner, Pending } from "./owner";
import type { ApprovedModel, NativeRequest, NativeResponse } from "./protocol";
import type { NativeRuntimeConfig } from "./runtime-config";

import { InferenceSettlement } from "../inference-cancellation";
import { inferenceOptions, recordInferenceTimeout } from "../inference-scope";
import { NativeWorkerError } from "./errors";
import {
  cancelPending,
  wireResult,
  waitForQuarantine,
  releaseQuarantine,
} from "./owner";
import {
  frameNativeMessage,
  NativeFrameDecoder,
  NativeRequestLedger,
  parseNativeRequest,
  NativeExecutionStartedSchema,
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
  private lifecycle?: ModelLifecycleStats;
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

  /** Last child-reported snapshot; reading it sends no IPC and cannot extend idle. */
  getLifecycleStats(): ModelLifecycleStats {
    const snapshot = this.lifecycle ?? {
      activeLeases: 0,
      leaseAcquisitions: 0,
      leaseReleases: 0,
      loadedModels: 0,
      loadAttempts: 0,
      loadSuccesses: 0,
      loadFailures: 0,
      inflightLoads: 0,
    };
    return this.owner
      ? { ...snapshot }
      : {
          ...snapshot,
          activeLeases: 0,
          loadedModels: 0,
          inflightLoads: 0,
        };
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

  async request(
    input: Input,
    expectedGeneration?: number,
    options?: InferenceOptions
  ): Promise<NativeResponse["result"]> {
    const operational = inferenceOptions({
      ...options,
      deadlineAt: options?.deadlineAt ?? input.deadlineAt,
    });
    const settlement = new InferenceSettlement<
      Extract<NativeResponse["result"], { ok: true }>["value"]
    >(operational, this.options.inferenceTimeout);
    void this.enqueue(
      { ...input, deadlineAt: operational.deadlineAt },
      expectedGeneration,
      settlement
    ).catch(() => {
      settlement.fail(new NativeWorkerError("exited").detail);
    });
    return settlement.completion.then((result) => {
      if (!result.ok && result.error.code === "TIMEOUT")
        recordInferenceTimeout();
      return wireResult(result);
    });
  }

  private async enqueue(
    input: Input,
    expectedGeneration: number | undefined,
    settlement: Pending["settlement"]
  ): Promise<void> {
    const result = await this.admit(input, expectedGeneration, settlement);
    if (settlement.phase === "queued") settlement.startNative();
    settlement.nativeSettled(result);
    settlement.publish();
  }

  private async admit(
    input: Input,
    expectedGeneration: number | undefined,
    settlement: Pending["settlement"]
  ): Promise<NativeResponse["result"]> {
    await this.registration;
    if (settlement.signal.aborted)
      return settlement.completion.then(wireResult);
    if (this.closed)
      return {
        ok: false,
        error: wireError(new NativeWorkerError("exited").detail),
      };
    while (this.owner?.quarantined && !this.owner.retiring) {
      try {
        await waitForQuarantine(this.owner, settlement);
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
      if (settlement.signal.aborted)
        return settlement.completion.then(wireResult);
    }
    if (this.owner?.retiring) await this.owner.retirement;
    if (this.closed)
      return {
        ok: false,
        error: wireError(new NativeWorkerError("exited").detail),
      };
    if (settlement.signal.aborted)
      return settlement.completion.then(wireResult);
    if (input.op === "dispose" && !this.owner) return { ok: true, value: null };
    try {
      // Metadata-dependent inference must never start/replay on a replacement
      // owner. All asynchronous registration/retirement waits precede this fence.
      if (
        expectedGeneration !== undefined &&
        (!this.owner ||
          this.owner.retiring ||
          this.owner.generation !== expectedGeneration)
      )
        throw new NativeWorkerError("stale_generation");
      const owner = this.owner ?? this.start();
      const request = parseNativeRequest(
        {
          ...input,
          deadlineAt: input.deadlineAt,
          version: 1,
          generation: owner.generation,
          requestId: ++this.requestId,
        },
        owner.generation,
        this.options.models
      );
      owner.ledger.admit(request);
      return new Promise((resolve) => {
        const pending: Pending = { request, resolve, settlement };
        owner.pending.push(pending);
        settlement.signal.addEventListener(
          "abort",
          () => this.cancel(owner, pending),
          { once: true }
        );
        if (settlement.signal.aborted) this.cancel(owner, pending);
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
    this.lifecycle = undefined;
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
      quarantined: false,
      waiters: new Set(),
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
      if (
        typeof message === "object" &&
        message !== null &&
        "executionStarted" in message
      ) {
        const parsed = NativeExecutionStartedSchema.safeParse(message);
        const pending = owner.pending[0];
        if (
          !parsed.success ||
          !owner.busy ||
          !pending ||
          pending.executionStarted ||
          ["init", "dispose"].includes(pending.request.op) ||
          parsed.data.generation !== owner.generation ||
          parsed.data.requestId !== pending.request.requestId
        )
          throw new NativeWorkerError("protocol");
        if (
          pending.loadDeadline !== undefined &&
          performance.now() >= pending.loadDeadline
        )
          pending.settlement.cancel("timeout");
        pending.loadDeadline = undefined;
        pending.executionStarted = true;
        clearTimeout(owner.timer);
        pending.settlement.startExecution();
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
      if (
        pending.loadDeadline !== undefined &&
        performance.now() >= pending.loadDeadline
      )
        pending.settlement.cancel("timeout");
      clearTimeout(pending.cancelTimer);
      owner.pending.shift();
      releaseQuarantine(owner);
      if (response.lifecycle) this.lifecycle = response.lifecycle;
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
    if (!pending.settlement.startNative()) {
      this.cancel(owner, pending);
      return;
    }
    owner.busy = true;
    pending.loadDeadline = performance.now() + this.options.loadTimeout;
    clearTimeout(owner.timer);
    owner.timer = setTimeout(
      () => pending.settlement.cancel("timeout"),
      this.options.loadTimeout
    );
    try {
      for (const frame of frameNativeMessage(pending.request))
        owner.child.send(frame);
    } catch {
      this.fail(owner, new NativeWorkerError("exited"));
    }
  }

  private cancel(owner: Owner, pending: Pending): void {
    cancelPending(
      owner,
      pending,
      (current, error) => this.fail(current, error),
      (current) => this.sendNext(current)
    );
  }

  private fail(owner: Owner, error: NativeWorkerError): void {
    if (owner.retiring) return;
    // Delivery can fail now; ownership is acknowledged only after child exit.
    for (const pending of owner.pending) {
      clearTimeout(pending.cancelTimer);
      pending.settlement.fail(error.detail);
    }
    void this.retire(owner, true).then(() => {
      for (const response of owner.ledger.failAll(error)) {
        owner.pending
          .find((entry) => entry.request.requestId === response.requestId)
          ?.resolve(response.result);
      }
      owner.pending.length = 0;
      owner.busy = false;
    });
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
        releaseQuarantine(owner);
      }
    })();
    return owner.retirement;
  }

  async dispose(): Promise<void> {
    this.closed = true;
    process.removeListener("exit", this.onParentExit);
    const owner = this.owner;
    if (!owner) return;
    const failure = new NativeWorkerError("exited");
    for (const pending of owner.pending) {
      clearTimeout(pending.cancelTimer);
      pending.settlement.fail(failure.detail);
    }
    await this.retire(owner);
    for (const response of owner.ledger.failAll(failure))
      owner.pending
        .find((entry) => entry.request.requestId === response.requestId)
        ?.resolve(response.result);
    owner.pending.length = 0;
    owner.busy = false;
  }
}
