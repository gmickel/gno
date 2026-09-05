import type { NativeEvaluationOptions } from "../native-worker/evaluation";
import type { GenerationPort, GenParams, LlmResult } from "../types";
/**
 * Generation port implementation using node-llama-cpp.
 *
 * @module src/llm/nodeLlamaCpp/generation
 */
import type { ModelManager } from "./lifecycle";

import { inferenceFailedError } from "../errors";
import { checkEvaluation, startEvaluation } from "../native-worker/evaluation";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type LlamaModel = Awaited<
  ReturnType<
    Awaited<ReturnType<typeof import("node-llama-cpp").getLlama>>["loadModel"]
  >
>;
type Llama = Awaited<ReturnType<typeof import("node-llama-cpp").getLlama>>;
type JsonGrammarSchema = Parameters<Llama["createGrammarForJsonSchema"]>[0];

export interface JsonSchemaGrammarLike {
  parse(response: string): unknown;
}

export interface StructuredPromptSession {
  prompt(
    prompt: string,
    options: {
      temperature: number;
      seed: number;
      maxTokens: number;
      grammar?: JsonSchemaGrammarLike;
      signal?: AbortSignal;
      stopOnAbortSignal?: boolean;
    }
  ): Promise<string>;
}

export const promptWithJsonSchemaGrammar = async (
  session: StructuredPromptSession,
  prompt: string,
  options: {
    temperature: number;
    seed: number;
    maxTokens: number;
    signal?: AbortSignal;
    stopOnAbortSignal?: boolean;
  },
  grammar?: JsonSchemaGrammarLike
): Promise<string> => {
  const response = await session.prompt(prompt, { ...options, grammar });
  grammar?.parse(response);
  return response;
};

// ─────────────────────────────────────────────────────────────────────────────
// Default Parameters (for determinism)
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TEMPERATURE = 0;
const DEFAULT_SEED = 42;
const DEFAULT_MAX_TOKENS = 256;

// Context sizing: without an explicit contextSize, node-llama-cpp defaults to
// "auto", which grows the KV cache to fill available VRAM up to the model's
// trained context length (OOM risk on small GPUs — see issue #189). Instead,
// size the context to what the call actually needs: prompt tokens + output
// budget + margin for chat-template wrapping and special tokens.
const GEN_CONTEXT_MARGIN_TOKENS = 512;
const GEN_CONTEXT_MIN_TOKENS = 1024;

export const resolveGenContextSize = (input: {
  promptTokenCount: number;
  maxTokens: number;
  trainContextSize?: number;
}): number => {
  const needed = Math.max(
    GEN_CONTEXT_MIN_TOKENS,
    input.promptTokenCount + input.maxTokens + GEN_CONTEXT_MARGIN_TOKENS
  );
  if (input.trainContextSize && input.trainContextSize > 0) {
    return Math.min(needed, input.trainContextSize);
  }
  return needed;
};

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

export class NodeLlamaCppGeneration implements GenerationPort {
  private readonly manager: ModelManager;
  readonly modelUri: string;
  readonly structuredOutput = "json_schema" as const;
  private readonly modelPath: string;

  constructor(manager: ModelManager, modelUri: string, modelPath: string) {
    this.manager = manager;
    this.modelUri = modelUri;
    this.modelPath = modelPath;
  }

  async generate(
    prompt: string,
    params?: GenParams,
    options?: NativeEvaluationOptions
  ): Promise<LlmResult<string>> {
    const lease = this.manager.acquireLease(this.modelUri);
    try {
      return await this.generateLeased(prompt, params, options);
    } finally {
      lease.release();
    }
  }

  private async generateLeased(
    prompt: string,
    params?: GenParams,
    options?: NativeEvaluationOptions
  ): Promise<LlmResult<string>> {
    checkEvaluation(options);
    const model = await this.manager.loadModel(
      this.modelPath,
      this.modelUri,
      "gen",
      options?.signal
    );
    if (!model.ok) {
      return model;
    }

    const llamaModel = model.value.model as LlamaModel;
    let context: Awaited<ReturnType<LlamaModel["createContext"]>> | null = null;
    try {
      checkEvaluation(options);
      const grammar = params?.jsonSchema
        ? await (
            await this.manager.getLlama()
          ).createGrammarForJsonSchema(params.jsonSchema as JsonGrammarSchema)
        : undefined;
      const contextSize =
        params?.contextSize ??
        resolveGenContextSize({
          promptTokenCount: llamaModel.tokenize(prompt).length,
          maxTokens: params?.maxTokens ?? DEFAULT_MAX_TOKENS,
          trainContextSize: llamaModel.trainContextSize,
        });
      context = await llamaModel.createContext({
        contextSize,
        createSignal: options?.signal,
      });
      // Import LlamaChatSession dynamically
      const { LlamaChatSession } = await import("node-llama-cpp");
      const session = new LlamaChatSession({
        contextSequence: context.getSequence(),
      });

      // Note: stop sequences not yet supported - requires stopOnTrigger API
      startEvaluation(options);
      const response = await promptWithJsonSchemaGrammar(
        session as StructuredPromptSession,
        prompt,
        {
          signal: options?.signal,
          stopOnAbortSignal: false,
          temperature: params?.temperature ?? DEFAULT_TEMPERATURE,
          seed: params?.seed ?? DEFAULT_SEED,
          maxTokens: params?.maxTokens ?? DEFAULT_MAX_TOKENS,
        },
        grammar
      );

      checkEvaluation(options);
      return { ok: true, value: response };
    } catch (e) {
      return { ok: false, error: inferenceFailedError(this.modelUri, e) };
    } finally {
      await context?.dispose().catch(() => {
        // Ignore disposal errors
      });
    }
  }

  async dispose(): Promise<void> {
    // Generation doesn't hold persistent context
    // Model cleanup is handled by ModelManager
  }
}
