/** Install the pinned simulator guard in memory, including npm/nested installs. */
import type {
  SimulatorBackend,
  SimulatorDependencies,
} from "./simulator-types";

import { GuardedSimulatorSession } from "./simulator-session";

const SOURCE_SHA256 =
  "8bd7b140540eda598d18313eeb17d72d737c39280252449b2b9a5a43db8927b2";
const INSTALLATION = Symbol.for("gno.node-llama-cpp.simulator-lifetime.v1");
const FACTORY_SHAPE =
  /new\s+GgufInsightsSimulatorSession\s*\(\s*this\._llama\s*,\s*lruCacheSize\s*\)/;
let installation: Promise<void> | undefined;

function unsupported(): Error {
  return new Error(
    "Unsupported node-llama-cpp simulator source: expected unmodified 3.20.0 for the native lifetime guard"
  );
}

/** Resolve against the actual dependency export, never a repository node_modules path. */
export async function verifySimulatorPackage(
  entry = import.meta.resolve("node-llama-cpp")
): Promise<string> {
  const index = new URL(entry);
  if (index.protocol !== "file:") throw unsupported();
  const metadata: unknown = await Bun.file(
    new URL("../package.json", index)
  ).json();
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("name" in metadata) ||
    !("version" in metadata) ||
    metadata.name !== "node-llama-cpp" ||
    metadata.version !== "3.20.0"
  )
    throw unsupported();
  const source = await Bun.file(
    new URL("./gguf/insights/GgufInsights.js", index)
  ).arrayBuffer();
  if (
    new Bun.CryptoHasher("sha256").update(source).digest("hex") !==
    SOURCE_SHA256
  )
    throw unsupported();
  return index.href;
}

/** Internal, native-free helper loading remains anchored to this package copy. */
export async function loadSimulatorDependencies(
  entry: string
): Promise<SimulatorDependencies> {
  const [guards, cache, locks, binding, tensors, byteModule] =
    await Promise.all([
      import(new URL("./utils/DisposeGuard.js", entry).href),
      import(new URL("./utils/LruCache.js", entry).href),
      import(import.meta.resolve("lifecycle-utils", entry)),
      import(new URL("./bindings/types.js", entry).href),
      import(new URL("./gguf/types/GgufTensorInfoTypes.js", entry).href),
      import(import.meta.resolve("bytes", entry)),
    ]);
  return {
    DisposeGuard: guards.DisposeGuard,
    LruCache: cache.LruCache,
    acquireLock: locks.acquireLock,
    needInitLock: binding.doesLlamaBackendNeedAddonInitLock,
    addonInit: binding.LlamaLocks.addonInit,
    debug: binding.LlamaLogLevel.debug,
    error: binding.LlamaLogLevel.error,
    f16: tensors.GgmlType.F16,
    bytes: byteModule.default,
  };
}

async function install(): Promise<void> {
  const entry = await verifySimulatorPackage();
  const module = await import(entry);
  const prototype: Record<PropertyKey, unknown> | undefined =
    module.GgufInsights?.prototype;
  if (!prototype) throw unsupported();
  if (prototype[INSTALLATION] !== undefined) {
    if (prototype[INSTALLATION] !== prototype._createSimulatorSession)
      throw unsupported();
    return;
  }
  if (
    typeof prototype._createSimulatorSession !== "function" ||
    !FACTORY_SHAPE.test(prototype._createSimulatorSession.toString())
  )
    throw unsupported();
  const dependencies = await loadSimulatorDependencies(entry);
  const factory = function (
    this: {
      _llama: SimulatorBackend;
      ggufFileInfo?: { metadata: { general: { architecture?: string } } };
    },
    lruCacheSize = 10
  ) {
    return new GuardedSimulatorSession(
      this._llama,
      dependencies,
      lruCacheSize,
      this.ggufFileInfo?.metadata.general.architecture === "clip"
        ? new Error("Cannot simulate CLIP architecture models")
        : undefined
    );
  };
  Object.defineProperty(prototype, "_createSimulatorSession", {
    configurable: true,
    writable: true,
    value: factory,
  });
  Object.defineProperty(prototype, INSTALLATION, { value: factory });
}

export function installSimulatorLifetimeGuard(): Promise<void> {
  installation ??= install().catch((error: unknown) => {
    installation = undefined;
    throw error;
  });
  return installation;
}
