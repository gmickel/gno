import { z } from "zod";

import type {
  EmbeddingPort,
  EmbeddingIdentity,
  GenerationPort,
  GenParams,
  LlmResult,
  RerankPort,
  RerankScore,
} from "../types";
import type { NativeWorkerClient } from "./client";
import type { NativeResponse } from "./protocol";

import { NativeWorkerError } from "./errors";
import { EmbeddingIdentitySchema } from "./protocol";

const vector = z.array(z.number().finite()).min(1);
const scores = z.array(
  z.strictObject({
    index: z.number().int().nonnegative(),
    score: z.number().finite(),
    rank: z.number().int().positive(),
  })
);
const metadata = z.object({
  dimensions: z.number().int().positive(),
  embeddingIdentity: EmbeddingIdentitySchema,
});

function decode<T>(
  result: NativeResponse["result"],
  schema: z.ZodType<T>
): LlmResult<T> {
  if (!result.ok) return result;
  const parsed = schema.safeParse(result.value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: new NativeWorkerError("protocol").detail };
}

class NativePort {
  constructor(
    protected readonly client: NativeWorkerClient,
    protected readonly modelId: string,
    readonly modelUri: string
  ) {}

  async dispose(): Promise<void> {
    // Disposing an unused/retired port must not launch a child.
    if (this.client.processId === undefined) return;
    const result = await this.client.request({
      op: "dispose",
      modelId: this.modelId,
    });
    if (!result.ok) throw new Error(result.error.message);
  }
}

/** Metadata and complete vectors cross IPC; no tokenizer/native objects in parent. */
export class NativeEmbeddingPort extends NativePort implements EmbeddingPort {
  private dims: number | undefined;
  private generation = 0;
  private identity?: EmbeddingIdentity;
  private initializing?: Promise<LlmResult<void>>;
  private version = 0;
  private disposing = false;

  async init(): Promise<LlmResult<void>> {
    return this.withIdentity(async () => ({ ok: true, value: undefined }));
  }

  private async loadIdentity(version: number): Promise<LlmResult<void>> {
    const result = decode(
      await this.client.request({ op: "init", modelId: this.modelId }),
      metadata
    );
    if (!result.ok) return result;
    if (
      version !== this.version ||
      this.disposing ||
      this.client.processId === undefined
    )
      return {
        ok: false,
        error: new NativeWorkerError("stale_generation").detail,
      };
    this.dims = result.value.dimensions;
    this.identity = result.value.embeddingIdentity;
    this.generation = this.client.currentGeneration;
    return { ok: true, value: undefined };
  }

  private async ensureIdentity(): Promise<LlmResult<void>> {
    if (this.getIdentity()) return { ok: true, value: undefined };
    if (this.initializing) return this.initializing;
    this.identity = undefined;
    this.dims = undefined;
    const pending = this.loadIdentity(this.version);
    this.initializing = pending;
    try {
      return await pending;
    } finally {
      if (this.initializing === pending) this.initializing = undefined;
    }
  }

  private async withIdentity<T>(
    operation: (generation: number) => Promise<LlmResult<T>>
  ): Promise<LlmResult<T>> {
    let lease: { release(): void } | undefined;
    const version = this.version;
    try {
      lease = this.client.acquireLease();
      if (this.disposing)
        return {
          ok: false,
          error: new NativeWorkerError("stale_generation").detail,
        };
      const initialized = await this.ensureIdentity();
      if (!initialized.ok) return initialized;
      if (version !== this.version || this.disposing)
        return {
          ok: false,
          error: new NativeWorkerError("stale_generation").detail,
        };
      const generation = this.generation;
      const identity = this.identity;
      const result = await operation(generation);
      if (!result.ok) {
        this.identity = undefined;
        return result;
      }
      if (
        version !== this.version ||
        generation !== this.client.currentGeneration ||
        this.client.processId === undefined
      ) {
        this.identity = undefined;
        return {
          ok: false,
          error: new NativeWorkerError("stale_generation").detail,
        };
      }
      this.identity = identity;
      return result;
    } catch (cause) {
      this.identity = undefined;
      return {
        ok: false,
        error: (cause instanceof NativeWorkerError
          ? cause
          : new NativeWorkerError("exited")
        ).detail,
      };
    } finally {
      lease?.release();
    }
  }

  private acceptDimensions(length: number): boolean {
    return (
      this.generation === this.client.currentGeneration && this.dims === length
    );
  }

  async embed(text: string): Promise<LlmResult<number[]>> {
    return this.withIdentity(async (generation) => {
      const result = decode(
        await this.client.request(
          { op: "embed", modelId: this.modelId, text },
          generation
        ),
        vector
      );
      if (result.ok && !this.acceptDimensions(result.value.length)) {
        await this.client.disposeModel(this.modelUri);
        return { ok: false, error: new NativeWorkerError("protocol").detail };
      }
      return result;
    });
  }

  async embedBatch(texts: string[]): Promise<LlmResult<number[][]>> {
    if (!texts.length) return { ok: true, value: [] };
    return this.withIdentity(async (generation) => {
      const result = decode(
        await this.client.request(
          {
            op: "embedBatch",
            modelId: this.modelId,
            texts,
          },
          generation
        ),
        z.array(vector).length(texts.length)
      );
      if (
        result.ok &&
        result.value.some((item) => !this.acceptDimensions(item.length))
      ) {
        await this.client.disposeModel(this.modelUri);
        return { ok: false, error: new NativeWorkerError("protocol").detail };
      }
      return result;
    });
  }

  dimensions(): number {
    if (this.dims === undefined)
      throw new Error("Call init() or embed() first to initialize dimensions");
    return this.dims;
  }

  getIdentity(): EmbeddingIdentity | undefined {
    if (
      this.generation !== this.client.currentGeneration ||
      this.client.processId === undefined ||
      this.disposing
    )
      return;
    return this.identity && { ...this.identity };
  }

  override async dispose(): Promise<void> {
    this.version++;
    this.disposing = true;
    this.initializing = undefined;
    this.dims = undefined;
    this.identity = undefined;
    try {
      await super.dispose();
    } finally {
      this.disposing = false;
    }
  }
}

export class NativeGenerationPort extends NativePort implements GenerationPort {
  readonly structuredOutput = "json_schema" as const;

  async generate(
    prompt: string,
    params?: GenParams
  ): Promise<LlmResult<string>> {
    const schema = z
      .record(z.string(), z.json())
      .optional()
      .safeParse(params?.jsonSchema);
    if (!schema.success)
      return { ok: false, error: new NativeWorkerError("protocol").detail };
    return decode(
      await this.client.request({
        op: "generate",
        modelId: this.modelId,
        prompt,
        params: params && { ...params, jsonSchema: schema.data },
      }),
      z.string()
    );
  }
}

export class NativeRerankPort extends NativePort implements RerankPort {
  async rerank(
    query: string,
    documents: string[]
  ): Promise<LlmResult<RerankScore[]>> {
    return decode(
      await this.client.request({
        op: "rerank",
        modelId: this.modelId,
        query,
        documents,
      }),
      scores.length(documents.length)
    );
  }
}
