/**
 * Generation port implementation using node-llama-cpp.
 *
 * @module src/llm/nodeLlamaCpp/generation
 */

import type { GenerationPort, GenParams, LlmResult } from "../types";
import type { ModelManager } from "./lifecycle";

import { inferenceFailedError } from "../errors";

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
    params?: GenParams
  ): Promise<LlmResult<string>> {
    const model = await this.manager.loadModel(
      this.modelPath,
      this.modelUri,
      "gen"
    );
    if (!model.ok) {
      return model;
    }

    const llamaModel = model.value.model as LlamaModel;
    let context: Awaited<ReturnType<LlamaModel["createContext"]>> | null = null;
    try {
      const grammar = params?.jsonSchema
        ? await (
            await this.manager.getLlama()
          ).createGrammarForJsonSchema(params.jsonSchema as JsonGrammarSchema)
        : undefined;
      context = await llamaModel.createContext(
        params?.contextSize ? { contextSize: params.contextSize } : undefined
      );
      // Import LlamaChatSession dynamically
      const { LlamaChatSession } = await import("node-llama-cpp");
      const session = new LlamaChatSession({
        contextSequence: context.getSequence(),
      });

      // Note: stop sequences not yet supported - requires stopOnTrigger API
      const response = await promptWithJsonSchemaGrammar(
        session as StructuredPromptSession,
        prompt,
        {
          temperature: params?.temperature ?? DEFAULT_TEMPERATURE,
          seed: params?.seed ?? DEFAULT_SEED,
          maxTokens: params?.maxTokens ?? DEFAULT_MAX_TOKENS,
        },
        grammar
      );

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
