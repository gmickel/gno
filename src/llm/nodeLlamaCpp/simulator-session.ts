/** Guarded simulator section from node-llama-cpp PR636 (MIT, Gilad S.).
 * See simulator-handle.ts and THIRD_PARTY_NOTICES.md for source attribution.
 * Retained on 3.20.0 for failed-load cleanup and joined session disposal,
 * beyond upstream PR636. Estimation inputs and selection remain unchanged.
 */
import type {
  SimulatorBackend,
  SimulatorCache,
  SimulatorContextOptions,
  SimulatorDependencies,
  SimulatorDisposable,
  SimulatorMemory,
  SimulatorModelOptions,
} from "./simulator-types";

import { SimulatorModelHandle } from "./simulator-handle";

function defined(options: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined)
  );
}

export class GuardedSimulatorSession {
  private readonly models: SimulatorCache<Promise<SimulatorModelHandle>>;
  private isDisposed = false;
  private disposal?: Promise<void>;

  constructor(
    private readonly llama: SimulatorBackend,
    private readonly dependencies: SimulatorDependencies,
    lruCacheSize = 10,
    private readonly loadModelError?: Error
  ) {
    this.models = new dependencies.LruCache(lruCacheSize, {
      async onDelete(_key, value) {
        try {
          const handle = await value;
          // Give queued consumers the same acquisition turn as upstream PR636.
          await Promise.resolve();
          await handle.dispose();
        } catch {
          /* Failed loads have no live cached handle. */
        }
      },
    });
  }

  async estimateModelResources({
    modelSource,
    gpuLayers,
    useMmap = false,
  }: SimulatorModelOptions): Promise<SimulatorMemory> {
    const handle = await this.getModel({ modelSource, gpuLayers, useMmap });
    const lease = this.acquire(handle);
    try {
      const result = handle.model.getMemoryBreakdown();
      if (this.llama._shouldLog(this.dependencies.debug))
        this.llama._log(
          this.dependencies.debug,
          `Simulating model resource usage. gpuLayers=${gpuLayers} useMmap=${useMmap} memoryBreakdownCpuRam=${this.dependencies.bytes(result.cpuRam)} memoryBreakdownGpuVram=${this.dependencies.bytes(result.gpuVram)}`
        );
      return result;
    } finally {
      await lease.dispose();
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
    kvCacheKeyType = this.dependencies.f16,
    kvCacheValueType = this.dependencies.f16,
  }: SimulatorContextOptions): Promise<SimulatorMemory> {
    const handle = await this.getModel({ modelSource, gpuLayers, useMmap });
    const lease = this.acquire(handle);
    try {
      const context = new this.llama._bindings.AddonContext(
        handle.model,
        defined({
          contextSize,
          batchSize,
          sequences,
          embeddings: isEmbeddingContext,
          flashAttention,
          kvCacheKeyType,
          kvCacheValueType,
          swaFullCache,
        })
      );
      try {
        const loadingLock = this.dependencies.needInitLock(this.llama.gpu)
          ? await this.dependencies.acquireLock([
              this.llama._memoryLock,
              this.dependencies.addonInit,
            ])
          : undefined;
        const restoreLog = this.llama._createLogLevelOverride(
          this.dependencies.error
        );
        try {
          if (!(await context.init()))
            throw new Error("Failed to create context");
        } finally {
          restoreLog();
          await loadingLock?.dispose();
        }
        const result = context.getMemoryBreakdown();
        if (this.llama._shouldLog(this.dependencies.debug))
          this.llama._log(
            this.dependencies.debug,
            `Simulating context resource usage. gpuLayers=${gpuLayers} contextSize=${contextSize.toLocaleString("en-US", { notation: "compact" })} batchSize=${batchSize} sequences=${sequences} isEmbeddingContext=${isEmbeddingContext} flashAttention=${flashAttention} swaFullCache=${swaFullCache} kvCacheKeyType=${kvCacheKeyType} kvCacheValueType=${kvCacheValueType} useMmap=${useMmap} memoryBreakdownCpuRam=${this.dependencies.bytes(result.cpuRam)} memoryBreakdownGpuVram=${this.dependencies.bytes(result.gpuVram)}`
          );
        return result;
      } finally {
        await context.dispose();
      }
    } finally {
      await lease.dispose();
    }
  }

  get disposed(): boolean {
    return this.isDisposed;
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }

  dispose(): Promise<void> {
    this.disposal ??= this.disposeInternal();
    return this.disposal;
  }

  private async disposeInternal(): Promise<void> {
    this.isDisposed = true;
    const pending = [...this.models.values()];
    this.models.clear();
    const handles = await Promise.all(
      pending.map((value) => value.catch(() => undefined))
    );
    await Promise.all(handles.map((handle) => handle?.dispose()));
  }

  private acquire(handle: SimulatorModelHandle): SimulatorDisposable {
    try {
      return handle.disposeGuard.createPreventDisposalHandle();
    } catch {
      throw new Error("Model is disposed");
    }
  }

  private async getModel({
    modelSource,
    gpuLayers,
    useMmap = this.llama.supportsMmap,
  }: SimulatorModelOptions): Promise<SimulatorModelHandle> {
    if (this.isDisposed) throw new Error("simulator session is disposed");
    if (this.loadModelError) throw this.loadModelError;
    let backendHandle: SimulatorDisposable;
    try {
      backendHandle =
        this.llama._backendDisposeGuard.createPreventDisposalHandle();
    } catch {
      throw new Error("Llama instance is disposed");
    }
    try {
      const key = `${gpuLayers}:${useMmap}`;
      const existing = this.models.get(key);
      if (existing) return await existing;
      if (this.llama._shouldLog(this.dependencies.debug))
        this.llama._log(
          this.dependencies.debug,
          `Loading model for simulator session. gpuLayers=${gpuLayers} useMmap=${useMmap}`
        );
      const pending = this.loadModel({ modelSource, gpuLayers, useMmap });
      this.models.set(key, pending);
      try {
        return await pending;
      } catch (error) {
        this.models.delete(key);
        throw error;
      }
    } finally {
      await backendHandle.dispose();
    }
  }

  private async loadModel({
    modelSource,
    gpuLayers,
    useMmap = false,
  }: SimulatorModelOptions): Promise<SimulatorModelHandle> {
    const model = new this.llama._bindings.AddonModel(
      typeof modelSource === "string" ? modelSource : "",
      {
        gpuLayers,
        noAlloc: true,
        useMmap,
        useMlock: false,
      }
    );
    const loadingLock = this.dependencies.needInitLock(this.llama.gpu)
      ? await this.dependencies.acquireLock([
          this.llama._memoryLock,
          this.dependencies.addonInit,
        ])
      : undefined;
    const restoreLog = this.llama._createLogLevelOverride(
      this.dependencies.error
    );
    try {
      if (
        !(await (typeof modelSource === "string"
          ? model.init()
          : model.init(modelSource)))
      )
        throw new Error("Failed to load model");
    } catch (error) {
      await model.dispose().catch(() => {});
      throw error;
    } finally {
      restoreLog();
      await loadingLock?.dispose();
    }
    try {
      return new SimulatorModelHandle(this.llama, model, this.dependencies);
    } catch (error) {
      await model.dispose().catch(() => {});
      throw error;
    }
  }
}
