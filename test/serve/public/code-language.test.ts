import { describe, expect, test } from "bun:test";

import { highlightCode } from "../../../src/serve/public/components/ai-elements/code-block";
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

  test("extracts hyphenated language ids from markdown classes", () => {
    expect(extractMarkdownCodeLanguage("language-objective-c")).toBe(
      "objective-c"
    );
  });

  test("highlighting unsupported fence ids does not throw", async () => {
    const [light, dark] = await highlightCode("- [ ] Ship patch", "tasks");

    expect(light).toContain("shiki");
    expect(dark).toContain("shiki");
  });
});
