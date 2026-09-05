import type { Subprocess } from "bun";

/** Development-only exact-entry spawn bridge. No native runtime imports. */
// Bun lacks synchronous private directory/atomic sidecar and canonical-path APIs.
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  lstatSync,
  writeFileSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { join, resolve } from "node:path"; // Bun has no path helpers.

import type { NativeCapture } from "./capture-contract";
import type { ChildEvent, ChildIdentity, ChildReceipt } from "./child-receipt";
import type { AcceptanceManifest } from "./manifest";

import { RetrievalTraceSession } from "../../src/core/retrieval-trace-session";
import {
  SEARCH_RESULTS_TRACE_METADATA,
  type SearchResults,
} from "../../src/pipeline/types";
import { emptyCapture } from "./capture-contract";
import { appendChildCapture, validateChildReceipt } from "./child-receipt";

export async function hasNativeWorker(): Promise<boolean> {
  return Bun.file(
    new URL("../../src/llm/native-worker/entry.ts", import.meta.url)
  ).exists();
}
let active = false;
export async function installParentCapture(
  runId: string,
  pins: AcceptanceManifest["models"],
  directory: string,
  onUpdate?: (capture: NativeCapture) => void,
  onChild?: (event: ChildEvent) => void
) {
  if (active) throw new Error("Native acceptance capture already active");
  const root = realpathSync(directory);
  if (root !== resolve(directory))
    throw new Error("Capture directory must be canonical");
  if ((lstatSync(root).mode & 0o077) !== 0)
    throw new Error("Capture directory must be private");
  if (
    (await Bun.file(join(root, "children.json")).exists()) ||
    (await Bun.file(join(root, "requests.json")).exists()) ||
    (await Bun.file(join(root, "parent-capture.json")).exists())
  )
    throw new Error("Stale child capture directory");
  const entry = realpathSync(
    new URL("../../src/llm/native-worker/entry.ts", import.meta.url)
  );
  const preload = realpathSync(
    join(import.meta.dir, "native-child-preload.ts")
  );
  // Dynamic imports keep archived snapshots without the worker usable.
  const { NativeFrameDecoder, NativeRequestSchema } =
    await import("../../src/llm/native-worker/protocol");
  const { NativeRuntimeConfigSchema, NativeRegistrationSchema } =
    await import("../../src/llm/native-worker/runtime-config");
  active = true;
  const capture = emptyCapture(runId);
  const events: ChildEvent[] = [];
  const children: Array<{
    child: Subprocess;
    identity: ChildIdentity;
    directory: string;
  }> = [];
  const requests: Array<{
    identity: ChildIdentity;
    request: ReturnType<typeof NativeRequestSchema.parse>;
    directory: string;
    scope: number;
    caseId: string;
  }> = [];
  let scope = 0;
  let caseId = "startup";
  let scopeOpen = true; // Startup discoveries belong to the initial scope.
  const receipts: ChildReceipt[] = [];
  const publish = () => {
    const path = join(root, "parent-capture.json");
    writeFileSync(`${path}.partial`, JSON.stringify(capture), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(`${path}.partial`, path);
    onUpdate?.(capture);
  };
  const event = (value: ChildEvent) => {
    events.push(value);
    const file = join(root, "children.json");
    writeFileSync(`${file}.partial`, JSON.stringify(events), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(`${file}.partial`, file);
    onChild?.(value);
  };
  const spawn = Bun.spawn;
  const dlopen = process.dlopen;
  const bindingLoads: string[] = [];
  process.dlopen = function (...args) {
    if (/llama|ggml/i.test(String(args[1]))) bindingLoads.push(String(args[1]));
    return Reflect.apply(dlopen, process, args) as void;
  };
  function parentNativeState(): NonNullable<NativeCapture["parentNative"]> {
    const nativeModules = Object.keys(require.cache).filter((path) =>
      /nodeLlamaCpp\/(?:embedding|generation|lifecycle|rerank)\.[cm]?[jt]s$|node-llama-cpp\//.test(
        path
      )
    );
    let mappedModels: string[] | null = null;
    if (process.platform === "linux") {
      try {
        mappedModels = readFileSync("/proc/self/maps", "utf8")
          .split("\n")
          .filter((line) =>
            /\.gguf(?:$|\s)|(?:llama|ggml).*\.(?:node|so)/i.test(line)
          );
      } catch {
        /* Missing OS allocation evidence stays explicit. */
      }
    }
    return {
      pid: process.pid,
      bindingLoads: [...bindingLoads],
      nativeModules,
      mappedModels,
      mappingSource:
        process.platform === "linux"
          ? "/proc/self/maps"
          : "unavailable-use-owned-GPU-and-platform-proof",
    };
  }
  const defineProperty = Object.defineProperty;
  // This private Symbol comes from the selected product source. Observe only
  // its actual metadata attachment; unrelated property definitions pass through.
  Object.defineProperty = function (
    object: object,
    key: PropertyKey,
    descriptor: PropertyDescriptor
  ) {
    const result = defineProperty(object, key, descriptor);
    if (key === SEARCH_RESULTS_TRACE_METADATA) {
      const search = object as SearchResults;
      const trace = search[SEARCH_RESULTS_TRACE_METADATA];
      (capture.searchResults ??= []).push({
        source: "src/pipeline/trace-metadata.ts",
        method: "attachSearchResultsTraceMetadata",
        result: structuredClone(search),
        trace: trace ? structuredClone(trace) : null,
      });
      if (!trace || !Array.isArray(trace.capabilityOutcomes))
        capture.errors.push(
          "Selected pipeline capability attachment unavailable"
        );
      publish();
    }
    return result;
  } as typeof Object.defineProperty;
  const capability = RetrievalTraceSession.prototype.recordCapability;
  RetrievalTraceSession.prototype.recordCapability = function (
    name,
    status,
    reasonCode,
    run
  ) {
    capture.capabilities.push({
      capability: name,
      status,
      ...(reasonCode === undefined ? {} : { reasonCode }),
    });
    publish();
    return capability.call(this, name, status, reasonCode, run);
  };
  const bridge = (first: unknown, ...rest: unknown[]): Subprocess => {
    const options = first as {
      cmd?: string[];
      env?: Record<string, string>;
      ipc?: (...args: unknown[]) => void;
      serialization?: string;
    };
    if (!options?.cmd?.includes(entry))
      return Reflect.apply(spawn, Bun, [first, ...rest]) as Subprocess;
    const cmd = options.cmd;
    if (
      rest.length ||
      cmd.length !== 4 ||
      cmd[0] !== process.execPath ||
      cmd[1] !== "--no-env-file" ||
      cmd[2] !== entry ||
      options.serialization !== "advanced" ||
      !options.ipc
    )
      throw new Error("Unsupported native capture launch");
    const config = NativeRuntimeConfigSchema.parse(JSON.parse(cmd[3]!));
    const childDirectory = mkdtempSync(join(root, "native-"));
    const token = crypto.randomUUID();
    const partialIdentity = {
      runId,
      token,
      parentPid: process.pid,
      generation: config.generation,
      entry,
    };
    const bootstrap = join(childDirectory, "bootstrap.json");
    writeFileSync(
      bootstrap,
      JSON.stringify({ identity: partialIdentity, models: pins }),
      { mode: 0o600, flag: "wx" }
    );
    const child = Reflect.apply(spawn, Bun, [
      {
        ...options,
        cmd: [cmd[0], cmd[1], "--preload", preload, ...cmd.slice(2)],
        env: { ...options.env, GNO_ACCEPTANCE_CHILD_BOOTSTRAP: bootstrap },
        ipc: (...args: unknown[]) => {
          collect();
          options.ipc!(...args);
        },
      },
    ]) as Subprocess;
    const identity = {
      runId,
      token,
      parentPid: process.pid,
      pid: child.pid,
      generation: config.generation,
      entry,
    };
    children.push({ child, identity, directory: childDirectory });
    event({ identity, event: "birth" });
    const decoder = new NativeFrameDecoder(config.generation);
    const send = child.send;
    child.send = function (message) {
      if (message instanceof Uint8Array) {
        const decoded = decoder.push(message);
        if (decoded !== undefined) {
          const request = NativeRequestSchema.parse(decoded);
          if (!scopeOpen && request.op !== "dispose")
            throw new Error("Unscoped native capture request");
          if (
            requests.some(
              (item) =>
                item.identity.token === token &&
                item.request.requestId === request.requestId
            )
          )
            throw new Error("Duplicate native capture request");
          requests.push({
            identity,
            request,
            directory: childDirectory,
            scope: scopeOpen ? scope : -1,
            caseId,
          });
          const ledger = join(root, "requests.json");
          writeFileSync(
            `${ledger}.partial`,
            JSON.stringify({ runId, parentPid: process.pid, requests }),
            { mode: 0o600, flag: "wx" }
          );
          renameSync(`${ledger}.partial`, ledger);
        }
      } else if (
        typeof message === "object" &&
        message !== null &&
        "register" in message
      ) {
        NativeRegistrationSchema.parse(message);
      }
      return send.call(child, message);
    };
    void child.exited.then((exitCode) => {
      collect();
      event({ identity, event: "exit", exitCode });
    });
    return child;
  };
  Bun.spawn = bridge as typeof Bun.spawn;
  function collect(final = false): NativeCapture {
    const next = emptyCapture(runId);
    next.capabilities = capture.capabilities;
    next.searchResults = capture.searchResults;
    receipts.length = 0;
    for (const item of requests.filter((item) => item.scope === scope)) {
      try {
        const file = join(
          item.directory,
          `${item.identity.pid}-${item.request.requestId}.json`
        );
        const receipt = validateChildReceipt(
          JSON.parse(readFileSync(file, "utf8")),
          item.identity,
          item.request
        );
        receipts.push(receipt);
        appendChildCapture(next, receipt);
      } catch (error) {
        if (final || !scopeOpen)
          next.errors.push(
            `Missing/invalid native child receipt:${item.identity.pid}:${item.request.requestId}:${String(error)}`
          );
      }
    }
    next.nativeRequests = receipts.map((receipt) => ({
      ...receipt,
      scope: { sequence: scope, caseId },
    }));
    next.parentNative = parentNativeState();
    if (
      next.parentNative.bindingLoads.length ||
      next.parentNative.mappedModels?.length
    )
      next.errors.push("Public parent loaded native inference binding/model");
    Object.assign(capture, next);
    publish();
    return capture;
  }
  collect(); // Persist the initial parent observation before any inference can start.
  return {
    capture,
    events,
    receipts,
    begin(label = `scope-${scope + 1}`) {
      if (scopeOpen && scope > 0)
        throw new Error("Overlapping native capture scope");
      scope += 1;
      caseId = label;
      scopeOpen = true;
      capture.capabilities = [];
      capture.searchResults = [];
      collect();
    },
    finish() {
      scopeOpen = false;
      return collect(true);
    },
    modelState() {
      const live = children.filter(
        ({ child }) => child.exitCode === null && child.signalCode === null
      );
      const states = live.map(({ identity }) => {
        const latest = requests.findLast(
          (item) => item.identity.token === identity.token
        );
        if (!latest) return { identity, loaded: null };
        try {
          const receipt = validateChildReceipt(
            JSON.parse(
              readFileSync(
                join(
                  latest.directory,
                  `${identity.pid}-${latest.request.requestId}.json`
                ),
                "utf8"
              )
            ),
            identity,
            latest.request
          );
          return {
            identity,
            loaded:
              receipt.complete && receipt.lifecycle?.loadedModels !== undefined
                ? receipt.lifecycle.loadedModels > 0
                : null,
            models: receipt.capture.models,
          };
        } catch {
          return { identity, loaded: null };
        }
      });
      return {
        loaded: states.length
          ? states.every((item) => item.loaded === true)
            ? true
            : states.every((item) => item.loaded === false)
              ? false
              : null
          : false,
        children: children.map(({ identity, child }) => ({
          ...identity,
          live: child.exitCode === null && child.signalCode === null,
        })),
        states,
      };
    },
    restore() {
      Bun.spawn = spawn;
      process.dlopen = dlopen;
      Object.defineProperty = defineProperty;
      RetrievalTraceSession.prototype.recordCapability = capability;
      for (const { child } of children)
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGTERM");
      active = false;
    },
  };
}

// Surface processes each run exactly one acceptance case. Evidence is merged on
// every actual child reply, before product shutdown; aborts retain partial files.
const sidecar = process.env.GNO_ACCEPTANCE_CAPTURE;
if (sidecar) {
  const input = (await Bun.file(`${sidecar}.request.json`).json()) as {
    runId: string;
    models: AcceptanceManifest["models"];
    caseId: string;
  };
  const directory = `${sidecar}.children`;
  mkdirSync(directory, { mode: 0o700 });
  const session = await installParentCapture(
    input.runId,
    input.models,
    directory,
    (capture) => {
      writeFileSync(`${sidecar}.partial`, JSON.stringify(capture), {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(`${sidecar}.partial`, sidecar);
    }
  );
  session.begin(input.caseId);
  process.on("exit", () => {
    session.finish();
    session.restore();
  });
}
