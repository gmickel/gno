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
type LlamaContext = Awaited<ReturnType<LlamaModel["createContext"]>>;
type LlamaContextSequence = ReturnType<LlamaContext["getSequence"]>;
type Llama = Awaited<ReturnType<typeof import("node-llama-cpp").getLlama>>;
type JsonGrammarSchema = Parameters<Llama["createGrammarForJsonSchema"]>[0];

const MAX_CACHED_GRAMMARS_PER_LLAMA = 64;
const GEN_CONTEXT_REUSE_SHRINK_MIN_TOKENS = 4096;

const GRAMMAR_CACHE = new WeakMap<
  object,
  Map<string, Promise<JsonSchemaGrammarLike>>
>();
let cachedLlamaChatSessionPromise: Promise<
  (typeof import("node-llama-cpp"))["LlamaChatSession"]
> | null = null;

function getLlamaChatSessionClass(): Promise<
  (typeof import("node-llama-cpp"))["LlamaChatSession"]
> {
  cachedLlamaChatSessionPromise ??= import("node-llama-cpp").then(
    (mod) => mod.LlamaChatSession
  );
  return cachedLlamaChatSessionPromise;
}

async function getCachedJsonSchemaGrammar(
  llama: Llama,
  schema: JsonGrammarSchema
): Promise<JsonSchemaGrammarLike> {
  const key = JSON.stringify(schema);
  let bySchema = GRAMMAR_CACHE.get(llama as object);
  if (!bySchema) {
    bySchema = new Map();
    GRAMMAR_CACHE.set(llama as object, bySchema);
  }
  const existing = bySchema.get(key);
  if (existing) {
    // Refresh insertion order for LRU eviction.
    bySchema.delete(key);
    bySchema.set(key, existing);
    return existing;
  }
  const created = Promise.resolve(
    llama.createGrammarForJsonSchema(schema)
  ) as Promise<JsonSchemaGrammarLike>;
  bySchema.set(key, created);
  if (bySchema.size > MAX_CACHED_GRAMMARS_PER_LLAMA) {
    const oldestKey = bySchema.keys().next().value;
    if (oldestKey !== undefined) {
      bySchema.delete(oldestKey);
    }
  }
  try {
    return await created;
  } catch (error) {
    if (bySchema.get(key) === created) {
      bySchema.delete(key);
    }
    throw error;
  }
}

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
  readonly modelPath: string;

  private context: LlamaContext | null = null;
  private sequence: LlamaContextSequence | null = null;
  private contextModel: LlamaModel | null = null;
  private contextSize = 0;
  private pending: Promise<void> = Promise.resolve();
  private disposed = false;

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
    if (this.disposed) {
      return {
        ok: false,
        error: inferenceFailedError(
          this.modelUri,
          new Error("Generation port is disposed")
        ),
      };
    }
    const operation = this.pending.then(() =>
      this.runGenerate(prompt, params, options)
    );
    this.pending = operation.then(
      () => {},
      () => {}
    );
    return operation;
  }

  private async runGenerate(
    prompt: string,
    params?: GenParams,
    options?: NativeEvaluationOptions
  ): Promise<LlmResult<string>> {
    if (this.disposed) {
      return {
        ok: false,
        error: inferenceFailedError(
          this.modelUri,
          new Error("Generation port is disposed")
        ),
      };
    }
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
      await this.releaseContext();
      return model;
    }

    const llamaModel = model.value.model as LlamaModel;
    try {
      checkEvaluation(options);
      if (llamaModel.disposed) {
        throw new Error("Generation model is disposed");
      }
      const grammar = params?.jsonSchema
        ? await getCachedJsonSchemaGrammar(
            await this.manager.getLlama(),
            params.jsonSchema as JsonGrammarSchema
          )
        : undefined;
      const needed =
        params?.contextSize ??
        resolveGenContextSize({
          promptTokenCount: llamaModel.tokenize(prompt).length,
          maxTokens: params?.maxTokens ?? DEFAULT_MAX_TOKENS,
          trainContextSize: llamaModel.trainContextSize,
        });

      const canReuse =
        this.context !== null &&
        this.sequence !== null &&
        !this.context.disposed &&
        this.contextModel === llamaModel &&
        this.contextSize >= needed &&
        this.contextSize <=
          Math.max(GEN_CONTEXT_REUSE_SHRINK_MIN_TOKENS, needed * 2);

      if (canReuse && this.sequence) {
        // Clear KV state so each call starts identically from empty pos 0.
        if (typeof this.sequence.clearHistory === "function") {
          await this.sequence.clearHistory();
        } else {
          await this.releaseContext();
        }
      } else {
        await this.releaseContext();
      }

      if (!this.context || !this.sequence) {
        const context = await llamaModel.createContext({
          contextSize: needed,
          createSignal: options?.signal,
        });
        const sequence = context.getSequence();
        this.context = context;
        this.sequence = sequence;
        this.contextModel = llamaModel;
        this.contextSize = needed;
      }

      const LlamaChatSession = await getLlamaChatSessionClass();
      const session = new LlamaChatSession({
        contextSequence: this.sequence,
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
      await this.releaseContext();
      return { ok: false, error: inferenceFailedError(this.modelUri, e) };
    }
  }

  private async releaseContext(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.sequence = null;
    this.contextModel = null;
    this.contextSize = 0;
    if (context && !context.disposed) {
      await context.dispose().catch(() => {
        // Ignore disposal errors
      });
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.pending;
    if (!this.context) {
      return;
    }
    const lease = this.manager.acquireLease(this.modelUri, false);
    try {
      await this.releaseContext();
    } finally {
      lease.release();
    }
  }
}
