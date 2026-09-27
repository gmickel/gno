/**
 * Tests for excluded range detection.
 *
 * @module test/ingestion/strip
 */

import { describe, expect, test } from "bun:test";

import {
  getExcludedRanges,
  isExcluded,
  MAX_PARSED_TABLE_CELLS,
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
      expect(codeBlocks).toHaveLength(1);
      expect(markdown.slice(codeBlocks[0]!.start, codeBlocks[0]!.end)).toBe(
        markdown
      );
    });

    test("identifies CommonMark tilde fences with matching closer length", () => {
      const markdown = `before
~~~md
![secret](../escape.png)
~~~
after
~~~~long
![also](x.png)
~~~
still open
~~~~
done`;
      const ranges = getExcludedRanges(markdown);
      const codeBlocks = ranges.filter((r) => r.kind === "fenced_code");
      expect(codeBlocks.length).toBe(2);
      expect(
        markdown.slice(codeBlocks[0]!.start, codeBlocks[0]!.end)
      ).toContain("~~~md");
      expect(
        markdown.slice(codeBlocks[0]!.start, codeBlocks[0]!.end)
      ).toContain("../escape.png");
      expect(
        markdown.slice(codeBlocks[1]!.start, codeBlocks[1]!.end)
      ).toContain("~~~~long");
      // Shorter ~~~ must not close the ~~~~ opener early.
      expect(
        markdown.slice(codeBlocks[1]!.start, codeBlocks[1]!.end)
      ).toContain("still open");
    });

    test("does not close backtick fences with tilde closers", () => {
      const markdown = "```\n![x](a.png)\n~~~\n";
      const ranges = getExcludedRanges(markdown);
      const fenced = ranges.filter((r) => r.kind === "fenced_code");
      expect(fenced).toHaveLength(1);
      expect(markdown.slice(fenced[0]!.start, fenced[0]!.end)).toBe(markdown);
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

    test("matches equal-length delimiters across inner backtick runs", () => {
      const markdown = "Use `` ` ![x](../secret.png) ` `` safely.";
      const ranges = getExcludedRanges(markdown);
      const inline = ranges.find((range) => range.kind === "inline_code");
      expect(markdown.slice(inline!.start, inline!.end)).toBe(
        "`` ` ![x](../secret.png) ` ``"
      );
    });

    test("does not pair unmatched fenced backticks with later prose", () => {
      const markdown = [
        "~~~md",
        "unmatched `",
        "~~~",
        "visible [link](note.md)",
        "then `code`",
      ].join("\n");
      const ranges = getExcludedRanges(markdown);
      const inlines = ranges.filter((range) => range.kind === "inline_code");

      expect(inlines).toHaveLength(1);
      expect(markdown.slice(inlines[0]!.start, inlines[0]!.end)).toBe("`code`");
      expect(
        rangeIntersectsExcluded(
          markdown.indexOf("[link]"),
          markdown.indexOf("[link]") + "[link]".length,
          ranges
        )
      ).toBe(false);
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

describe("code-region parse budget (fn-198)", () => {
  const tableBlock = (rows: number): string =>
    [
      "| a | b | c | d |",
      "| --- | --- | --- | --- |",
      ...Array.from(
        { length: rows },
        (_, row) => `| row ${row} | \`code ${row}\` | text | 1.5 |`
      ),
    ].join("\n");
  const overBudget = `\n\n${tableBlock(Math.ceil(MAX_PARSED_TABLE_CELLS / 5) + 1)}\n`;

  test("a spreadsheet-sized table stays fast and keeps code spans excluded", () => {
    // 20,000 rows: with the GFM table extension this took minutes.
    const markdown = tableBlock(20_000);
    const spans = getExcludedRanges(markdown).filter(
      (range) => range.kind === "inline_code"
    );
    expect(spans).toHaveLength(20_000);
    expect(markdown.slice(spans[0]!.start, spans[0]!.end)).toBe("`code 0`");
  });

  test.each([
    {
      label: "fences inside frontmatter and HTML comments open no code block",
      note: "---\nexample: |\n  ```\n---\n<!-- ```\n-->\n\n[[real-link]]\n",
      targets: { "[[real-link]]": false },
    },
    {
      label:
        "code spans never pair across paragraphs; a backslash does not escape a closing backtick",
      note: "A lone ` backtick.\n\n[[para-link]] follows.\n\nPath `C:\\dir\\` then [[after-path]].\n",
      targets: {
        "[[para-link]]": false,
        "[[after-path]]": false,
        "C:\\dir\\": true,
      },
    },
    {
      label: "fences inside a blockquote are code",
      note: "> ~~~\n> [[example-only]]\n> ~~~\n\n[[outside]]\n",
      targets: { "[[example-only]]": true, "[[outside]]": false },
    },
  ])("$label, below and above the table budget", ({ note, targets }) => {
    for (const markdown of [note, `${note}${overBudget}`]) {
      const ranges = getExcludedRanges(markdown);
      for (const [target, excluded] of Object.entries(targets)) {
        expect([target, isExcluded(markdown.indexOf(target), ranges)]).toEqual([
          target,
          excluded,
        ]);
      }
    }
  });

  test("over the table budget, a code span may cross a table-cell pipe", () => {
    // GFM splits table cells at an unescaped pipe even inside backticks;
    // without the table extension the span is kept whole. This is the only
    // difference the budget introduces.
    const row = "| x | `a | b` |";
    const note = `| h | h |\n| - | - |\n${row}\n`;
    const spanAt = (markdown: string) =>
      isExcluded(markdown.indexOf("`a | b`") + 1, getExcludedRanges(markdown));
    expect(spanAt(note)).toBe(false);
    expect(spanAt(`${note}${overBudget}`)).toBe(true);
  });
});
