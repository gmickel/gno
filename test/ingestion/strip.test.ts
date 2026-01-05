/**
 * Tests for excluded range detection.
 *
 * @module test/ingestion/strip
 */

import { describe, expect, test } from "bun:test";

import {
  getExcludedRanges,
  isExcluded,
  rangeIntersectsExcluded,
} from "../../src/ingestion/strip";

describe("getExcludedRanges", () => {
  describe("frontmatter", () => {
    test("identifies YAML frontmatter at start", () => {
      const markdown = `---
title: Test
---
Content here`;
      const ranges = getExcludedRanges(markdown);
      const frontmatter = ranges.find((r) => r.kind === "frontmatter");
      expect(frontmatter).toBeDefined();
      expect(frontmatter?.start).toBe(0);
      expect(markdown.slice(frontmatter!.start, frontmatter!.end)).toContain(
        "---"
      );
    });

    test("does not match frontmatter not at start", () => {
      const markdown = `Some content
---
not: frontmatter
---`;
      const ranges = getExcludedRanges(markdown);
      const frontmatter = ranges.find((r) => r.kind === "frontmatter");
      expect(frontmatter).toBeUndefined();
    });

    test("handles Windows line endings", () => {
      const markdown = "---\r\ntitle: Test\r\n---\r\nContent";
      const ranges = getExcludedRanges(markdown);
      const frontmatter = ranges.find((r) => r.kind === "frontmatter");
      expect(frontmatter).toBeDefined();
    });
  });

  describe("fenced code blocks", () => {
    test("identifies fenced code blocks", () => {
      const markdown = `Text before
\`\`\`javascript
const x = 1;
\`\`\`
Text after`;
      const ranges = getExcludedRanges(markdown);
      const code = ranges.find((r) => r.kind === "fenced_code");
      expect(code).toBeDefined();
      const codeText = markdown.slice(code!.start, code!.end);
      expect(codeText).toContain("```javascript");
      expect(codeText).toContain("const x = 1;");
    });

    test("identifies multiple fenced code blocks", () => {
      const markdown = `\`\`\`js
code1
\`\`\`

\`\`\`python
code2
\`\`\``;
      const ranges = getExcludedRanges(markdown);
      const codeBlocks = ranges.filter((r) => r.kind === "fenced_code");
      expect(codeBlocks.length).toBe(2);
    });

    test("handles unclosed code blocks", () => {
      const markdown = `\`\`\`javascript
unclosed code
no closing fence`;
      const ranges = getExcludedRanges(markdown);
      const codeBlocks = ranges.filter((r) => r.kind === "fenced_code");
      expect(codeBlocks.length).toBe(0);
    });
  });

  describe("inline code", () => {
    test("identifies inline code", () => {
      const markdown = "Use `code here` for inline.";
      const ranges = getExcludedRanges(markdown);
      const inline = ranges.find((r) => r.kind === "inline_code");
      expect(inline).toBeDefined();
      expect(markdown.slice(inline!.start, inline!.end)).toBe("`code here`");
    });

    test("identifies multiple inline code spans", () => {
      const markdown = "Use `one` and `two` and `three`.";
      const ranges = getExcludedRanges(markdown);
      const inlines = ranges.filter((r) => r.kind === "inline_code");
      expect(inlines.length).toBe(3);
    });

    test("does not match unclosed backticks", () => {
      const markdown = "This is `not closed";
      const ranges = getExcludedRanges(markdown);
      const inlines = ranges.filter((r) => r.kind === "inline_code");
      expect(inlines.length).toBe(0);
    });
  });

  describe("HTML comments", () => {
    test("identifies HTML comments", () => {
      const markdown = "Text <!-- comment --> more text";
      const ranges = getExcludedRanges(markdown);
      const comment = ranges.find((r) => r.kind === "html_comment");
      expect(comment).toBeDefined();
      expect(markdown.slice(comment!.start, comment!.end)).toBe(
        "<!-- comment -->"
      );
    });

    test("identifies multi-line HTML comments", () => {
      const markdown = `Text
<!--
Multi-line
comment
-->
more text`;
      const ranges = getExcludedRanges(markdown);
      const comment = ranges.find((r) => r.kind === "html_comment");
      expect(comment).toBeDefined();
      expect(markdown.slice(comment!.start, comment!.end)).toContain(
        "Multi-line"
      );
    });
  });

  describe("sorting", () => {
    test("ranges are sorted by start position", () => {
      const markdown = `---
fm: true
---

Text \`inline\` and more

<!-- comment -->

\`\`\`js
code
\`\`\``;
      const ranges = getExcludedRanges(markdown);
      for (let i = 1; i < ranges.length; i++) {
        expect(ranges[i]!.start).toBeGreaterThanOrEqual(ranges[i - 1]!.start);
      }
    });
  });

  describe("empty/edge cases", () => {
    test("handles empty string", () => {
      const ranges = getExcludedRanges("");
      expect(ranges).toEqual([]);
    });

    test("handles string with no excluded regions", () => {
      const markdown = "Just plain text with no special regions.";
      const ranges = getExcludedRanges(markdown);
      expect(ranges.length).toBe(0);
    });
  });
});

