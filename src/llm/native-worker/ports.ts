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
  embeddingIdentity: EmbeddingIdentitySchema.optional(),
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

  async init(): Promise<LlmResult<void>> {
    const result = decode(
      await this.client.request({ op: "init", modelId: this.modelId }),
      metadata
    );
    if (!result.ok) return result;
    this.dims = result.value.dimensions;
    this.identity = result.value.embeddingIdentity;
    this.generation = this.client.currentGeneration;
    return { ok: true, value: undefined };
  }

  private acceptDimensions(length: number): boolean {
    if (this.generation !== this.client.currentGeneration) {
      this.dims = undefined;
      this.identity = undefined;
    }
    this.generation = this.client.currentGeneration;
    if (this.dims !== undefined && this.dims !== length) return false;
    this.dims = length;
    return true;
  }

  async embed(text: string): Promise<LlmResult<number[]>> {
    const result = decode(
      await this.client.request({ op: "embed", modelId: this.modelId, text }),
      vector
    );
    if (result.ok && !this.acceptDimensions(result.value.length)) {
      await this.client.disposeModel(this.modelUri);
      return { ok: false, error: new NativeWorkerError("protocol").detail };
    }
    return result;
  }

  async embedBatch(texts: string[]): Promise<LlmResult<number[][]>> {
    const result = decode(
      await this.client.request({
        op: "embedBatch",
        modelId: this.modelId,
        texts,
      }),
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
  }

  dimensions(): number {
    if (this.dims === undefined)
      throw new Error("Call init() or embed() first to initialize dimensions");
    return this.dims;
  }

  getIdentity(): EmbeddingIdentity | undefined {
    if (
      this.generation !== this.client.currentGeneration ||
      this.client.processId === undefined
    )
      return;
    return this.identity && { ...this.identity };
  }

  override async dispose(): Promise<void> {
    this.dims = undefined;
    this.identity = undefined;
    await super.dispose();
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
