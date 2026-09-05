import type { LlamaInitOptions } from "./lifecycle-options";

import {
  resolveLlamaGpuMode,
  resolveLlamaBuildMode,
  resolveLlamaBackendInitTimeoutMs,
  shouldRetryLlamaWithCpu,
} from "./lifecycle-options";
export {
  resolveLlamaGpuMode,
  resolveLlamaBuildMode,
  resolveLlamaBackendInitTimeoutMs,
  shouldRetryLlamaWithCpu,
} from "./lifecycle-options";
export type { LlamaGpuMode, LlamaBuildMode } from "./lifecycle-options";

import type { ModelConfig } from "../../config/types";
import type { LlmResult, LoadedModel, ModelType } from "../types";

import { loadFailedError, outOfMemoryError, timeoutError } from "../errors";
import { installSimulatorLifetimeGuard } from "./simulator-install";

// Types

type Llama = Awaited<ReturnType<typeof import("node-llama-cpp").getLlama>>;
type LlamaModel = Awaited<ReturnType<Llama["loadModel"]>>;
interface CachedModel {
  uri: string;
  type: ModelType;
  model: LlamaModel;
  loadedAt: number;
}

export interface ModelLease {
  release(): void;
}

export interface ModelLifecycleStats {
  activeLeases: number;
  leaseAcquisitions: number;
  leaseReleases: number;
  loadedModels: number;
  loadAttempts: number;
  loadSuccesses: number;
  loadFailures: number;
  inflightLoads: number;
}

let gpuFallbackWarned = false;
let backendTimeoutWarned = false;

export class ModelManager {
  private llama: Llama | null = null;
  private llamaInit: Promise<Llama> | null = null;
  private closing: Promise<void> | null = null;
  private readonly lateCleanup = new Set<Promise<void>>();
  private readonly models: Map<string, CachedModel> = new Map();
  private readonly disposalTimers: Map<string, ReturnType<typeof setTimeout>> =
    new Map();
  private readonly inflightLoads: Map<string, Promise<LlmResult<LoadedModel>>> =
    new Map();
  private readonly leaseDrainWaiters = new Set<() => void>();
  private readonly config: ModelConfig;
  private activeLeases = 0;
  private broadLeases = 0;
  private readonly modelLeases = new Map<string, number>();
  private readonly expiresAt = new Map<string, number>();
  private readonly retiringModels = new Map<string, Promise<void>>();
  private leaseAcquisitions = 0;
  private leaseReleases = 0;
  private loadAttempts = 0;
  private loadSuccesses = 0;
  private loadFailures = 0;

  constructor(
    config: ModelConfig,
    private readonly awaitNativeLoadSettlement = false
  ) {
    this.config = config;
  }

  async getLlama(): Promise<Llama> {
    if (this.closing) throw new Error("Model manager is disposing");
    if (this.llama) return this.llama;
    this.llamaInit ??= this.initializeLlama().finally(() => {
      this.llamaInit = null;
    });
    return this.llamaInit;
  }

