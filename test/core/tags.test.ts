/**
 * Tests for tag utilities.
 *
 * @module test/core/tags
 */

import { describe, expect, test } from "bun:test";

import { normalizeTag, parseTagFilter, validateTag } from "../../src/core/tags";

describe("normalizeTag", () => {
  test("trims whitespace and lowercases", () => {
    expect(normalizeTag("  Work  ")).toBe("work");
  });

  test("NFC normalizes unicode", () => {
    // Café with composed é vs decomposed e + combining acute
    expect(normalizeTag("Café")).toBe("café");
  });

  test("preserves unicode letters after lowercase", () => {
    expect(normalizeTag("日本語")).toBe("日本語");
  });

  test("handles mixed case and whitespace", () => {
    expect(normalizeTag("  MiXeD CaSe  ")).toBe("mixed case");
  });

  test("handles empty string", () => {
    expect(normalizeTag("")).toBe("");
  });

  test("handles only whitespace", () => {
    expect(normalizeTag("   ")).toBe("");
  });
});

describe("validateTag", () => {
  describe("valid tags", () => {
    test("simple hyphenated tag", () => {
      expect(validateTag("valid-tag")).toBe(true);
    });

    test("tag with dots", () => {
      expect(validateTag("valid.tag")).toBe(true);
    });

    test("hierarchical tag (single level)", () => {
      expect(validateTag("parent/child")).toBe(true);
    });

    test("hierarchical tag (deep)", () => {
      expect(validateTag("parent/child/deep")).toBe(true);
    });

    test("numeric tag", () => {
      expect(validateTag("2024")).toBe(true);
    });

    test("alphanumeric tag", () => {
      expect(validateTag("project-123")).toBe(true);
    });

    test("unicode letters", () => {
      expect(validateTag("日本語")).toBe(true);
    });

    test("mixed unicode and ascii", () => {
      expect(validateTag("日本語-test")).toBe(true);
    });

    test("german umlaut", () => {
      expect(validateTag("größe")).toBe(true);
    });
  });

  describe("invalid tags", () => {
    test("uppercase letters", () => {
      expect(validateTag("UPPER")).toBe(false);
    });

    test("contains space", () => {
      expect(validateTag("has space")).toBe(false);
    });

    test("contains percent", () => {
      expect(validateTag("has%percent")).toBe(false);
    });

    test("trailing slash", () => {
      expect(validateTag("trail/")).toBe(false);
    });

    test("leading slash", () => {
      expect(validateTag("/lead")).toBe(false);
    });

    test("double slash (empty segment)", () => {
      expect(validateTag("double//slash")).toBe(false);
    });

    test("empty string", () => {
      expect(validateTag("")).toBe(false);
    });

    test("contains underscore", () => {
      expect(validateTag("has_underscore")).toBe(false);
    });

    test("contains at symbol", () => {
      expect(validateTag("has@symbol")).toBe(false);
    });

    test("contains hash", () => {
      expect(validateTag("has#hash")).toBe(false);
    });

    test("only dots", () => {
      expect(validateTag("...")).toBe(false);
    });

    test("starts with dot", () => {
      expect(validateTag(".hidden")).toBe(false);
    });

    test("starts with hyphen", () => {
      expect(validateTag("-invalid")).toBe(false);
    });
  });
});

describe("parseTagFilter", () => {
  test("parses comma-separated tags", () => {
    expect(parseTagFilter("a,b,c")).toEqual(["a", "b", "c"]);
  });

  test("trims whitespace around tags", () => {
    expect(parseTagFilter("a, b, c")).toEqual(["a", "b", "c"]);
  });

  test("handles extra whitespace", () => {
    expect(parseTagFilter("  a  ,  b  ,  c  ")).toEqual(["a", "b", "c"]);
  });

  test("returns empty array for empty string", () => {
    expect(parseTagFilter("")).toEqual([]);
  });

  test("returns empty array for whitespace only", () => {
    expect(parseTagFilter("   ")).toEqual([]);
  });

  test("filters out empty segments from consecutive commas", () => {
    expect(parseTagFilter("a,,b")).toEqual(["a", "b"]);
  });

  test("normalizes tags (lowercase)", () => {
    expect(parseTagFilter("Work,PERSONAL,Mixed")).toEqual([
      "work",
      "personal",
      "mixed",
    ]);
  });

  test("handles hierarchical tags", () => {
    expect(parseTagFilter("project/frontend,project/backend")).toEqual([
      "project/frontend",
      "project/backend",
    ]);
  });
});
