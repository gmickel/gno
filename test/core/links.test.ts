/**
 * Tests for link parsing and normalization.
 *
 * @module test/core/links
 */

import { describe, expect, test } from "bun:test";

import {
  normalizeMarkdownPath,
  normalizeWikiName,
  parseLinks,
  parseTargetParts,
  truncateText,
} from "../../src/core/links";
import { buildLineOffsets } from "../../src/ingestion/position";
import { getExcludedRanges } from "../../src/ingestion/strip";

describe("parseLinks", () => {
  describe("wiki links", () => {
    test("extracts [[Note]] with correct 1-based line and column", () => {
      const markdown = "See [[My Note]] for details.";
      const offsets = buildLineOffsets(markdown);
      const excluded = getExcludedRanges(markdown);
      const links = parseLinks(markdown, offsets, excluded);

      expect(links.length).toBe(1);
      expect(links[0]?.kind).toBe("wiki");
      expect(links[0]?.targetRef).toBe("My Note");
      expect(links[0]?.startLine).toBe(1);
      expect(links[0]?.startCol).toBe(5); // 'See ' = 4 chars, link starts at col 5
    });

    test("extracts multiple links from same line with distinct columns", () => {
      const markdown = "Link [[A]] and [[B]] here.";
      const offsets = buildLineOffsets(markdown);
      const excluded = getExcludedRanges(markdown);
      const links = parseLinks(markdown, offsets, excluded);

      expect(links.length).toBe(2);
      expect(links[0]?.targetRef).toBe("A");
      expect(links[1]?.targetRef).toBe("B");
      expect(links[0]?.startCol).toBeLessThan(links[1]!.startCol);
    });

    test("extracts [[Note|Alias]] with display text", () => {
      const markdown = "Check [[Meeting Notes|Notes]] today.";
      const offsets = buildLineOffsets(markdown);
      const excluded = getExcludedRanges(markdown);
      const links = parseLinks(markdown, offsets, excluded);

      expect(links.length).toBe(1);
      expect(links[0]?.targetRef).toBe("Meeting Notes");
      expect(links[0]?.displayText).toBe("Notes");
    });

    test("does not set displayText when same as target", () => {
      const markdown = "Check [[Note|Note]] today.";
      const offsets = buildLineOffsets(markdown);
      const excluded = getExcludedRanges(markdown);
      const links = parseLinks(markdown, offsets, excluded);

      expect(links.length).toBe(1);
      expect(links[0]?.targetRef).toBe("Note");
      expect(links[0]?.displayText).toBeUndefined();
    });

    test("extracts [[Note#Section]] with anchor", () => {
      const markdown = "See [[Guide#Installation]] for setup.";
      const offsets = buildLineOffsets(markdown);
      const excluded = getExcludedRanges(markdown);
      const links = parseLinks(markdown, offsets, excluded);

      expect(links.length).toBe(1);
      expect(links[0]?.targetRef).toBe("Guide");
      expect(links[0]?.targetAnchor).toBe("Installation");
    });

    test("extracts [[collection:Note]] with collection prefix", () => {
      const markdown = "From [[docs:Getting Started]] guide.";
      const offsets = buildLineOffsets(markdown);
      const excluded = getExcludedRanges(markdown);
      const links = parseLinks(markdown, offsets, excluded);

      expect(links.length).toBe(1);
      expect(links[0]?.targetRef).toBe("Getting Started");
      expect(links[0]?.targetCollection).toBe("docs");
    });

    test("extracts [[collection:Note#Section]] with all parts", () => {
      const markdown = "See [[wiki:FAQ#Billing]] for help.";
      const offsets = buildLineOffsets(markdown);
      const excluded = getExcludedRanges(markdown);
      const links = parseLinks(markdown, offsets, excluded);

      expect(links.length).toBe(1);
      expect(links[0]?.targetRef).toBe("FAQ");
      expect(links[0]?.targetAnchor).toBe("Billing");
      expect(links[0]?.targetCollection).toBe("wiki");
    });

    test("skips wiki links inside code blocks", () => {
      const markdown = `Some text

\`\`\`markdown
This [[Code Link]] should be ignored.
\`\`\`

But [[Real Link]] works.`;
      const offsets = buildLineOffsets(markdown);
      const excluded = getExcludedRanges(markdown);
      const links = parseLinks(markdown, offsets, excluded);

      expect(links.length).toBe(1);
      expect(links[0]?.targetRef).toBe("Real Link");
    });

    test("skips wiki links inside inline code", () => {
      const markdown = "Use `[[syntax]]` for linking. Real [[Link]] here.";
      const offsets = buildLineOffsets(markdown);
      const excluded = getExcludedRanges(markdown);
      const links = parseLinks(markdown, offsets, excluded);

      expect(links.length).toBe(1);
      expect(links[0]?.targetRef).toBe("Link");
    });

    test("skips wiki links inside HTML comments", () => {
      const markdown = "Before <!-- [[Hidden Link]] --> after [[Visible]].";
      const offsets = buildLineOffsets(markdown);
      const excluded = getExcludedRanges(markdown);
      const links = parseLinks(markdown, offsets, excluded);

      expect(links.length).toBe(1);
      expect(links[0]?.targetRef).toBe("Visible");
    });
  });

  describe("markdown links", () => {
    test("extracts [text](path.md) markdown links", () => {
      const markdown = "See [the guide](./docs/guide.md) for info.";
      const offsets = buildLineOffsets(markdown);
      const excluded = getExcludedRanges(markdown);
      const links = parseLinks(markdown, offsets, excluded);

      expect(links.length).toBe(1);
      expect(links[0]?.kind).toBe("markdown");
      expect(links[0]?.targetRef).toBe("./docs/guide.md");
      expect(links[0]?.displayText).toBe("the guide");
    });

    test("extracts [text](path.md#anchor) with anchor", () => {
      const markdown = "Check [setup](./install.md#prerequisites) first.";
      const offsets = buildLineOffsets(markdown);
      const excluded = getExcludedRanges(markdown);
      const links = parseLinks(markdown, offsets, excluded);

      expect(links.length).toBe(1);
      expect(links[0]?.targetRef).toBe("./install.md");
      expect(links[0]?.targetAnchor).toBe("prerequisites");
    });

    test("ignores external URLs", () => {
      const markdown =
        "Visit [Google](https://google.com) and [local](./page.md).";
      const offsets = buildLineOffsets(markdown);
      const excluded = getExcludedRanges(markdown);
      const links = parseLinks(markdown, offsets, excluded);

      expect(links.length).toBe(1);
      expect(links[0]?.targetRef).toBe("./page.md");
    });

    test("ignores mailto links", () => {
      const markdown = "Email [us](mailto:test@example.com) for help.";
      const offsets = buildLineOffsets(markdown);
      const excluded = getExcludedRanges(markdown);
      const links = parseLinks(markdown, offsets, excluded);

      expect(links.length).toBe(0);
    });

    test("ignores protocol-relative URLs", () => {
      const markdown = "See [CDN](//cdn.example.com/file.js) for assets.";
      const offsets = buildLineOffsets(markdown);
      const excluded = getExcludedRanges(markdown);
      const links = parseLinks(markdown, offsets, excluded);

      expect(links.length).toBe(0);
    });

    test("ignores image links", () => {
      const markdown = "Image: ![alt](./image.png) and [link](./page.md).";
      const offsets = buildLineOffsets(markdown);
      const excluded = getExcludedRanges(markdown);
      const links = parseLinks(markdown, offsets, excluded);

      expect(links.length).toBe(1);
      expect(links[0]?.targetRef).toBe("./page.md");
    });

    test("ignores anchor-only links", () => {
      const markdown = "Jump to [section](#heading) below.";
      const offsets = buildLineOffsets(markdown);
      const excluded = getExcludedRanges(markdown);
      const links = parseLinks(markdown, offsets, excluded);

      expect(links.length).toBe(0);
    });

    test("skips markdown links inside code blocks", () => {
      const markdown = `Text before

\`\`\`
[code link](ignored.md)
\`\`\`

Real [link](page.md).`;
      const offsets = buildLineOffsets(markdown);
      const excluded = getExcludedRanges(markdown);
      const links = parseLinks(markdown, offsets, excluded);

      expect(links.length).toBe(1);
      expect(links[0]?.targetRef).toBe("page.md");
    });

    test("skips markdown links inside inline code", () => {
      const markdown = "Use `[text](link.md)` syntax. Real [link](page.md).";
      const offsets = buildLineOffsets(markdown);
      const excluded = getExcludedRanges(markdown);
      const links = parseLinks(markdown, offsets, excluded);

      expect(links.length).toBe(1);
      expect(links[0]?.targetRef).toBe("page.md");
    });

    test("skips markdown links inside HTML comments", () => {
      const markdown =
        "Before <!-- [hidden](secret.md) --> after [visible](page.md).";
      const offsets = buildLineOffsets(markdown);
      const excluded = getExcludedRanges(markdown);
      const links = parseLinks(markdown, offsets, excluded);

      expect(links.length).toBe(1);
      expect(links[0]?.targetRef).toBe("page.md");
    });
  });

  describe("mixed content", () => {
    test("extracts both wiki and markdown links", () => {
      const markdown = "See [[Wiki Note]] and [md link](./page.md).";
      const offsets = buildLineOffsets(markdown);
      const excluded = getExcludedRanges(markdown);
      const links = parseLinks(markdown, offsets, excluded);

      expect(links.length).toBe(2);
      expect(links.find((l) => l.kind === "wiki")?.targetRef).toBe("Wiki Note");
      expect(links.find((l) => l.kind === "markdown")?.targetRef).toBe(
        "./page.md"
      );
    });

    test("sorts links by position", () => {
      const markdown = "[later](b.md) and [[A]] at start [[B]].";
      const offsets = buildLineOffsets(markdown);
      const excluded = getExcludedRanges(markdown);
      const links = parseLinks(markdown, offsets, excluded);

      expect(links.length).toBe(3);
      // First link is markdown [later](b.md)
      expect(links[0]?.kind).toBe("markdown");
      // Then wiki links in order
      expect(links[1]?.targetRef).toBe("A");
      expect(links[2]?.targetRef).toBe("B");
    });
  });

  describe("edge cases", () => {
    test("returns empty on empty input", () => {
      const links = parseLinks("", [0], []);
      expect(links).toEqual([]);
    });

    test("returns empty on content with no links", () => {
      const markdown = "Just plain text without any links.";
      const offsets = buildLineOffsets(markdown);
      const excluded = getExcludedRanges(markdown);
      const links = parseLinks(markdown, offsets, excluded);

      expect(links).toEqual([]);
    });

    test("handles malformed links gracefully", () => {
      const markdown = "Unclosed [[link and [text](";
      const offsets = buildLineOffsets(markdown);
      const excluded = getExcludedRanges(markdown);
      const links = parseLinks(markdown, offsets, excluded);

      expect(links).toEqual([]);
    });
  });

  describe("multi-line positions", () => {
    test("correctly tracks line numbers across multiple lines", () => {
      const markdown = `Line 1
[[Link on Line 2]]
Line 3
[MD link](file.md)`;
      const offsets = buildLineOffsets(markdown);
      const excluded = getExcludedRanges(markdown);
      const links = parseLinks(markdown, offsets, excluded);

      expect(links.length).toBe(2);
      expect(links[0]?.startLine).toBe(2);
      expect(links[1]?.startLine).toBe(4);
    });
  });
});