  private async initializeLlama(): Promise<Llama> {
    // A timed-out native constructor still owns work until its loser is cleaned.
    await Promise.allSettled(this.lateCleanup);
    if (this.closing) throw new Error("Model manager is disposing");
    if (!this.llama) {
      await installSimulatorLifetimeGuard();
      const { getLlama, LlamaLogLevel } = await import("node-llama-cpp");
      const gpu = resolveLlamaGpuMode();
      const build = resolveLlamaBuildMode();
      const timeoutMs = resolveLlamaBackendInitTimeoutMs();
      // Suppress model loading warnings (vocab tokens, pooling type)
      try {
        this.llama = await this.getLlamaWithTimeout(
          getLlama,
          {
            build,
            gpu,
            logLevel: LlamaLogLevel.error,
          },
          timeoutMs
        );
      } catch (error) {
        if (
          this.closing ||
          (error instanceof Error && error.name === "TimeoutError") ||
          !shouldRetryLlamaWithCpu(gpu)
        ) {
          throw error;
        }
        if (!gpuFallbackWarned) {
          gpuFallbackWarned = true;
          console.warn(
            `[llama] GPU backend "${gpu}" failed, retrying with CPU: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
        this.llama = await this.getLlamaWithTimeout(
          getLlama,
          {
            build,
            gpu: false,
            logLevel: LlamaLogLevel.error,
          },
          timeoutMs
        );
      }
    }
    if (this.closing) {
      const llama = this.llama;
      this.llama = null;
      await llama.dispose();
      throw new Error("Model manager disposed during initialization");
    }
    return this.llama;
  }

  private async getLlamaWithTimeout(
    getLlama: (options: LlamaInitOptions) => Promise<Llama>,
    options: LlamaInitOptions,
    timeoutMs: number
  ): Promise<Llama> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let expired = false;
    const initializationDeadline = performance.now() + timeoutMs;
    const initialization = getLlama(options).then(async (llama) => {
      if (expired || performance.now() >= initializationDeadline) {
        await llama.dispose();
        throw new DOMException(
          "Backend initialization expired",
          "TimeoutError"
        );
      }
      return llama;
    });
    const cleanup = initialization.then(
      () => {},
      () => {}
    );
    this.lateCleanup.add(cleanup);
    void cleanup.finally(() => this.lateCleanup.delete(cleanup));
    try {
      const deadline = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          expired = true;
          if (!backendTimeoutWarned) {
            backendTimeoutWarned = true;
            console.warn(
              `[llama] Backend initialization timed out after ${timeoutMs}ms`
            );
          }
          const error = new Error(`Backend init timeout after ${timeoutMs}ms`);
          error.name = "TimeoutError";
          reject(error);
        }, timeoutMs);
      });
      // Native child completion must wait for actual backend settlement even
      // after the init budget expires. Expiry still rejects and forbids fallback.
      if (this.awaitNativeLoadSettlement) {
        void deadline.catch(() => {});
        return await initialization;
      }
      return await Promise.race([initialization, deadline]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  loadModel(
    modelPath: string,
    uri: string,
    type: ModelType,
    signal?: AbortSignal
  ): Promise<LlmResult<LoadedModel>> {
    const retiring = this.retiringModels.get(uri);
    if (retiring)
      return retiring.then(() => this.loadModel(modelPath, uri, type, signal));
    if (this.closing)
      return Promise.resolve({
        ok: false,
        error: loadFailedError(uri, new Error("Model manager is disposing")),
      });
    // Check cache first
    const cached = this.models.get(uri);
    if (cached) {
      return Promise.resolve({
        ok: true as const,
        value: {
          uri: cached.uri,
          type: cached.type,
          model: cached.model,
          loadedAt: cached.loadedAt,
        },
      });
    }

    // Check for inflight load (deduplicate concurrent requests)
    const inflight = this.inflightLoads.get(uri);
    if (inflight) {
      return inflight;
    }

    // Start new load with cleanup
    const loadPromise = this.loadModelInternal(
      modelPath,
      uri,
      type,
      signal
    ).finally(() => {
      this.inflightLoads.delete(uri);
    });
    this.inflightLoads.set(uri, loadPromise);
    return loadPromise;
  }

  private async loadModelInternal(
    modelPath: string,
    uri: string,
    type: ModelType,
    signal?: AbortSignal
  ): Promise<LlmResult<LoadedModel>> {
    this.loadAttempts += 1;
    const timeoutMs = this.config.loadTimeout;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    const controller = new AbortController();
    const loadSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;

    // Capture loadPromise outside try block so we can dispose it on timeout
    let loadPromise: Promise<LlamaModel> | null = null;

    try {
      const llama = await this.getLlama();
      loadSignal.throwIfAborted();
      const loadDeadline = performance.now() + timeoutMs;
      loadPromise = llama.loadModel({ modelPath, loadSignal });

      // Create timeout with proper cleanup
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          controller.abort(
            new DOMException("Model load timed out", "TimeoutError")
          );
          reject(new Error(`Load timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      // The isolated child cannot report completion while a noncooperative
      // loader still owns native allocations. Parent cancellation delivers early.
      if (this.awaitNativeLoadSettlement) void timeoutPromise.catch(() => {});
      const model = this.awaitNativeLoadSettlement
        ? await loadPromise
        : await Promise.race([loadPromise, timeoutPromise]);
      if (this.awaitNativeLoadSettlement && performance.now() >= loadDeadline)
        timedOut = true;
      if (this.awaitNativeLoadSettlement && (timedOut || loadSignal.aborted)) {
        await model.dispose();
        if (timedOut) throw new Error("Model load timeout");
        loadSignal.throwIfAborted();
      }

      // Clear timeout on success
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      if (this.closing) {
        await model.dispose();
        throw new Error("Model manager disposed during model loading");
      }
      const now = Date.now();
      const cachedModel: CachedModel = {
        uri,
        type,
        model,
        loadedAt: now,
      };

      this.models.set(uri, cachedModel);
      this.expiresAt.set(uri, Date.now() + this.config.warmModelTtl);
      this.setDisposalTimer(uri);
      this.loadSuccesses += 1;

      return {
        ok: true,
        value: {
          uri,
          type,
          model,
          loadedAt: now,
        },
      };
    } catch (e) {
      this.loadFailures += 1;
      // Clear timeout on error
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      // Dispose late-arriving model after timeout to prevent memory leak
      if (timedOut && loadPromise && !this.awaitNativeLoadSettlement) {
        const cleanup = loadPromise.then(
          (model) => {
            // Dispose model that arrived after timeout
            return model.dispose().catch(() => {
              // Ignore dispose errors
            });
          },
          () => {
            // Ignore load errors after timeout
          }
        );
        this.lateCleanup.add(cleanup);
        void cleanup.finally(() => this.lateCleanup.delete(cleanup));
      }

      if (e instanceof Error) {
        if (
          timedOut ||
          e.name === "TimeoutError" ||
          e.message.includes("timeout")
        ) {
          return {
            ok: false,
            error: timeoutError(uri, "load", this.config.loadTimeout),
          };
        }
        if (e.message.includes("out of memory") || e.message.includes("OOM")) {
          return { ok: false, error: outOfMemoryError(uri, e) };
        }
      }
      return { ok: false, error: loadFailedError(uri, e) };
    }
  }

  getLoadedModel(uri: string): CachedModel | undefined {
    if (this.closing) return;
    return this.models.get(uri);
  }

  acquireLease(uri?: string, activity = true): ModelLease {
    if (this.closing) throw new Error("Model manager is disposing");
    this.activeLeases += 1;
    this.leaseAcquisitions += 1;
    if (uri === undefined) this.broadLeases += 1;
    else this.modelLeases.set(uri, (this.modelLeases.get(uri) ?? 0) + 1);
    for (const [key, timer] of this.disposalTimers) {
      if (uri === undefined || key === uri) {
        clearTimeout(timer);
        this.disposalTimers.delete(key);
      }
    }

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.activeLeases = Math.max(0, this.activeLeases - 1);
        this.leaseReleases += 1;
        if (uri === undefined) this.broadLeases -= 1;
        else {
          const count = (this.modelLeases.get(uri) ?? 1) - 1;
          if (count) this.modelLeases.set(uri, count);
          else this.modelLeases.delete(uri);
        }
        for (const key of this.models.keys()) {
          if (uri === undefined || key === uri) {
            if (activity)
              this.expiresAt.set(key, Date.now() + this.config.warmModelTtl);
            this.resetDisposalTimer(key);
          }
        }
        if (this.activeLeases === 0) {
          for (const resolve of this.leaseDrainWaiters) resolve();
          this.leaseDrainWaiters.clear();
        }
      },
    };
  }

  getLifecycleStats(): ModelLifecycleStats {
    return {
      activeLeases: this.activeLeases,
      leaseAcquisitions: this.leaseAcquisitions,
      leaseReleases: this.leaseReleases,
      loadedModels: this.models.size,
      loadAttempts: this.loadAttempts,
      loadSuccesses: this.loadSuccesses,
      loadFailures: this.loadFailures,
      inflightLoads: this.inflightLoads.size,
    };
  }

  isLoaded(uri: string): boolean {
    return this.models.has(uri);
  }

  async dispose(uri: string): Promise<void> {
    if (this.broadLeases > 0 || this.modelLeases.has(uri)) return;
    const retiring = this.retiringModels.get(uri);
    if (retiring) return retiring;
    const cached = this.models.get(uri);
    if (!cached) {
      return;
    }

    // Clear disposal timer
    const timer = this.disposalTimers.get(uri);
    if (timer) {
      clearTimeout(timer);
      this.disposalTimers.delete(uri);
    }

    // Remove ownership before yielding so acquisitions cannot see a retiring model.
    this.models.delete(uri);
    this.expiresAt.delete(uri);
    const cleanup = cached.model
      .dispose()
      .catch(() => {})
      .finally(() => {
        this.retiringModels.delete(uri);
      });
    this.retiringModels.set(uri, cleanup);
    this.lateCleanup.add(cleanup);
    await cleanup;
    this.lateCleanup.delete(cleanup);
  }

  disposeAll(): Promise<void> {
    this.closing ??= this.disposeAllInternal().finally(() => {
      this.closing = null;
    });
    return this.closing;
  }

  private async disposeAllInternal(): Promise<void> {
    if (this.activeLeases > 0) {
      await new Promise<void>((resolve) => this.leaseDrainWaiters.add(resolve));
    }
    await Promise.allSettled(this.inflightLoads.values());

    // Clear all timers
    for (const timer of this.disposalTimers.values()) {
      clearTimeout(timer);
    }
    this.disposalTimers.clear();

    // Dispose all models
    for (const [uri, cached] of this.models) {
      try {
        await cached.model.dispose();
      } catch {
        // Ignore disposal errors
      }
      this.models.delete(uri);
    }

    await this.llamaInit?.catch(() => {});
    await Promise.allSettled(this.lateCleanup);
    const llama = this.llama;
    this.llama = null;
    await llama?.dispose();
  }

  getLoadedModels(): Array<{ uri: string; type: ModelType; loadedAt: number }> {
    return Array.from(this.models.values()).map((m) => ({
      uri: m.uri,
      type: m.type,
      loadedAt: m.loadedAt,
    }));
  }

  // Private

  private setDisposalTimer(uri: string): void {
    if (this.broadLeases > 0 || this.modelLeases.has(uri)) return;
    const timer = setTimeout(
      () => {
        this.dispose(uri).catch(() => {
          // Ignore disposal errors in timer callback
        });
      },
      Math.max(0, (this.expiresAt.get(uri) ?? Date.now()) - Date.now())
    );

    // Allow CLI processes to exit without waiting for TTL timer
    if (typeof timer.unref === "function") {
      timer.unref();
    }

    this.disposalTimers.set(uri, timer);
  }

  private resetDisposalTimer(uri: string): void {
    const existing = this.disposalTimers.get(uri);
    if (existing) {
      clearTimeout(existing);
    }
    this.setDisposalTimer(uri);
  }
}

// Singleton

let defaultManager: ModelManager | null = null;

export function getModelManager(config: ModelConfig): ModelManager {
  if (!defaultManager) {
    defaultManager = new ModelManager(config);
  }
  return defaultManager;
}

export async function resetModelManager(): Promise<void> {
  if (defaultManager) {
    await defaultManager.disposeAll();
    defaultManager = null;
  }
}
