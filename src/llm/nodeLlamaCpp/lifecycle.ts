/**
 * Model lifecycle manager.
 * Handles lazy loading, caching, and disposal of LLM models.
 *
 * @module src/llm/nodeLlamaCpp/lifecycle
 */

import type { LlamaOptions } from "node-llama-cpp";

import { platform } from "node:os";

import type { ModelConfig } from "../../config/types";
import type { LlmResult, LoadedModel, ModelType } from "../types";

import { loadFailedError, outOfMemoryError, timeoutError } from "../errors";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Llama = Awaited<ReturnType<typeof import("node-llama-cpp").getLlama>>;
type LlamaModel = Awaited<ReturnType<Llama["loadModel"]>>;
export type LlamaGpuMode = "auto" | "metal" | "vulkan" | "cuda" | false;
export type LlamaBuildMode = "never" | "autoAttempt";

type LlamaInitOptions = LlamaOptions & {
  build: LlamaBuildMode;
  gpu: LlamaGpuMode;
};

interface CachedModel {
  uri: string;
  type: ModelType;
  model: LlamaModel;
  loadedAt: number;
}

let invalidGpuModeWarned = false;
let invalidBuildModeWarned = false;
let gpuFallbackWarned = false;
let backendTimeoutWarned = false;

const DEFAULT_BACKEND_INIT_TIMEOUT_MS = 30_000;

export function resolveLlamaGpuMode(
  env: NodeJS.ProcessEnv = process.env
): LlamaGpuMode {
  const raw = (env.GNO_LLAMA_GPU ?? env.NODE_LLAMA_CPP_GPU ?? "auto")
    .trim()
    .toLowerCase();
  if (!raw || raw === "auto") {
    return "auto";
  }
  if (raw === "metal" || raw === "vulkan" || raw === "cuda") {
    return raw;
  }
  if (
    raw === "false" ||
    raw === "off" ||
    raw === "none" ||
    raw === "disable" ||
    raw === "disabled" ||
    raw === "0"
  ) {
    return false;
  }
  if (!invalidGpuModeWarned) {
    invalidGpuModeWarned = true;
    console.warn(
      `[llama] Invalid GNO_LLAMA_GPU/NODE_LLAMA_CPP_GPU value "${raw}", using auto`
    );
  }
  return "auto";
}

export function resolveLlamaBuildMode(
  env: NodeJS.ProcessEnv = process.env
): LlamaBuildMode {
  const raw = (env.GNO_LLAMA_BUILD ?? "never").trim().toLowerCase();
  if (
    !raw ||
    raw === "never" ||
    raw === "prebuilt" ||
    raw === "prebuilt-only"
  ) {
    return "never";
  }
  if (
    raw === "autoattempt" ||
    raw === "auto-attempt" ||
    raw === "source" ||
    raw === "build"
  ) {
    return "autoAttempt";
  }
  if (!invalidBuildModeWarned) {
    invalidBuildModeWarned = true;
    console.warn(`[llama] Invalid GNO_LLAMA_BUILD value "${raw}", using never`);
  }
  return "never";
}

export function resolveLlamaBackendInitTimeoutMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.GNO_LLAMA_INIT_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_BACKEND_INIT_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_BACKEND_INIT_TIMEOUT_MS;
}

export function shouldRetryLlamaWithCpu(
  gpu: LlamaGpuMode,
  platformName = platform()
): boolean {
  if (gpu === false) {
    return false;
  }
  return gpu !== "auto" || platformName === "win32";
}

// ─────────────────────────────────────────────────────────────────────────────
// ModelManager
// ─────────────────────────────────────────────────────────────────────────────

export class ModelManager {
  private llama: Llama | null = null;
  private readonly models: Map<string, CachedModel> = new Map();
  private readonly disposalTimers: Map<string, ReturnType<typeof setTimeout>> =
    new Map();
  private readonly inflightLoads: Map<string, Promise<LlmResult<LoadedModel>>> =
    new Map();
  private readonly config: ModelConfig;

  constructor(config: ModelConfig) {
    this.config = config;
  }