describe("parseTargetParts", () => {
  test("parses simple name", () => {
    const parts = parseTargetParts("Note");
    expect(parts.ref).toBe("Note");
    expect(parts.anchor).toBeUndefined();
    expect(parts.collection).toBeUndefined();
  });

  test("parses name with anchor", () => {
    const parts = parseTargetParts("Note#Section");
    expect(parts.ref).toBe("Note");
    expect(parts.anchor).toBe("Section");
  });

  test("parses name with collection", () => {
    const parts = parseTargetParts("docs:Note");
    expect(parts.ref).toBe("Note");
    expect(parts.collection).toBe("docs");
  });

  test("parses all parts together", () => {
    const parts = parseTargetParts("wiki:FAQ#Billing");
    expect(parts.ref).toBe("FAQ");
    expect(parts.anchor).toBe("Billing");
    expect(parts.collection).toBe("wiki");
  });

  test("handles empty anchor", () => {
    const parts = parseTargetParts("Note#");
    expect(parts.ref).toBe("Note");
    expect(parts.anchor).toBeUndefined();
  });

  test("handles whitespace", () => {
    const parts = parseTargetParts("  My Note  ");
    expect(parts.ref).toBe("My Note");
  });

  test("normalizes collection to lowercase", () => {
    const parts = parseTargetParts("Docs:Note");
    expect(parts.collection).toBe("docs");
    expect(parts.ref).toBe("Note");
  });
});

