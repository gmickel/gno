import type { HttpInferenceOptions } from "./http-inference";
import type { InferenceOptions } from "./types";
/**
 * HTTP-based embedding port implementation.
 * Calls OpenAI-compatible embedding endpoints.
 *
 * @module src/llm/httpEmbedding
 */
import type { EmbeddingPort, LlmResult } from "./types";

import { EgressDeniedError } from "../core/egress-enforcement";
import { egressDeniedInferenceError, inferenceFailedError } from "./errors";
import { requestHttpInference } from "./http-inference";
import { runHttpInference } from "./inference-scope";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface OpenAIEmbeddingResponse {
  data: Array<{
    embedding: number[];
    index: number;
    object: string;
  }>;
  model: string;
  object: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

export class HttpEmbedding implements EmbeddingPort {
  private readonly apiUrl: string;
  private readonly modelName: string;
  private readonly requestOptions: HttpInferenceOptions;
  private dims: number | null = null;
  readonly modelUri: string;

  constructor(modelUri: string, requestOptions: HttpInferenceOptions) {
    this.modelUri = modelUri;
    this.requestOptions = requestOptions;
    // Parse URI: http://host:port/v1/embeddings#modelname or just http://host:port
    const hashIndex = modelUri.indexOf("#");
    if (hashIndex > 0) {
      this.apiUrl = modelUri.slice(0, hashIndex);
      this.modelName = modelUri.slice(hashIndex + 1);
    } else {
      this.apiUrl = modelUri;
      // Try to extract model name from URL path or use default
      const url = new URL(modelUri);
      const pathParts = url.pathname.split("/");
      this.modelName = pathParts[pathParts.length - 1] || "embedding-model";
    }
  }

  async init(options?: InferenceOptions): Promise<LlmResult<void>> {
    // Test connection with a simple embedding
    const result = await this.embed("test", options);
    if (!result.ok) {
      return result;
    }
    return { ok: true, value: undefined };
  }

  async embed(
    text: string,
    options?: InferenceOptions
  ): Promise<LlmResult<number[]>> {
    return runHttpInference(
      options,
      (operational) => this.embedRequest(text, operational),
      this.requestOptions.inferenceTimeout
    );
  }

  private async embedRequest(
    text: string,
    options: InferenceOptions
  ): Promise<LlmResult<number[]>> {
    try {
      const response = await requestHttpInference(
        this.apiUrl,
        {
          signal: options.signal,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            input: text,
            model: this.modelName,
          }),
        },
        this.requestOptions
      );

      if (!response.ok) {
        const errorText = await response.text();
        return {
          ok: false,
          error: inferenceFailedError(
            this.modelUri,
            new Error(`HTTP ${response.status}: ${errorText}`)
          ),
        };
      }

      const data = (await response.json()) as OpenAIEmbeddingResponse;
      const vector = data.data[0]?.embedding;

      if (!vector || !Array.isArray(vector)) {
        return {
          ok: false,
          error: inferenceFailedError(
            this.modelUri,
            new Error("Invalid response format: missing embedding")
          ),
        };
      }

      // Cache dimensions on first call
      if (this.dims === null) {
        this.dims = vector.length;
      }

      return { ok: true, value: vector };
    } catch (e) {
      return {
        ok: false,
        error:
          e instanceof EgressDeniedError
            ? egressDeniedInferenceError(e)
            : inferenceFailedError(
                this.modelUri,
                e instanceof Error ? e : new Error(String(e))
              ),
      };
    }
  }

  async embedBatch(
    texts: string[],
    options?: InferenceOptions
  ): Promise<LlmResult<number[][]>> {
    return runHttpInference(
      options,
      (operational) => this.embedBatchRequest(texts, operational),
      this.requestOptions.inferenceTimeout
    );
  }

  private async embedBatchRequest(
    texts: string[],
    options: InferenceOptions
  ): Promise<LlmResult<number[][]>> {
    try {
      const response = await requestHttpInference(
        this.apiUrl,
        {
          signal: options.signal,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            input: texts,
            model: this.modelName,
          }),
        },
        this.requestOptions
      );

      if (!response.ok) {
        const errorText = await response.text();
        return {
          ok: false,
          error: inferenceFailedError(
            this.modelUri,
            new Error(`HTTP ${response.status}: ${errorText}`)
          ),
        };
      }

      const data = (await response.json()) as OpenAIEmbeddingResponse;

      // Sort by index to maintain order
      const sorted = data.data.sort((a, b) => a.index - b.index);
      const vectors = sorted.map((item) => item.embedding);

      // Validate all embeddings
      for (let i = 0; i < vectors.length; i++) {
        if (!vectors[i] || !Array.isArray(vectors[i])) {
          return {
            ok: false,
            error: inferenceFailedError(
              this.modelUri,
              new Error(`Invalid embedding at index ${i}`)
            ),
          };
        }
      }

      // Cache dimensions on first call
      if (this.dims === null && vectors.length > 0 && vectors[0]) {
        this.dims = vectors[0].length;
      }

      return { ok: true, value: vectors };
    } catch (e) {
      return {
        ok: false,
        error:
          e instanceof EgressDeniedError
            ? egressDeniedInferenceError(e)
            : inferenceFailedError(
                this.modelUri,
                e instanceof Error ? e : new Error(String(e))
              ),
      };
    }
  }

  dimensions(): number {
    if (this.dims === null) {
      throw new Error("Call init() or embed() first to initialize dimensions");
    }
    return this.dims;
  }

  async dispose(): Promise<void> {
    // Nothing to dispose for HTTP client
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// URI Detection
// ─────────────────────────────────────────────────────────────────────────────

export function isHttpModelUri(uri: string): boolean {
  return uri.startsWith("http://") || uri.startsWith("https://");
}
