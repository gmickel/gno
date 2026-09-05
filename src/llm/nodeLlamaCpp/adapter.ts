/**
 * Main LLM adapter for node-llama-cpp.
 * Factory for creating port instances.
 *
 * @module src/llm/nodeLlamaCpp/adapter
 */

// Bun has no canonical-path API. Approval binds the real file identity.
import { realpath } from "node:fs/promises";

import type { Config } from "../../config/types";
import type { DownloadPolicy } from "../policy";
import type {
  EmbeddingPort,
  GenerationPort,
  LlmResult,
  ProgressCallback,
  RerankPort,
} from "../types";
import type { ModelType } from "../types";
import type { ModelLease } from "./lifecycle";

import { ModelCache } from "../cache";
import { HttpEmbedding, isHttpModelUri } from "../httpEmbedding";
import { HttpGeneration, isHttpGenUri } from "../httpGeneration";
import { HttpRerank, isHttpRerankUri } from "../httpRerank";
import { NativeWorkerClient } from "../native-worker/client";
import { NativeWorkerError } from "../native-worker/errors";
import {
  NativeEmbeddingPort,
  NativeGenerationPort,
  NativeRerankPort,
} from "../native-worker/ports";
import {
  getActivePreset,
  getAnswerModelUri,
  getExpandModelUri,
  getModelConfig,
} from "../registry";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface CreatePortOptions {
  /** Download policy (offline, allowDownload) */
  policy?: DownloadPolicy;
  /** Progress callback for downloads */
  onProgress?: ProgressCallback;
  /**
   * Participating collection scope for outbound HTTP inference.
   * `"all"` is an explicit corpus-wide decision, never an omission fallback.
   */
  egressCollections: readonly string[] | "all";
}

/** Default policy: no auto-download (backwards compatible) */
const DEFAULT_POLICY: DownloadPolicy = { offline: false, allowDownload: false };

const resolveEgressCollectionNames = (
  config: Config,
  scope: CreatePortOptions["egressCollections"]
): readonly string[] =>
  scope === "all" ? config.collections.map(({ name }) => name) : scope;

// ─────────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────────

export class LlmAdapter {
  private readonly worker: NativeWorkerClient;
  private readonly cache: ModelCache;
  private readonly config: Config;

  constructor(config: Config, cacheDir?: string) {
    this.config = config;
    const modelConfig = getModelConfig(config);
    this.worker = new NativeWorkerClient({
      models: [],
      loadTimeout: modelConfig.loadTimeout,
      inferenceTimeout: modelConfig.inferenceTimeout,
      warmModelTtl: modelConfig.warmModelTtl,
    });
    this.cache = new ModelCache(cacheDir);
  }

  /**
   * Create an embedding port.
   * Supports HTTP endpoints for remote embedding models.
   * With options.policy.allowDownload=true, auto-downloads if not cached.
   */
  async createEmbeddingPort(
    modelUri: string | undefined,
    options: CreatePortOptions
  ): Promise<LlmResult<EmbeddingPort>> {
    const preset = getActivePreset(this.config);
    const uri = modelUri ?? preset.embed;
    const policy = options.policy ?? DEFAULT_POLICY;

    // Use HTTP embedding for remote endpoints
    if (isHttpModelUri(uri)) {
      const httpEmbed = new HttpEmbedding(uri, {
        collections: this.config.collections,
        collectionNames: resolveEgressCollectionNames(
          this.config,
          options.egressCollections
        ),
      });
      // Initialize to verify connection and get dimensions
      const initResult = await httpEmbed.init();
      if (!initResult.ok) {
        return { ok: false, error: initResult.error };
      }
      return { ok: true, value: httpEmbed };
    }

    // Ensure model is available (downloads if policy allows)
    const resolved = await this.cache.ensureModel(
      uri,
      "embed",
      policy,
      options.onProgress
    );
    if (!resolved.ok) {
      return resolved;
    }

    const approved = await this.approve(uri, resolved.value, "embed");
    if (!approved.ok) return approved;
    return {
      ok: true,
      value: new NativeEmbeddingPort(this.worker, approved.value, uri),
    };
  }