describe("isExcluded", () => {
  test("returns true for offset inside range", () => {
    const ranges = [
      { start: 10, end: 20, kind: "inline_code" as const },
      { start: 30, end: 40, kind: "fenced_code" as const },
    ];
    expect(isExcluded(15, ranges)).toBe(true);
    expect(isExcluded(35, ranges)).toBe(true);
  });

  test("returns false for offset outside range", () => {
    const ranges = [
      { start: 10, end: 20, kind: "inline_code" as const },
      { start: 30, end: 40, kind: "fenced_code" as const },
    ];
    expect(isExcluded(5, ranges)).toBe(false);
    expect(isExcluded(25, ranges)).toBe(false);
    expect(isExcluded(45, ranges)).toBe(false);
  });

  test("returns true for offset at start of range (inclusive)", () => {
    const ranges = [{ start: 10, end: 20, kind: "inline_code" as const }];
    expect(isExcluded(10, ranges)).toBe(true);
  });

  test("returns false for offset at end of range (exclusive)", () => {
    const ranges = [{ start: 10, end: 20, kind: "inline_code" as const }];
    expect(isExcluded(20, ranges)).toBe(false);
  });

  test("returns false for empty ranges", () => {
    expect(isExcluded(10, [])).toBe(false);
  });
});

describe("rangeIntersectsExcluded", () => {
  test("returns true when range overlaps", () => {
    const excluded = [{ start: 10, end: 20, kind: "inline_code" as const }];
    expect(rangeIntersectsExcluded(5, 15, excluded)).toBe(true);
    expect(rangeIntersectsExcluded(15, 25, excluded)).toBe(true);
    expect(rangeIntersectsExcluded(12, 18, excluded)).toBe(true);
  });

  test("returns false when range does not overlap", () => {
    const excluded = [{ start: 10, end: 20, kind: "inline_code" as const }];
    expect(rangeIntersectsExcluded(0, 10, excluded)).toBe(false);
    expect(rangeIntersectsExcluded(20, 30, excluded)).toBe(false);
    expect(rangeIntersectsExcluded(0, 5, excluded)).toBe(false);
  });

  test("returns true when range contains excluded", () => {
    const excluded = [{ start: 10, end: 20, kind: "inline_code" as const }];
    expect(rangeIntersectsExcluded(5, 25, excluded)).toBe(true);
  });

  test("returns true when excluded contains range", () => {
    const excluded = [{ start: 10, end: 20, kind: "inline_code" as const }];
    expect(rangeIntersectsExcluded(12, 18, excluded)).toBe(true);
  });

  test("returns false for empty excluded ranges", () => {
    expect(rangeIntersectsExcluded(0, 10, [])).toBe(false);
  });
});
