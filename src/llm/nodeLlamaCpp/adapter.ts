/**
 * Main LLM adapter for node-llama-cpp.
 * Factory for creating port instances.
 *
 * @module src/llm/nodeLlamaCpp/adapter
 */

import type { Config } from '../../config/types';
import { ModelCache } from '../cache';
import { getActivePreset, getModelConfig } from '../registry';
import type {
  EmbeddingPort,
  GenerationPort,
  LlmResult,
  RerankPort,
} from '../types';
import { NodeLlamaCppEmbedding } from './embedding';
import { NodeLlamaCppGeneration } from './generation';
import { getModelManager, type ModelManager } from './lifecycle';
import { NodeLlamaCppRerank } from './rerank';

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
   */
  async createEmbeddingPort(
    modelUri?: string
  ): Promise<LlmResult<EmbeddingPort>> {
    const preset = getActivePreset(this.config);
    const uri = modelUri ?? preset.embed;

    // Resolve model path from cache
    const resolved = await this.cache.resolve(uri, 'embed');
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
   */
  async createGenerationPort(
    modelUri?: string
  ): Promise<LlmResult<GenerationPort>> {
    const preset = getActivePreset(this.config);
    const uri = modelUri ?? preset.gen;

    // Resolve model path from cache
    const resolved = await this.cache.resolve(uri, 'gen');
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
   */
  async createRerankPort(modelUri?: string): Promise<LlmResult<RerankPort>> {
    const preset = getActivePreset(this.config);
    const uri = modelUri ?? preset.rerank;

    // Resolve model path from cache
    const resolved = await this.cache.resolve(uri, 'rerank');
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
