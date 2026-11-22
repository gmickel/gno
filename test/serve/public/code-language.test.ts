import { describe, expect, test } from "bun:test";

import { highlightCodeDualTheme } from "../../../src/serve/public/components/ai-elements/code-block";
import {
  extractMarkdownCodeLanguage,
  resolveCodeLanguage,
} from "../../../src/serve/public/lib/code-language";

describe("code language normalization", () => {
  test("maps obsidian tasks fences to markdown", () => {
    expect(resolveCodeLanguage("tasks")).toBe("markdown");
  });

  test("falls back to text for unknown languages", () => {
    expect(resolveCodeLanguage("definitely-unknown")).toBe("text");
  });

  test("accepts allowlisted language ids without importing grammars", () => {
    expect(resolveCodeLanguage("rust")).toBe("rust");
    expect(resolveCodeLanguage("js")).toBe("javascript");
  });

  test("extracts hyphenated language ids from markdown classes", () => {
    expect(extractMarkdownCodeLanguage("language-objective-c")).toBe(
      "objective-c"
    );
  });

  test("highlighting unsupported fence ids does not throw", async () => {
    const html = await highlightCodeDualTheme("- [ ] Ship patch", "tasks");

    expect(html).toContain("shiki");
    expect(html).toContain("--shiki-dark:");
  });

  test("unknown fence language highlights as text without throw", async () => {
    const html = await highlightCodeDualTheme("plain", "definitely-unknown");
    expect(html).toContain("shiki");
  });
});
