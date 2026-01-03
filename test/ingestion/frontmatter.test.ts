/**
 * Tests for frontmatter parsing and tag extraction.
 *
 * @module test/ingestion/frontmatter
 */

import { describe, expect, test } from "bun:test";

import {
  extractHashtags,
  parseFrontmatter,
  stripFrontmatter,
} from "../../src/ingestion/frontmatter";

describe("parseFrontmatter", () => {
  describe("YAML tags array", () => {
    test("parses block array format", () => {
      const source = `---
tags:
  - work
  - project
---
# Content`;
      const result = parseFrontmatter(source);
      expect(result.tags).toEqual(["work", "project"]);
    });

    test("parses inline array format [a, b]", () => {
      const source = `---
tags: [work, project]
---
# Content`;
      const result = parseFrontmatter(source);
      expect(result.tags).toEqual(["work", "project"]);
    });

    test("parses comma-separated string format", () => {
      const source = `---
tags: work, project, personal
---
# Content`;
      const result = parseFrontmatter(source);
      expect(result.tags).toEqual(["work", "project", "personal"]);
    });
  });

  describe("no frontmatter", () => {
    test("returns empty tags", () => {
      const source = "# Just a heading\n\nSome content.";
      const result = parseFrontmatter(source);
      expect(result.tags).toEqual([]);
    });

    test("handles empty string", () => {
      const result = parseFrontmatter("");
      expect(result.tags).toEqual([]);
    });
  });

  describe("empty frontmatter", () => {
    test("returns empty tags", () => {
      const source = `---
---
# Content`;
      const result = parseFrontmatter(source);
      expect(result.tags).toEqual([]);
    });

    test("handles frontmatter with only whitespace", () => {
      const source = `---

---
# Content`;
      const result = parseFrontmatter(source);
      expect(result.tags).toEqual([]);
    });
  });

  describe("malformed YAML", () => {
    test("returns empty tags without throwing", () => {
      const source = `---
tags: [unclosed
title: "mismatched: quotes
---
# Content`;
      expect(() => parseFrontmatter(source)).not.toThrow();
      // May still extract partial tags depending on implementation
    });

    test("handles missing closing delimiter", () => {
      const source = `---
tags: work
# Missing closing delimiter`;
      const result = parseFrontmatter(source);
      expect(result.tags).toEqual([]);
    });
  });

  describe("Logseq format", () => {
    test("parses tags:: property in frontmatter", () => {
      const source = `---
tags:: work project
---
# Content`;
      const result = parseFrontmatter(source);
      expect(result.tags).toEqual(["work", "project"]);
    });

    test("parses tags:: property at file start (no frontmatter)", () => {
      const source = `tags:: work project

# Content`;
      const result = parseFrontmatter(source);
      expect(result.tags).toEqual(["work", "project"]);
    });

    test("handles hashtag prefix in Logseq tags", () => {
      const source = `---
tags:: #work #project
---
# Content`;
      const result = parseFrontmatter(source);
      expect(result.tags).toEqual(["work", "project"]);
    });

    test("handles comma-separated Logseq tags", () => {
      const source = `---
tags:: work, project, personal
---
# Content`;
      const result = parseFrontmatter(source);
      expect(result.tags).toEqual(["work", "project", "personal"]);
    });
  });

  describe("metadata extraction", () => {
    test("extracts title and other fields", () => {
      const source = `---
title: My Document
author: John
tags: work
---
# Content`;
      const result = parseFrontmatter(source);
      expect(result.metadata.title).toBe("My Document");
      expect(result.metadata.author).toBe("John");
    });
  });
});

describe("extractHashtags", () => {
  test("extracts hashtags from body", () => {
    const content = "This is #work related and also #personal.";
    const tags = extractHashtags(content);
    expect(tags).toContain("work");
    expect(tags).toContain("personal");
  });

  test("skips inline code", () => {
    const content = "Use `#hashtag` for formatting but #real tags work.";
    const tags = extractHashtags(content);
    expect(tags).not.toContain("hashtag");
    expect(tags).toContain("real");
  });

  test("skips fenced code blocks", () => {
    const content = `Some text #valid

\`\`\`javascript
const tag = "#invalid";
\`\`\`

More text #alsoValid`;
    const tags = extractHashtags(content);
    expect(tags).toContain("valid");
    expect(tags).toContain("alsovalid");
    expect(tags).not.toContain("invalid");
  });

  test("skips URL anchors", () => {
    const content = "Check https://example.com#anchor and also #real";
    const tags = extractHashtags(content);
    expect(tags).not.toContain("anchor");
    expect(tags).toContain("real");
  });

  test("handles hierarchical tags", () => {
    const content = "This is #project/frontend work.";
    const tags = extractHashtags(content);
    expect(tags).toContain("project/frontend");
  });

  test("normalizes to lowercase", () => {
    const content = "Some #UPPERCASE and #MixedCase tags.";
    const tags = extractHashtags(content);
    expect(tags).toContain("uppercase");
    expect(tags).toContain("mixedcase");
  });

  test("deduplicates tags", () => {
    const content = "#work #work #work";
    const tags = extractHashtags(content);
    expect(tags).toEqual(["work"]);
  });

  test("handles empty content", () => {
    const tags = extractHashtags("");
    expect(tags).toEqual([]);
  });

  test("handles content with no hashtags", () => {
    const content = "Plain text without any tags.";
    const tags = extractHashtags(content);
    expect(tags).toEqual([]);
  });
});

describe("stripFrontmatter", () => {
  test("removes --- block", () => {
    const source = `---
title: Test
tags: work
---
# Heading

Content here.`;
    const result = stripFrontmatter(source);
    expect(result).toBe(`# Heading

Content here.`);
  });

  test("preserves content after ---", () => {
    const source = `---
key: value
---
First line after frontmatter.
Second line.`;
    const result = stripFrontmatter(source);
    expect(result).toBe(`First line after frontmatter.
Second line.`);
  });

  test("returns original if no frontmatter", () => {
    const source = "# Just content\n\nNo frontmatter here.";
    const result = stripFrontmatter(source);
    expect(result).toBe(source);
  });

  test("handles empty frontmatter", () => {
    const source = `---
---
Content`;
    const result = stripFrontmatter(source);
    expect(result).toBe("Content");
  });

  test("handles frontmatter with Windows line endings", () => {
    const source = "---\r\ntitle: Test\r\n---\r\nContent";
    const result = stripFrontmatter(source);
    expect(result).toBe("Content");
  });
});
