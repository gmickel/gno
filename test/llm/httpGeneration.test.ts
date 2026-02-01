/**
 * Tests for HTTP generation adapter.
 *
 * @module test/llm/httpGeneration.test
 */

import { afterAll, describe, expect, it, mock } from "bun:test";

import { HttpGeneration, isHttpGenUri } from "../../src/llm/httpGeneration";

// ─────────────────────────────────────────────────────────────────────────────
// isHttpGenUri Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("isHttpGenUri", () => {
  it("returns true for http:// URLs", () => {
    expect(isHttpGenUri("http://localhost:8083/v1/chat/completions")).toBe(
      true
    );
  });

  it("returns true for https:// URLs", () => {
    expect(isHttpGenUri("https://api.example.com/v1/chat/completions")).toBe(
      true
    );
  });

  it("returns true for URLs with model hash", () => {
    expect(
      isHttpGenUri("http://192.168.0.48:8083/v1/chat/completions#qwen3-4b")
    ).toBe(true);
  });

  it("returns false for hf: URIs", () => {
    expect(isHttpGenUri("hf:org/repo/model.gguf")).toBe(false);
  });

  it("returns false for file: URIs", () => {
    expect(isHttpGenUri("file:/path/to/model.gguf")).toBe(false);
  });

  it("returns false for absolute paths", () => {
    expect(isHttpGenUri("/path/to/model.gguf")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HttpGeneration Constructor Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("HttpGeneration", () => {
  describe("constructor", () => {
    it("parses URL with model hash", () => {
      const gen = new HttpGeneration(
        "http://192.168.0.48:8083/v1/chat/completions#qwen3-4b"
      );
      expect(gen.modelUri).toBe(
        "http://192.168.0.48:8083/v1/chat/completions#qwen3-4b"
      );
    });

    it("parses URL without model hash", () => {
      const gen = new HttpGeneration(
        "http://localhost:8083/v1/chat/completions"
      );
      expect(gen.modelUri).toBe("http://localhost:8083/v1/chat/completions");
    });
  });

  describe("generate", () => {
    const originalFetch = globalThis.fetch;

    afterAll(() => {
      globalThis.fetch = originalFetch;
    });

    function mockFetch(fn: () => Promise<Response>): void {
      // Cast to unknown first, then to typeof fetch to satisfy type checker
      globalThis.fetch = mock(fn) as unknown as typeof fetch;
    }

    function mockFetchWithCapture(
      fn: (url: string, init?: RequestInit) => Promise<Response>
    ): void {
      globalThis.fetch = mock(fn) as unknown as typeof fetch;
    }

    it("returns generated text on success", async () => {
      mockFetch(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              id: "chatcmpl-123",
              object: "chat.completion",
              created: 1234567890,
              model: "qwen3-4b",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "Hello, world!" },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        )
      );

      const gen = new HttpGeneration(
        "http://localhost:8083/v1/chat/completions#qwen3-4b"
      );
      const result = await gen.generate("Hello");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("Hello, world!");
      }
    });

    it("handles empty response content", async () => {
      mockFetch(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              id: "chatcmpl-123",
              object: "chat.completion",
              created: 1234567890,
              model: "qwen3-4b",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "" },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 0,
                total_tokens: 10,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        )
      );

      const gen = new HttpGeneration(
        "http://localhost:8083/v1/chat/completions#qwen3-4b"
      );
      const result = await gen.generate("Hello");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("");
      }
    });

    it("returns error on HTTP failure", async () => {
      mockFetch(() =>
        Promise.resolve(
          new Response("Internal Server Error", {
            status: 500,
            statusText: "Internal Server Error",
          })
        )
      );

      const gen = new HttpGeneration(
        "http://localhost:8083/v1/chat/completions#qwen3-4b"
      );
      const result = await gen.generate("Hello");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INFERENCE_FAILED");
        expect(result.error.retryable).toBe(true);
      }
    });

    it("returns error on network failure", async () => {
      mockFetch(() => Promise.reject(new Error("Network error")));

      const gen = new HttpGeneration(
        "http://localhost:8083/v1/chat/completions#qwen3-4b"
      );
      const result = await gen.generate("Hello");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INFERENCE_FAILED");
        expect(result.error.retryable).toBe(true);
      }
    });

    it("passes generation parameters correctly", async () => {
      let capturedBody: unknown;
      mockFetchWithCapture((_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "chatcmpl-123",
              object: "chat.completion",
              created: 1234567890,
              model: "qwen3-4b",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "test" },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 1,
                total_tokens: 11,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      });

      const gen = new HttpGeneration(
        "http://localhost:8083/v1/chat/completions#qwen3-4b"
      );
      await gen.generate("Hello", {
        temperature: 0.7,
        maxTokens: 100,
        stop: ["\n", "END"],
        seed: 42,
      });

      const body = capturedBody as Record<string, unknown>;
      expect(body.temperature).toBe(0.7);
      expect(body.max_tokens).toBe(100);
      expect(body.stop).toEqual(["\n", "END"]);
      expect(body.seed).toBe(42);
      expect(body.model).toBe("qwen3-4b");
      expect(body.messages).toEqual([{ role: "user", content: "Hello" }]);
    });

    it("uses default parameters when not specified", async () => {
      let capturedBody: unknown;
      mockFetchWithCapture((_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "chatcmpl-123",
              object: "chat.completion",
              created: 1234567890,
              model: "qwen3-4b",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "test" },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 1,
                total_tokens: 11,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      });

      const gen = new HttpGeneration(
        "http://localhost:8083/v1/chat/completions#qwen3-4b"
      );
      await gen.generate("Hello");

      const body = capturedBody as Record<string, unknown>;
      expect(body.temperature).toBe(0);
      expect(body.max_tokens).toBe(256);
    });
  });

  describe("dispose", () => {
    it("completes without error", async () => {
      const gen = new HttpGeneration(
        "http://localhost:8083/v1/chat/completions#qwen3-4b"
      );
      // dispose() returns Promise<void> - just verify it doesn't throw
      await gen.dispose();
    });
  });
});