  /**
   * Create a generation port.
   * Supports HTTP endpoints for remote generation models.
   * With options.policy.allowDownload=true, auto-downloads if not cached.
   */
  async createGenerationPort(
    modelUri: string | undefined,
    options: CreatePortOptions
  ): Promise<LlmResult<GenerationPort>> {
    const uri = getAnswerModelUri(this.config, modelUri);
    const policy = options.policy ?? DEFAULT_POLICY;

    // Use HTTP generation for remote endpoints
    if (isHttpGenUri(uri)) {
      const httpGen = new HttpGeneration(uri, {
        collections: this.config.collections,
        collectionNames: resolveEgressCollectionNames(
          this.config,
          options.egressCollections
        ),
      });
      return { ok: true, value: httpGen };
    }

    // Ensure model is available (downloads if policy allows)
    const resolved = await this.cache.ensureModel(
      uri,
      "gen",
      policy,
      options.onProgress
    );
    if (!resolved.ok) {
      return resolved;
    }

    const approved = await this.approve(uri, resolved.value, "gen");
    if (!approved.ok) return approved;
    return {
      ok: true,
      value: new NativeGenerationPort(this.worker, approved.value, uri),
    };
  }

  /**
   * Create a generation port dedicated to query expansion.
   * Uses preset.expand when configured, else falls back to preset.gen.
   */
  async createExpansionPort(
    modelUri: string | undefined,
    options: CreatePortOptions
  ): Promise<LlmResult<GenerationPort>> {
    const uri = getExpandModelUri(this.config, modelUri);
    const policy = options.policy ?? DEFAULT_POLICY;

    if (isHttpGenUri(uri)) {
      const httpGen = new HttpGeneration(uri, {
        collections: this.config.collections,
        collectionNames: resolveEgressCollectionNames(
          this.config,
          options.egressCollections
        ),
      });
      return { ok: true, value: httpGen };
    }

    const resolved = await this.cache.ensureModel(
      uri,
      "expand",
      policy,
      options.onProgress
    );
    if (!resolved.ok) {
      return resolved;
    }

    const approved = await this.approve(uri, resolved.value, "gen");
    if (!approved.ok) return approved;
    return {
      ok: true,
      value: new NativeGenerationPort(this.worker, approved.value, uri),
    };
  }

  /**
   * Create a rerank port.
   * Supports HTTP endpoints for remote reranking models.
   * With options.policy.allowDownload=true, auto-downloads if not cached.
   */
  async createRerankPort(
    modelUri: string | undefined,
    options: CreatePortOptions
  ): Promise<LlmResult<RerankPort>> {
    const preset = getActivePreset(this.config);
    const uri = modelUri ?? preset.rerank;
    const policy = options.policy ?? DEFAULT_POLICY;

    // Use HTTP rerank for remote endpoints
    if (isHttpRerankUri(uri)) {
      const httpRerank = new HttpRerank(uri, {
        collections: this.config.collections,
        collectionNames: resolveEgressCollectionNames(
          this.config,
          options.egressCollections
        ),
      });
      return { ok: true, value: httpRerank };
    }

    // Ensure model is available (downloads if policy allows)
    const resolved = await this.cache.ensureModel(
      uri,
      "rerank",
      policy,
      options.onProgress
    );
    if (!resolved.ok) {
      return resolved;
    }

    const approved = await this.approve(uri, resolved.value, "rerank");
    if (!approved.ok) return approved;
    return {
      ok: true,
      value: new NativeRerankPort(this.worker, approved.value, uri),
    };
  }

  private async approve(
    uri: string,
    path: string,
    type: ModelType
  ): Promise<LlmResult<string>> {
    try {
      const id = `${type}:${uri}`;
      await this.worker.registerModel({
        id,
        modelUri: uri,
        path: await realpath(path),
        type,
      });
      return { ok: true, value: id };
    } catch (cause) {
      return {
        ok: false,
        error: (cause instanceof NativeWorkerError
          ? cause
          : new NativeWorkerError("protocol")
        ).detail,
      };
    }
  }

  /**
   * Get the model cache instance.
   */
  getCache(): ModelCache {
    return this.cache;
  }

  /**
   * Native-free lifetime facade. Explicit model disposal retires the child.
   */
  getManager(): {
    dispose(uri: string): Promise<void>;
    acquireLease(): ModelLease;
  } {
    return {
      dispose: (uri) => this.worker.disposeModel(uri),
      acquireLease: () => this.worker.acquireLease(),
    };
  }

  /** Acquire an idempotent request lease without transferring manager ownership. */
  acquireModelLease(): ModelLease {
    return this.worker.acquireLease();
  }

  /**
   * Dispose all resources.
   */
  async dispose(): Promise<void> {
    await this.worker.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an LLM adapter instance.
 */
export function createLlmAdapter(
  config: Config,
  cacheDir?: string
): LlmAdapter {
  return new LlmAdapter(config, cacheDir);
}
