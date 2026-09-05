
import {acquireLock, AsyncDisposeAggregator, withLock} from "lifecycle-utils";
import bytes from "bytes";
import {DisposeGuard} from "file:///home/gordon/work/gno/node_modules/node-llama-cpp/dist/utils/DisposeGuard.js";
import {LruCache} from "file:///home/gordon/work/gno/node_modules/node-llama-cpp/dist/utils/LruCache.js";
import {removeNullFields,removeUndefinedFields} from "file:///home/gordon/work/gno/node_modules/node-llama-cpp/dist/utils/removeNullFields.js";
import {doesLlamaBackendNeedAddonInitLock,LlamaLocks,LlamaLogLevel} from "file:///home/gordon/work/gno/node_modules/node-llama-cpp/dist/bindings/types.js";
const GgmlType={F16:1};
export class GgufInsightsSimulatorSession {
  _llama;
  _modelHandlePromises;
  _disposed = false;
  constructor(llama, lruCacheSize = 10) {
    this._llama = llama;
    this._modelHandlePromises = new LruCache(lruCacheSize, {
      async onDelete(key, value) {
        try {
          const modelHandle = await value;
          await Promise.resolve();
          await modelHandle.dispose();
        } catch (err) {}
      }
    });
  }
  async estimateModelResources({
    modelSource,
    gpuLayers,
    useMmap = false
  }) {
    const modelHandle = await this._getModelHandle({ source: modelSource, gpuLayers, useMmap });
    let preventDisposalHandle;
    try {
      preventDisposalHandle = modelHandle.disposeGuard.createPreventDisposalHandle();
    } catch (err) {
      throw Error("Model is disposed");
    }
    try {
      const memoryBreakdown = modelHandle.model.getMemoryBreakdown();
      if (this._llama._shouldLog(LlamaLogLevel.debug))
        this._llama._log(LlamaLogLevel.debug, "Simulating model resource usage. " + [
          `gpuLayers=${gpuLayers}`,
          `useMmap=${useMmap}`,
          `memoryBreakdownCpuRam=${bytes(memoryBreakdown.cpuRam)}`,
          `memoryBreakdownGpuVram=${bytes(memoryBreakdown.gpuVram)}`
        ].join(" "));
      return memoryBreakdown;
    } finally {
      preventDisposalHandle.dispose();
    }
  }
  async estimateContextResources({
    modelSource,
    gpuLayers,
    contextSize,
    batchSize,
    sequences,
    isEmbeddingContext = false,
    flashAttention = "auto",
    swaFullCache = false,
    useMmap = false,
    kvCacheKeyType = GgmlType.F16,
    kvCacheValueType = GgmlType.F16
  }) {
    const modelHandle = await this._getModelHandle({ source: modelSource, gpuLayers, useMmap });
    let preventDisposalHandle;
    try {
      preventDisposalHandle = modelHandle.disposeGuard.createPreventDisposalHandle();
    } catch (err) {
      throw Error("Model is disposed");
    }
    try {
      const context = new this._llama._bindings.AddonContext(modelHandle.model, removeUndefinedFields({
        contextSize,
        batchSize,
        sequences,
        embeddings: isEmbeddingContext,
        flashAttention: flashAttention === "auto" ? "auto" : flashAttention,
        kvCacheKeyType,
        kvCacheValueType,
        swaFullCache
      }));
      try {
        const loadingLock = doesLlamaBackendNeedAddonInitLock(this._llama.gpu) ? await acquireLock([this._llama._memoryLock, LlamaLocks.addonInit]) : void 0, disposeLogLevelOverride = this._llama._createLogLevelOverride(LlamaLogLevel.error);
        try {
          if (!await context.init())
            throw Error("Failed to create context");
        } finally {
          disposeLogLevelOverride();
          loadingLock?.dispose();
        }
        const memoryBreakdown = context.getMemoryBreakdown();
        if (this._llama._shouldLog(LlamaLogLevel.debug))
          this._llama._log(LlamaLogLevel.debug, "Simulating context resource usage. " + [
            `gpuLayers=${gpuLayers}`,
            `contextSize=${contextSize.toLocaleString("en-US", { notation: "compact" })}`,
            `batchSize=${batchSize}`,
            `sequences=${sequences}`,
            `isEmbeddingContext=${isEmbeddingContext}`,
            `flashAttention=${flashAttention}`,
            `swaFullCache=${swaFullCache}`,
            `kvCacheKeyType=${kvCacheKeyType}`,
            `kvCacheValueType=${kvCacheValueType}`,
            `useMmap=${useMmap}`,
            `memoryBreakdownCpuRam=${bytes(memoryBreakdown.cpuRam)}`,
            `memoryBreakdownGpuVram=${bytes(memoryBreakdown.gpuVram)}`
          ].join(" "));
        return memoryBreakdown;
      } finally {
        await context.dispose();
      }
    } finally {
      preventDisposalHandle.dispose();
    }
  }
  [Symbol.asyncDispose]() {
    return this.dispose();
  }
  async dispose() {
    if (this._disposed)
      return;
    this._disposed = true;
    const modelHandlePromises = [...this._modelHandlePromises.values()].map((modelHandlePromise) => modelHandlePromise.catch(() => {
      return;
    }));
    this._modelHandlePromises.clear();
    const loadedModelHandles = (await Promise.all(modelHandlePromises)).filter((model) => model != null);
    await Promise.all(loadedModelHandles.map((modelHandle) => modelHandle.dispose()));
  }
  get disposed() {
    return this._disposed;
  }
  async _getModelHandle({
    source,
    gpuLayers,
    useMmap = this._llama.supportsMmap
  }) {
    if (this._disposed)
      throw Error("simulator session is disposed");
    let preventDisposalHandle;
    try {
      preventDisposalHandle = this._llama._backendDisposeGuard.createPreventDisposalHandle();
    } catch (err) {
      throw Error("Llama instance is disposed");
    }
    try {
      const cacheKey = String(gpuLayers) + ":" + String(useMmap), existingModelPromise = this._modelHandlePromises.get(cacheKey);
      if (existingModelPromise != null)
        return await existingModelPromise;
      if (this._llama._shouldLog(LlamaLogLevel.debug))
        this._llama._log(LlamaLogLevel.debug, `Loading model for simulator session. gpuLayers=${gpuLayers} useMmap=${useMmap}`);
      const modelHandlePromise = this._loadModel({
        source,
        gpuLayers,
        useMmap
      });
      this._modelHandlePromises.set(cacheKey, modelHandlePromise);
      try {
        return await modelHandlePromise;
      } catch (error) {
        this._modelHandlePromises.delete(cacheKey);
        throw error;
      }
    } finally {
      preventDisposalHandle.dispose();
    }
  }
  async _loadModel({
    source,
    gpuLayers,
    useMmap = false
  }) {
    const model = new this._llama._bindings.AddonModel(typeof source === "string" ? source : "", removeNullFields({
      gpuLayers,
      noAlloc: true,
      useMmap,
      useMlock: false
    })), loadingLock = doesLlamaBackendNeedAddonInitLock(this._llama.gpu) ? await acquireLock([this._llama._memoryLock, LlamaLocks.addonInit]) : void 0, disposeLogLevelOverride = this._llama._createLogLevelOverride(LlamaLogLevel.error);
    try {
      if (!(typeof source === "string" ? await model.init() : await model.init(source)))
        throw Error("Failed to load model");
    } catch (error) {
      await model.dispose().catch(() => {});
      throw error;
    } finally {
      disposeLogLevelOverride();
      loadingLock?.dispose();
    }
    try {
      return new SimulatorModelHandle(this._llama, model);
    } catch (error) {
      await model.dispose().catch(() => {});
      throw error;
    }
  }
}

