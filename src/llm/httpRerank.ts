/**
 * HTTP-based rerank port implementation.
 * Calls OpenAI-compatible completions endpoints for reranking.
 *
 * @module src/llm/httpRerank
 */

import type { LlmResult, RerankPort, RerankScore } from "./types";

import { inferenceFailedError } from "./errors";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface OpenAICompletionResponse {
  choices: Array<{
    text: string;
    index: number;
    logprobs?: unknown;
    finish_reason: string;
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

export class HttpRerank implements RerankPort {
  private readonly apiUrl: string;
  private readonly modelName: string;
  private readonly instruction: string;
  readonly modelUri: string;

  constructor(modelUri: string) {
    this.modelUri = modelUri;
    // Parse URI: http://host:port/v1/completions#modelname
    const hashIndex = modelUri.indexOf("#");
    if (hashIndex > 0) {
      this.apiUrl = modelUri.slice(0, hashIndex);
      this.modelName = modelUri.slice(hashIndex + 1);
    } else {
      this.apiUrl = modelUri;
      const url = new URL(modelUri);
      const pathParts = url.pathname.split("/");
      this.modelName = pathParts[pathParts.length - 1] || "reranker-model";
    }
    // Default instruction for retrieval tasks
    this.instruction =
      "Given a web search query, retrieve relevant passages that answer the query";
  }

  async rerank(
    query: string,
    documents: string[]
  ): Promise<LlmResult<RerankScore[]>> {
    if (documents.length === 0) {
      return { ok: true, value: [] };
    }

    try {
      // Build prompts for all documents
      const prompts = documents.map((doc) => this.buildPrompt(query, doc));

      // Score all documents in a single batch request
      const scoresResult = await this.scoreBatch(prompts);

      if (!scoresResult.ok) {
        return { ok: false, error: scoresResult.error };
      }

      // Map scores back to document indices
      const scores = scoresResult.value.map((score, index) => ({
        index,
        score,
      }));

      // Sort by score descending
      scores.sort((a, b) => b.score - a.score);

      // Assign ranks
      const rankedScores: RerankScore[] = scores.map((item, rank) => ({
        index: item.index,
        score: item.score,
        rank: rank + 1,
      }));

      return { ok: true, value: rankedScores };
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

  private buildPrompt(query: string, document: string): string {
    return `<Instruct>: ${this.instruction}\n<Query>: ${query}\n<Document>: ${document}\n<Score>:`;
  }

  private async scoreBatch(prompts: string[]): Promise<LlmResult<number[]>> {
    try {
      const response = await fetch(this.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.modelName,
          prompt: prompts, // Array of prompts for batching
          max_tokens: 10, // Just need the score
          temperature: 0, // Deterministic
          stop: ["\n", "<"],
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

      const data = (await response.json()) as OpenAICompletionResponse;

      // Parse scores from all choices
      const scores: number[] = data.choices.map((choice) => {
        const text = choice.text?.trim() ?? "";

        // Parse score from response
        const scoreMatch = text.match(/[-+]?[0-9]*\.?[0-9]+/);
        if (!scoreMatch) {
          return 0; // Default low score if no number found
        }

        const score = parseFloat(scoreMatch[0]);
        return this.normalizeScore(score);
      });

      return { ok: true, value: scores };
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

  private normalizeScore(score: number): number {
    // Handle different score ranges
    if (score < -10 || score > 10) {
      // Likely logit or unbounded, apply sigmoid-like normalization
      return 1 / (1 + Math.exp(-score));
    } else if (score >= 0 && score <= 1) {
      // Already normalized
      return score;
    } else {
      // Assume -5 to 5 range, normalize to 0-1
      const normalized = (score + 5) / 10;
      return Math.max(0, Math.min(1, normalized));
    }
  }

  async dispose(): Promise<void> {
    // Nothing to dispose for HTTP client
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// URI Detection
// ─────────────────────────────────────────────────────────────────────────────

export function isHttpRerankUri(uri: string): boolean {
  return uri.startsWith("http://") || uri.startsWith("https://");
}
