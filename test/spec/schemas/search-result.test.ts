import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

describe("search-result schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("search-result");
  });

  describe("valid inputs", () => {
    test("validates minimal valid result", () => {
      const result = {
        docid: "#a1b2c3",
        score: 0.78,
        uri: "gno://work/doc.md",
        snippet: "sample text",
        source: {
          relPath: "doc.md",
          mime: "text/markdown",
          ext: ".md",
        },
      };
      expect(assertValid(result, schema)).toBe(true);
    });

    test("validates full result with all optional fields", async () => {
      const fixture = await Bun.file(
        "test/fixtures/outputs/search-result-valid.json"
      ).json();
      expect(assertValid(fixture, schema)).toBe(true);
    });

    test("validates minimal fixture", async () => {
      const fixture = await Bun.file(
        "test/fixtures/outputs/search-result-minimal.json"
      ).json();
      expect(assertValid(fixture, schema)).toBe(true);
    });

    test("validates score at boundaries", () => {
      const result = {
        docid: "#abc123",
        score: 0,
        uri: "gno://work/doc.md",
        snippet: "text",
        source: { relPath: "doc.md", mime: "text/markdown", ext: ".md" },
      };
      expect(assertValid(result, schema)).toBe(true);

      result.score = 1;
      expect(assertValid(result, schema)).toBe(true);
    });

    test("validates 8-char docid", () => {
      const result = {
        docid: "#a1b2c3d4",
        score: 0.5,
        uri: "gno://work/doc.md",
        snippet: "text",
        source: { relPath: "doc.md", mime: "text/markdown", ext: ".md" },
      };
      expect(assertValid(result, schema)).toBe(true);
    });

    test("validates indexed URI and line field", () => {
      const result = {
        docid: "#abc123",
        score: 0.5,
        uri: "gno://work/doc.md?index=research",
        line: 42,
        snippet: "text",
        source: { relPath: "doc.md", mime: "text/markdown", ext: ".md" },
      };
      expect(assertValid(result, schema)).toBe(true);
    });
  });

  describe("invalid inputs", () => {
    test("rejects missing docid", () => {
      const result = {
        score: 0.5,
        uri: "gno://work/doc.md",
        snippet: "text",
        source: { relPath: "doc.md", mime: "text/markdown", ext: ".md" },
      };
      expect(assertInvalid(result, schema)).toBe(true);
    });

    test("rejects invalid docid format - missing hash", () => {
      const result = {
        docid: "invalid",
        score: 0.5,
        uri: "gno://work/doc.md",
        snippet: "text",
        source: { relPath: "doc.md", mime: "text/markdown", ext: ".md" },
      };
      expect(assertInvalid(result, schema)).toBe(true);
    });

    test("rejects invalid docid format - too short", () => {
      const result = {
        docid: "#abc",
        score: 0.5,
        uri: "gno://work/doc.md",
        snippet: "text",
        source: { relPath: "doc.md", mime: "text/markdown", ext: ".md" },
      };
      expect(assertInvalid(result, schema)).toBe(true);
    });

    test("rejects score below 0", () => {
      const result = {
        docid: "#abc123",
        score: -0.1,
        uri: "gno://work/doc.md",
        snippet: "text",
        source: { relPath: "doc.md", mime: "text/markdown", ext: ".md" },
      };
      expect(assertInvalid(result, schema)).toBe(true);
    });

    test("rejects score above 1", () => {
      const result = {
        docid: "#abc123",
        score: 1.5,
        uri: "gno://work/doc.md",
        snippet: "text",
        source: { relPath: "doc.md", mime: "text/markdown", ext: ".md" },
      };
      expect(assertInvalid(result, schema)).toBe(true);
    });

    test("rejects invalid uri scheme", () => {
      const result = {
        docid: "#abc123",
        score: 0.5,
        uri: "file:///path/doc.md",
        snippet: "text",
        source: { relPath: "doc.md", mime: "text/markdown", ext: ".md" },
      };
      expect(assertInvalid(result, schema)).toBe(true);
    });

    test("rejects uri without path", () => {
      const result = {
        docid: "#abc123",
        score: 0.5,
        uri: "gno://work",
        snippet: "text",
        source: { relPath: "doc.md", mime: "text/markdown", ext: ".md" },
      };
      expect(assertInvalid(result, schema)).toBe(true);
    });

    test("rejects missing source", () => {
      const result = {
        docid: "#abc123",
        score: 0.5,
        uri: "gno://work/doc.md",
        snippet: "text",
      };
      expect(assertInvalid(result, schema)).toBe(true);
    });

    test("rejects source missing required fields", () => {
      const result = {
        docid: "#abc123",
        score: 0.5,
        uri: "gno://work/doc.md",
        snippet: "text",
        source: { relPath: "doc.md" },
      };
      expect(assertInvalid(result, schema)).toBe(true);
    });

    test("rejects invalid ext format - missing dot", () => {
      const result = {
        docid: "#abc123",
        score: 0.5,
        uri: "gno://work/doc.md",
        snippet: "text",
        source: { relPath: "doc.md", mime: "text/markdown", ext: "md" },
      };
      expect(assertInvalid(result, schema)).toBe(true);
    });

    test("rejects negative sizeBytes", () => {
      const result = {
        docid: "#abc123",
        score: 0.5,
        uri: "gno://work/doc.md",
        snippet: "text",
        source: {
          relPath: "doc.md",
          mime: "text/markdown",
          ext: ".md",
          sizeBytes: -1,
        },
      };
      expect(assertInvalid(result, schema)).toBe(true);
    });

    test("rejects invalid snippetRange startLine", () => {
      const result = {
        docid: "#abc123",
        score: 0.5,
        uri: "gno://work/doc.md",
        snippet: "text",
        snippetRange: { startLine: 0, endLine: 10 },
        source: { relPath: "doc.md", mime: "text/markdown", ext: ".md" },
      };
      expect(assertInvalid(result, schema)).toBe(true);
    });
  });
});
