
import {acquireLock, AsyncDisposeAggregator, withLock} from "lifecycle-utils";
import bytes from "bytes";
import {DisposeGuard} from "file:///home/gordon/work/gno/node_modules/node-llama-cpp/dist/utils/DisposeGuard.js";
import {LruCache} from "file:///home/gordon/work/gno/node_modules/node-llama-cpp/dist/utils/LruCache.js";
import {removeNullFields,removeUndefinedFields} from "file:///home/gordon/work/gno/node_modules/node-llama-cpp/dist/utils/removeNullFields.js";
import {doesLlamaBackendNeedAddonInitLock,LlamaLocks,LlamaLogLevel} from "file:///home/gordon/work/gno/node_modules/node-llama-cpp/dist/bindings/types.js";
const GgmlType={F16:1};
export class GgufInsightsSimulatorSession {
    _llama;
    _modelPromises;
    _disposed = false;
    constructor(llama, lruCacheSize = 10) {
        this._llama = llama;
        this._modelPromises = new LruCache(lruCacheSize);
    }
    async estimateModelResources({ modelSource, gpuLayers, useMmap = false }) {
        const model = await this._getModel({ source: modelSource, gpuLayers, useMmap });
        const memoryBreakdown = model.getMemoryBreakdown();
        if (this._llama._shouldLog(LlamaLogLevel.debug))
            this._llama._log(LlamaLogLevel.debug, "Simulating model resource usage. " + [
                `gpuLayers=${gpuLayers}`,
                `useMmap=${useMmap}`,
                `memoryBreakdownCpuRam=${bytes(memoryBreakdown.cpuRam)}`,
                `memoryBreakdownGpuVram=${bytes(memoryBreakdown.gpuVram)}`
            ].join(" "));
        return memoryBreakdown;
    }
    async estimateContextResources({ modelSource, gpuLayers, contextSize, batchSize, sequences, isEmbeddingContext = false, flashAttention = "auto", swaFullCache = false, useMmap = false, kvCacheKeyType = GgmlType.F16, kvCacheValueType = GgmlType.F16 }) {
        const model = await this._getModel({ source: modelSource, gpuLayers, useMmap });
        const context = new this._llama._bindings.AddonContext(model, removeUndefinedFields({
            contextSize,
            batchSize,
            sequences,
            embeddings: isEmbeddingContext,
            flashAttention: flashAttention === "auto"
                ? "auto"
                : flashAttention,
            kvCacheKeyType,
            kvCacheValueType,
            swaFullCache
        }));
        try {
            const loadingLock = doesLlamaBackendNeedAddonInitLock(this._llama.gpu)
                ? await acquireLock([this._llama._memoryLock, LlamaLocks.addonInit])
                : undefined;
            const disposeLogLevelOverride = this._llama._createLogLevelOverride(LlamaLogLevel.error);
            try {
                const contextLoaded = await context.init();
                if (!contextLoaded)
                    throw new Error("Failed to create context");
            }
            finally {
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
        }
        finally {
            await context.dispose();
        }
    }
    [Symbol.asyncDispose]() {
        return this.dispose();
    }
    async dispose() {
        if (this._disposed)
            return;
        this._disposed = true;
        const modelPromises = [...this._modelPromises.values()].map((modelPromise) => modelPromise.catch(() => void 0));
        this._modelPromises.clear();
        const loadedModels = (await Promise.all(modelPromises)).filter((model) => model != null);
        await Promise.all(loadedModels.map((model) => model.dispose().catch(() => void 0)));
    }
    get disposed() {
        return this._disposed;
    }
    async _getModel({ source, gpuLayers, useMmap = this._llama.supportsMmap }) {
        if (this._disposed)
            throw new Error("simulator session is disposed");
        const cacheKey = String(gpuLayers) + ":" + String(useMmap);
        const existingModelPromise = this._modelPromises.get(cacheKey);
        if (existingModelPromise != null)
            return await existingModelPromise;
        if (this._llama._shouldLog(LlamaLogLevel.debug))
            this._llama._log(LlamaLogLevel.debug, `Loading model for simulator session. gpuLayers=${gpuLayers} useMmap=${useMmap}`);
        const modelPromise = this._loadModel({
            source,
            gpuLayers,
            useMmap
        });
        this._modelPromises.set(cacheKey, modelPromise);
        try {
            return await modelPromise;
        }
        catch (error) {
            this._modelPromises.delete(cacheKey);
            throw error;
        }
    }
    async _loadModel({ source, gpuLayers, useMmap = false }) {
        const model = new this._llama._bindings.AddonModel(typeof source === "string"
            ? source
            : "", removeNullFields({
            gpuLayers,
            noAlloc: true,
            useMmap,
            useMlock: false
        }));
        const loadingLock = doesLlamaBackendNeedAddonInitLock(this._llama.gpu)
            ? await acquireLock([this._llama._memoryLock, LlamaLocks.addonInit])
            : undefined;
        const disposeLogLevelOverride = this._llama._createLogLevelOverride(LlamaLogLevel.error);
        try {
            const modelLoaded = typeof source === "string"
                ? await model.init()
                : await model.init(source);
            if (!modelLoaded)
                throw new Error("Failed to load model");
        }
        finally {
            disposeLogLevelOverride();
            loadingLock?.dispose();
        }
        return model;
    }
}
