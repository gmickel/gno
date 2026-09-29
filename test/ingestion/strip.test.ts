/**
 * Tests for excluded range detection.
 *
 * @module test/ingestion/strip
 */

import { describe, expect, test } from "bun:test";

import { parseLinks } from "../../src/core/links";
import { buildLineOffsets } from "../../src/ingestion/position";
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

  // The differences the budget introduces. GFM splits table cells at an
  // unescaped pipe even inside backticks, where the table-less parse keeps
  // the span whole; and inline links and inline HTML are not read over the
  // budget, so a backtick inside a link destination or an HTML tag pairs
  // with the next one.
  test.each([
    {
      label: "a code span crossing a table-cell pipe",
      note: "| h | h |\n| - | - |\n| x | `a | b` |\n",
      probe: "a | b",
    },
    {
      label: "a backtick in a link destination",
      note: "[l](u`v) then `w` here\n",
      probe: "v) then",
    },
    {
      label: "a backtick in an inline HTML tag",
      note: 'x <a title="`"> then `w` here\n',
      probe: '"> then',
    },
  ])("over the table budget, $label opens a code span", ({ note, probe }) => {
    const spanAt = (markdown: string) =>
      isExcluded(markdown.indexOf(probe), getExcludedRanges(markdown));
    expect(spanAt(note)).toBe(false);
    expect(spanAt(`${note}${overBudget}`)).toBe(true);
  });

  // Over the table budget a table is one paragraph. An unmatched `]` in every
  // row made code detection grow with the cube of the rows, and an unclosed
  // `[[` in every row made link parsing grow with their square.
  const pivotNote = (cell: string, rows: number): string =>
    [
      "Report from `pivot`.",
      "",
      `| n | v |${" c |".repeat(8)}`,
      `| - | - |${" - |".repeat(8)}`,
      ...Array.from(
        { length: rows },
        (_, row) => `| ${row} | ${cell} |${` ${row % 97} |`.repeat(8)}`
      ),
    ].join("\n");
  const timedPass = (markdown: string): number => {
    const started = performance.now();
    parseLinks(
      markdown,
      buildLineOffsets(markdown),
      getExcludedRanges(markdown)
    );
    return performance.now() - started;
  };
  /**
   * Fastest pass at each size. The sizes alternate, so a slow stretch on a
   * shared runner lands on both instead of inflating only the larger one.
   */
  const fastestPasses = (small: string, large: string) => {
    let fastestSmall = Number.POSITIVE_INFINITY;
    let fastestLarge = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 5; round += 1) {
      fastestSmall = Math.min(fastestSmall, timedPass(small));
      fastestLarge = Math.min(fastestLarge, timedPass(large));
    }
    return { small: fastestSmall, large: fastestLarge };
  };

  test.each(["x]", "[[open"])(
    "code detection and link parsing stay linear with %p in every row",
    (cell) => {
      const { small, large } = fastestPasses(
        pivotNote(cell, 1500),
        pivotNote(cell, 6000)
      );
      // Four times the rows: linear work grows about 4-5x here, quadratic
      // 13-16x (measured on the pre-fn-199 code). 8x splits them with room
      // for runner noise either way; the 25 ms absorbs timer noise.
      expect({ small, large, bounded: large <= 8 * small + 25 }).toEqual({
        small,
        large,
        bounded: true,
      });
    }
  );
});

describe("linear rewrites match their earlier definitions", () => {
  let seed = 199;
  const random = (limit: number): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return Math.floor((seed / 2_147_483_648) * limit);
  };

  test("HTML comments match /<!--[\\s\\S]*?-->/g", () => {
    const pieces = ["<!--", "-->", "<!-->", "-", ">", "a", "\n"];
    for (let sample = 0; sample < 1000; sample += 1) {
      const text = Array.from(
        { length: random(12) },
        () => pieces[random(pieces.length)]
      ).join("");
      const expected = [...text.matchAll(/<!--[\s\S]*?-->/g)].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
        kind: "html_comment" as const,
      }));
      const actual = getExcludedRanges(text).filter(
        (range) => range.kind === "html_comment"
      );
      expect({ text, ranges: actual }).toEqual({ text, ranges: expected });
    }
  });

  test("rangeIntersectsExcluded matches a scan of every range, overlaps included", () => {
    for (let sample = 0; sample < 1000; sample += 1) {
      const ranges = Array.from({ length: random(6) }, () => {
        const start = random(30);
        return {
          start,
          end: start + 1 + random(12),
          kind: "inline_code" as const,
        };
      }).sort((a, b) => a.start - b.start);
      const start = random(40);
      const end = start + 1 + random(8);
      const expected = ranges.some(
        (range) => start < range.end && range.start < end
      );
      expect([
        ranges,
        start,
        end,
        rangeIntersectsExcluded(start, end, ranges),
      ]).toEqual([ranges, start, end, expected]);
    }
  });
});
