/**
 * Tests for contextual embedding formatting functions.
 *
 * @module test/pipeline/contextual
 */

import { describe, expect, test } from "bun:test";

import { getEmbeddingCompatibilityProfile } from "../../src/llm/embedding-compatibility";
import {
  extractTitle,
  formatDocForEmbedding,
  formatQueryForEmbedding,
} from "../../src/pipeline/contextual";

describe("formatQueryForEmbedding", () => {
  test("adds search task prefix", () => {
    const formatted = formatQueryForEmbedding("how to deploy");
    expect(formatted).toBe("task: search result | query: how to deploy");
  });

  test("handles empty query", () => {
    const formatted = formatQueryForEmbedding("");
    expect(formatted).toBe("task: search result | query: ");
  });

  test("preserves query with special characters", () => {
    const formatted = formatQueryForEmbedding("what is async/await?");
    expect(formatted).toBe("task: search result | query: what is async/await?");
  });

  test("uses Qwen instruct query formatting for Qwen embedding models", () => {
    const formatted = formatQueryForEmbedding(
      "how to deploy",
      "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
    );
    expect(formatted).toBe(
      "Instruct: Retrieve relevant documents for the given query\nQuery: how to deploy"
    );
  });
});

describe("formatDocForEmbedding", () => {
  test("adds title and text prefix", () => {
    const formatted = formatDocForEmbedding("Some content", "My Title");
    expect(formatted).toBe("title: My Title | text: Some content");
  });

  test("handles missing title", () => {
    const formatted = formatDocForEmbedding("Some content");
    expect(formatted).toBe("title: none | text: Some content");
  });

  test("handles undefined title", () => {
    const formatted = formatDocForEmbedding("Some content", undefined);
    expect(formatted).toBe("title: none | text: Some content");
  });

  test("handles empty title", () => {
    const formatted = formatDocForEmbedding("Some content", "");
    expect(formatted).toBe("title: none | text: Some content");
  });

  test("trims whitespace from title", () => {
    const formatted = formatDocForEmbedding("Content", "  My Title  ");
    expect(formatted).toBe("title: My Title | text: Content");
  });

  test("handles whitespace-only title", () => {
    const formatted = formatDocForEmbedding("Content", "   ");
    expect(formatted).toBe("title: none | text: Content");
  });

  test("uses raw text formatting for Qwen embedding documents", () => {
    const formatted = formatDocForEmbedding(
      "Some content",
      "My Title",
      "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
    );
    expect(formatted).toBe("My Title\nSome content");
  });
});

describe("getEmbeddingCompatibilityProfile", () => {
  test("returns Qwen profile for Qwen embedding URIs", () => {
    const profile = getEmbeddingCompatibilityProfile(
      "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
    );
    expect(profile.id).toBe("qwen-embedding");
    expect(profile.batchEmbeddingTrusted).toBe(true);
  });

  test("marks Jina embedding families as batch-untrusted", () => {
    const profile = getEmbeddingCompatibilityProfile(
      "hf:jinaai/jina-embeddings-v4-text-code-GGUF/jina-embeddings-v4-text-code-Q5_K_M.gguf"
    );
    expect(profile.id).toBe("jina-embedding");
    expect(profile.batchEmbeddingTrusted).toBe(false);
  });

  test("returns default profile for unknown models", () => {
    const profile = getEmbeddingCompatibilityProfile(
      "hf:test/other-embed.gguf"
    );
    expect(profile.id).toBe("default");
    expect(profile.batchEmbeddingTrusted).toBe(true);
  });
});

describe("extractTitle", () => {
  test("extracts h1 heading", () => {
    const content = "# My Document\n\nSome content here.";
    const title = extractTitle(content, "fallback.md");
    expect(title).toBe("My Document");
  });

  test("extracts h2 heading when no h1", () => {
    const content = "## Section Title\n\nSome content here.";
    const title = extractTitle(content, "fallback.md");
    expect(title).toBe("Section Title");
  });

  test("falls back to filename without extension", () => {
    const content = "Just plain text without headings.";
    const title = extractTitle(content, "my-document.md");
    expect(title).toBe("my-document");
  });

  test("handles path in filename", () => {
    const content = "No headings here.";
    const title = extractTitle(content, "/path/to/document.md");
    expect(title).toBe("document");
  });

  test('skips generic "Notes" title and uses next heading', () => {
    const content = "# Notes\n\n## Actual Topic\n\nContent here.";
    const title = extractTitle(content, "fallback.md");
    expect(title).toBe("Actual Topic");
  });

  test('uses "Notes" if no alternative heading', () => {
    const content = "# Notes\n\nJust some notes without other headings.";
    const title = extractTitle(content, "fallback.md");
    // Falls back to Notes since no ## heading exists
    expect(title).toBe("Notes");
  });

  test("handles heading with special characters", () => {
    const content = "# API Reference (v2.0)\n\nDocumentation.";
    const title = extractTitle(content, "fallback.md");
    expect(title).toBe("API Reference (v2.0)");
  });

  test("handles heading mid-document", () => {
    const content = "Some preamble text.\n\n# Document Title\n\nContent.";
    const title = extractTitle(content, "fallback.md");
    expect(title).toBe("Document Title");
  });
});
