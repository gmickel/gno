/**
 * Generation port implementation using node-llama-cpp.
 *
 * @module src/llm/nodeLlamaCpp/generation
 */

import { inferenceFailedError } from '../errors';
import type { GenerationPort, GenParams, LlmResult } from '../types';
import type { ModelManager } from './lifecycle';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type LlamaModel = Awaited<
  ReturnType<
    Awaited<ReturnType<typeof import('node-llama-cpp').getLlama>>['loadModel']
  >
>;

// ─────────────────────────────────────────────────────────────────────────────
// Default Parameters (for determinism)
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TEMPERATURE = 0;
const DEFAULT_SEED = 42;
const DEFAULT_MAX_TOKENS = 256;

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

export class NodeLlamaCppGeneration implements GenerationPort {
  private readonly manager: ModelManager;
  readonly modelUri: string;
  private readonly modelPath: string;

  constructor(manager: ModelManager, modelUri: string, modelPath: string) {
    this.manager = manager;
    this.modelUri = modelUri;
    this.modelPath = modelPath;
  }

  async generate(
    prompt: string,
    params?: GenParams
  ): Promise<LlmResult<string>> {
    const model = await this.manager.loadModel(
      this.modelPath,
      this.modelUri,
      'gen'
    );
    if (!model.ok) {
      return model;
    }

    const llamaModel = model.value.model as LlamaModel;
    const context = await llamaModel.createContext();

    try {
      // Import LlamaChatSession dynamically
      const { LlamaChatSession } = await import('node-llama-cpp');
      const session = new LlamaChatSession({
        contextSequence: context.getSequence(),
      });

      // Note: stop sequences not yet supported - requires stopOnTrigger API
      const response = await session.prompt(prompt, {
        temperature: params?.temperature ?? DEFAULT_TEMPERATURE,
        seed: params?.seed ?? DEFAULT_SEED,
        maxTokens: params?.maxTokens ?? DEFAULT_MAX_TOKENS,
      });

      return { ok: true, value: response };
    } catch (e) {
      return { ok: false, error: inferenceFailedError(this.modelUri, e) };
    } finally {
      await context.dispose().catch(() => {
        // Ignore disposal errors
      });
    }
  }

  async dispose(): Promise<void> {
    // Generation doesn't hold persistent context
    // Model cleanup is handled by ModelManager
  }
}