describe("normalizeMarkdownPath", () => {
  test("resolves ../ relative to source dir", () => {
    const result = normalizeMarkdownPath("../sibling.md", "subdir/source.md");
    expect(result).toBe("sibling.md");
  });

  test("resolves nested ../ paths", () => {
    const result = normalizeMarkdownPath("../../top.md", "a/b/source.md");
    expect(result).toBe("top.md");
  });

  test("returns null for escape attempt", () => {
    const result = normalizeMarkdownPath("../../../escape.md", "a/source.md");
    expect(result).toBeNull();
  });

  test("resolves ./ paths", () => {
    const result = normalizeMarkdownPath("./sibling.md", "dir/source.md");
    expect(result).toBe("dir/sibling.md");
  });

  test("resolves simple relative paths", () => {
    const result = normalizeMarkdownPath("sibling.md", "dir/source.md");
    expect(result).toBe("dir/sibling.md");
  });

  test("decodes %20 but not %2F", () => {
    const result = normalizeMarkdownPath("my%20file.md", "dir/source.md");
    expect(result).toBe("dir/my file.md");
  });

  test("does not decode unsafe percent codes", () => {
    const result = normalizeMarkdownPath("path%2Ffile.md", "dir/source.md");
    // %2F is unsafe, so the whole path is returned undecoded
    expect(result).toBe("dir/path%2Ffile.md");
  });

  test("rejects absolute paths", () => {
    const result = normalizeMarkdownPath("/absolute/path.md", "dir/source.md");
    expect(result).toBeNull();
  });

  test("rejects backslash paths", () => {
    const result = normalizeMarkdownPath("dir\\file.md", "source.md");
    expect(result).toBeNull();
  });
});

