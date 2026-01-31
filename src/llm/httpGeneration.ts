/**
 * HTTP-based generation port implementation.
 * Calls OpenAI-compatible chat completion endpoints.
 *
 * @module src/llm/httpGeneration
 */

import type { GenerationPort, GenParams, LlmResult } from "./types";

import { inferenceFailedError } from "./errors";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface OpenAIChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
      reasoning_content?: string; // Qwen3 thinking mode
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

export class HttpGeneration implements GenerationPort {
  private readonly apiUrl: string;
  private readonly modelName: string;
  readonly modelUri: string;

  constructor(modelUri: string) {
    this.modelUri = modelUri;
    // Parse URI: http://host:port/v1/chat/completions#modelname
    const hashIndex = modelUri.indexOf("#");
    if (hashIndex > 0) {
      this.apiUrl = modelUri.slice(0, hashIndex);
      this.modelName = modelUri.slice(hashIndex + 1);
    } else {
      this.apiUrl = modelUri;
      // Try to extract model name from URL path or use default
      const url = new URL(modelUri);
      const pathParts = url.pathname.split("/");
      this.modelName = pathParts[pathParts.length - 1] || "llama";
    }
  }

  async generate(
    prompt: string,
    params?: GenParams
  ): Promise<LlmResult<string>> {
    try {
      const response = await fetch(this.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.modelName,
          messages: [{ role: "user", content: prompt }],
          temperature: params?.temperature ?? 0,
          max_tokens: params?.maxTokens ?? 256,
          stop: params?.stop,
          seed: params?.seed,
        }),
      });

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

      const data = (await response.json()) as OpenAIChatResponse;
      const content = data.choices[0]?.message?.content ?? "";

      return { ok: true, value: content };
    } catch (e) {
      return {
        ok: false,
        error: inferenceFailedError(
          this.modelUri,
          e instanceof Error ? e : new Error(String(e))
        ),
      };
    }
  }

  async dispose(): Promise<void> {
    // Nothing to dispose for HTTP client
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// URI Detection
// ─────────────────────────────────────────────────────────────────────────────

export function isHttpGenUri(uri: string): boolean {
  return uri.startsWith("http://") || uri.startsWith("https://");
}