  /**
   * Get or initialize the Llama instance.
   * Uses lazy loading - only imports node-llama-cpp on first use.
   */
  async getLlama(): Promise<Llama> {
    if (!this.llama) {
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
        if (!shouldRetryLlamaWithCpu(gpu)) {
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
    return this.llama;
  }

  private async getLlamaWithTimeout(
    getLlama: (options: LlamaInitOptions) => Promise<Llama>,
    options: LlamaInitOptions,
    timeoutMs: number
  ): Promise<Llama> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        getLlama(options),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            if (!backendTimeoutWarned) {
              backendTimeoutWarned = true;
              console.warn(
                `[llama] Backend initialization timed out after ${timeoutMs}ms`
              );
            }
            reject(new Error(`Backend init timeout after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Load a model by path.
   * Uses caching, inflight deduplication, and TTL-based disposal.
   */
  loadModel(
    modelPath: string,
    uri: string,
    type: ModelType
  ): Promise<LlmResult<LoadedModel>> {
    // Check cache first
    const cached = this.models.get(uri);
    if (cached) {
      this.resetDisposalTimer(uri);
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
    const loadPromise = this.loadModelInternal(modelPath, uri, type).finally(
      () => {
        this.inflightLoads.delete(uri);
      }
    );
    this.inflightLoads.set(uri, loadPromise);
    return loadPromise;
  }

  /**
   * Internal model loading with timeout handling.
   */
  private async loadModelInternal(
    modelPath: string,
    uri: string,
    type: ModelType
  ): Promise<LlmResult<LoadedModel>> {
    const timeoutMs = this.config.loadTimeout;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;

    // Capture loadPromise outside try block so we can dispose it on timeout
    let loadPromise: Promise<LlamaModel> | null = null;

    try {
      const llama = await this.getLlama();
      loadPromise = llama.loadModel({ modelPath });

      // Create timeout with proper cleanup
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          reject(new Error(`Load timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      const model = await Promise.race([loadPromise, timeoutPromise]);

      // Clear timeout on success
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      const now = Date.now();
      const cachedModel: CachedModel = {
        uri,
        type,
        model,
        loadedAt: now,
      };

      this.models.set(uri, cachedModel);
      this.setDisposalTimer(uri);

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
      // Clear timeout on error
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      // Dispose late-arriving model after timeout to prevent memory leak
      if (timedOut && loadPromise) {
        loadPromise.then(
          (model) => {
            // Dispose model that arrived after timeout
            model.dispose().catch(() => {
              // Ignore dispose errors
            });
          },
          () => {
            // Ignore load errors after timeout
          }
        );
      }

      if (e instanceof Error) {
        if (e.message.includes("timeout")) {
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

  /**
   * Get a loaded model by URI (no loading).
   */
  getLoadedModel(uri: string): CachedModel | undefined {
    const model = this.models.get(uri);
    if (model) {
      this.resetDisposalTimer(uri);
    }
    return model;
  }

  /**
   * Check if a model is loaded.
   */
  isLoaded(uri: string): boolean {
    return this.models.has(uri);
  }

  /**
   * Dispose a specific model.
   */
  async dispose(uri: string): Promise<void> {
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

    // Dispose the model
    try {
      await cached.model.dispose();
    } catch {
      // Ignore disposal errors
    }

    this.models.delete(uri);
  }

  /**
   * Dispose all loaded models.
   */
  async disposeAll(): Promise<void> {
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

    // Clear llama instance
    this.llama = null;
  }

  /**
   * Get list of loaded models.
   */
  getLoadedModels(): Array<{ uri: string; type: ModelType; loadedAt: number }> {
    return Array.from(this.models.values()).map((m) => ({
      uri: m.uri,
      type: m.type,
      loadedAt: m.loadedAt,
    }));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Private
  // ───────────────────────────────────────────────────────────────────────────

  private setDisposalTimer(uri: string): void {
    const timer = setTimeout(() => {
      this.dispose(uri).catch(() => {
        // Ignore disposal errors in timer callback
      });
    }, this.config.warmModelTtl);

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

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

let defaultManager: ModelManager | null = null;

/**
 * Get the default ModelManager singleton.
 */
export function getModelManager(config: ModelConfig): ModelManager {
  if (!defaultManager) {
    defaultManager = new ModelManager(config);
  }
  return defaultManager;
}

/**
 * Reset the default manager (for testing).
 */
export async function resetModelManager(): Promise<void> {
  if (defaultManager) {
    await defaultManager.disposeAll();
    defaultManager = null;
  }
}