describe("normalizeWikiName", () => {
  test("applies NFC normalization", () => {
    // é composed (NFC) vs e + combining acute (NFD)
    const nfd = "caf\u0065\u0301"; // e + combining acute
    const nfc = "caf\u00e9"; // precomposed é
    expect(normalizeWikiName(nfd)).toBe(normalizeWikiName(nfc));
  });

  test("converts to lowercase", () => {
    expect(normalizeWikiName("My Note")).toBe("my note");
    expect(normalizeWikiName("UPPERCASE")).toBe("uppercase");
  });

  test("trims whitespace", () => {
    expect(normalizeWikiName("  Note  ")).toBe("note");
  });

  test("handles unicode characters", () => {
    expect(normalizeWikiName("日本語")).toBe("日本語");
    expect(normalizeWikiName("Ü")).toBe("ü");
  });
});

describe("truncateText", () => {
  test("returns text unchanged if under limit", () => {
    expect(truncateText("hello", 10)).toBe("hello");
  });

  test("truncates at grapheme boundary", () => {
    expect(truncateText("hello world", 5)).toBe("hello");
  });

  test("handles emoji correctly", () => {
    const emoji = "👨‍👩‍👧‍👦"; // Family emoji (1 grapheme, multiple code points)
    // This is actually multiple code points combined
    expect(truncateText(emoji + emoji, 1).length).toBeGreaterThan(0);
  });

  test("handles empty string", () => {
    expect(truncateText("", 10)).toBe("");
  });

  test("handles exact length", () => {
    expect(truncateText("12345", 5)).toBe("12345");
  });
});