class SimulatorModelHandle {
  model;
  disposeGuard;
  _llamaPreventDisposalHandle;
  _disposeAggregator = new AsyncDisposeAggregator;
  _disposal;
  constructor(llama, model) {
    this.model = model;
    this.disposeGuard = new DisposeGuard([llama._backendDisposeGuard]);
    this._llamaPreventDisposalHandle = llama._backendDisposeGuard.createPreventDisposalHandle();
    this._disposeAggregator.add(registerSimulatorFinalizer(model, this._llamaPreventDisposalHandle));
    const onLlamaDisposeListener = llama.onDispose.createListener(disposeSimulatorModelHandleIfReferenced.bind(null, new WeakRef(this)));
    this._disposeAggregator.add(onLlamaDisposeListener);
    this._disposeAggregator.add(registerSimulatorFinalizer(model, onLlamaDisposeListener));
    this._disposeAggregator.add(this._dispose.bind(this));
  }
  dispose() {
    return this._disposal ??= this._disposeAggregator.dispose();
  }
  async _dispose() {
    await this.disposeGuard.acquireDisposeLock();
    await this.model.dispose().catch(() => {
      return;
    });
    await this._llamaPreventDisposalHandle.dispose();
  }
}
function disposeSimulatorModelHandleIfReferenced(modelHandleRef) {
  return modelHandleRef.deref()?.dispose().catch(() => {
    return;
  });
}

// Compatibility backport: lifecycle-utils 3.1.1 has no registerFinalizer export.
// Native FinalizationRegistry preserves upstream weak ownership without a dep bump.
const simulatorFinalizers = new FinalizationRegistry((target) => {
  try { Promise.resolve(target.dispose()).catch(() => {}); } catch {}
});
function registerSimulatorFinalizer(target, disposable) {
  const token = {};
  simulatorFinalizers.register(target, disposable, token);
  return () => simulatorFinalizers.unregister(token);
}

