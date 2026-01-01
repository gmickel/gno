/**
 * Main LLM adapter for node-llama-cpp.
 * Factory for creating port instances.
 *
 * @module src/llm/nodeLlamaCpp/adapter
 */

import type { Config } from '../../config/types';
import { ModelCache } from '../cache';
import type { DownloadPolicy } from '../policy';
import { getActivePreset, getModelConfig } from '../registry';
import type {
  EmbeddingPort,
  GenerationPort,
  LlmResult,
  ProgressCallback,
  RerankPort,
} from '../types';
import { NodeLlamaCppEmbedding } from './embedding';
import { NodeLlamaCppGeneration } from './generation';
import { getModelManager, type ModelManager } from './lifecycle';
import { NodeLlamaCppRerank } from './rerank';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface CreatePortOptions {
  /** Download policy (offline, allowDownload) */
  policy?: DownloadPolicy;
  /** Progress callback for downloads */
  onProgress?: ProgressCallback;
}

/** Default policy: no auto-download (backwards compatible) */
const DEFAULT_POLICY: DownloadPolicy = { offline: false, allowDownload: false };

// ─────────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────────

export class LlmAdapter {
  private readonly manager: ModelManager;
  private readonly cache: ModelCache;
  private readonly config: Config;

  constructor(config: Config, cacheDir?: string) {
    this.config = config;
    const modelConfig = getModelConfig(config);
    this.manager = getModelManager(modelConfig);
    this.cache = new ModelCache(cacheDir);
  }

  /**
   * Create an embedding port.
   * With options.policy.allowDownload=true, auto-downloads if not cached.
   */
  async createEmbeddingPort(
    modelUri?: string,
    options?: CreatePortOptions
  ): Promise<LlmResult<EmbeddingPort>> {
    const preset = getActivePreset(this.config);
    const uri = modelUri ?? preset.embed;
    const policy = options?.policy ?? DEFAULT_POLICY;

    // Ensure model is available (downloads if policy allows)
    const resolved = await this.cache.ensureModel(
      uri,
      'embed',
      policy,
      options?.onProgress
    );
    if (!resolved.ok) {
      return resolved;
    }

    return {
      ok: true,
      value: new NodeLlamaCppEmbedding(this.manager, uri, resolved.value),
    };
  }

  /**
   * Create a generation port.
   * With options.policy.allowDownload=true, auto-downloads if not cached.
   */
  async createGenerationPort(
    modelUri?: string,
    options?: CreatePortOptions
  ): Promise<LlmResult<GenerationPort>> {
    const preset = getActivePreset(this.config);
    const uri = modelUri ?? preset.gen;
    const policy = options?.policy ?? DEFAULT_POLICY;

    // Ensure model is available (downloads if policy allows)
    const resolved = await this.cache.ensureModel(
      uri,
      'gen',
      policy,
      options?.onProgress
    );
    if (!resolved.ok) {
      return resolved;
    }

    return {
      ok: true,
      value: new NodeLlamaCppGeneration(this.manager, uri, resolved.value),
    };
  }

  /**
   * Create a rerank port.
   * With options.policy.allowDownload=true, auto-downloads if not cached.
   */
  async createRerankPort(
    modelUri?: string,
    options?: CreatePortOptions
  ): Promise<LlmResult<RerankPort>> {
    const preset = getActivePreset(this.config);
    const uri = modelUri ?? preset.rerank;
    const policy = options?.policy ?? DEFAULT_POLICY;

    // Ensure model is available (downloads if policy allows)
    const resolved = await this.cache.ensureModel(
      uri,
      'rerank',
      policy,
      options?.onProgress
    );
    if (!resolved.ok) {
      return resolved;
    }

    return {
      ok: true,
      value: new NodeLlamaCppRerank(this.manager, uri, resolved.value),
    };
  }

  /**
   * Get the model cache instance.
   */
  getCache(): ModelCache {
    return this.cache;
  }

  /**
   * Get the model manager instance.
   */
  getManager(): ModelManager {
    return this.manager;
  }

  /**
   * Dispose all resources.
   */
  async dispose(): Promise<void> {
    await this.manager.disposeAll();
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
