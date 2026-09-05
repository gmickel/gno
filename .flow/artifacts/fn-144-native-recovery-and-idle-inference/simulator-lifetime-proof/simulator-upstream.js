export class GgufInsightsSimulatorSession {
  _llama;
  _modelHandlePromises;
  _disposed = !1;
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
    useMmap = !1
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
    isEmbeddingContext = !1,
    flashAttention = "auto",
    swaFullCache = !1,
    useMmap = !1,
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
    this._disposed = !0;
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
    useMmap = !1
  }) {
    const model = new this._llama._bindings.AddonModel(typeof source === "string" ? source : "", removeNullFields({
      gpuLayers,
      noAlloc: !0,
      useMmap,
      useMlock: !1
    })), loadingLock = doesLlamaBackendNeedAddonInitLock(this._llama.gpu) ? await acquireLock([this._llama._memoryLock, LlamaLocks.addonInit]) : void 0, disposeLogLevelOverride = this._llama._createLogLevelOverride(LlamaLogLevel.error);
    try {
      if (!(typeof source === "string" ? await model.init() : await model.init(source)))
        throw Error("Failed to load model");
    } finally {
      disposeLogLevelOverride();
      loadingLock?.dispose();
    }
    return new SimulatorModelHandle(this._llama, model);
  }
}

class SimulatorModelHandle {
  model;
  disposeGuard;
  _llamaPreventDisposalHandle;
  _disposeAggregator = new AsyncDisposeAggregator;
  constructor(llama, model) {
    this.model = model;
    this.disposeGuard = new DisposeGuard([llama._backendDisposeGuard]);
    this._llamaPreventDisposalHandle = llama._backendDisposeGuard.createPreventDisposalHandle();
    this._disposeAggregator.add(registerFinalizer(model, this._llamaPreventDisposalHandle));
    const onLlamaDisposeListener = llama.onDispose.createListener(disposeSimulatorModelHandleIfReferenced.bind(null, new WeakRef(this)));
    this._disposeAggregator.add(onLlamaDisposeListener);
    this._disposeAggregator.add(registerFinalizer(model, onLlamaDisposeListener));
    this._disposeAggregator.add(this._dispose.bind(this));
  }
  async dispose() {
    await this._disposeAggregator.dispose();
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
