import { describe, expect, test } from "bun:test";

import { resolveGenContextSize } from "../../src/llm/nodeLlamaCpp/generation";

// Regression for issue #189: local generation never set contextSize, so
// node-llama-cpp fell back to "auto" and grew the KV cache to fill all
// available VRAM. The resolver must always produce a bounded size.
describe("resolveGenContextSize", () => {
  test("sizes the context to prompt + output + margin", () => {
    expect(
      resolveGenContextSize({
        promptTokenCount: 3000,
        maxTokens: 512,
        trainContextSize: 262_144,
      })
    ).toBe(3000 + 512 + 512);
  });

  test("never returns less than the minimum context size", () => {
    expect(
      resolveGenContextSize({
        promptTokenCount: 10,
        maxTokens: 32,
        trainContextSize: 262_144,
      })
    ).toBe(1024);
  });

  test("caps at the model's trained context size", () => {
    expect(
      resolveGenContextSize({
        promptTokenCount: 70_000,
        maxTokens: 512,
        trainContextSize: 32_768,
      })
    ).toBe(32_768);
  });

  test("handles unknown trained context size", () => {
    expect(
      resolveGenContextSize({
        promptTokenCount: 5000,
        maxTokens: 256,
      })
    ).toBe(5000 + 256 + 512);
  });

  test("ignores non-positive trained context size", () => {
    expect(
      resolveGenContextSize({
        promptTokenCount: 5000,
        maxTokens: 256,
        trainContextSize: 0,
      })
    ).toBe(5000 + 256 + 512);
  });
});
