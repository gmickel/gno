/**
 * Contract tests for links API schemas.
 */

import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

describe("links-list schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("links-list");
  });

  describe("valid inputs", () => {
    test("validates minimal response", () => {
      const response = {
        links: [],
        meta: {
          docid: "#abc123",
          totalLinks: 0,
          resolvedCount: 0,
          resolutionAvailable: true,
        },
      };
      expect(assertValid(response, schema)).toBe(true);
    });

    test("validates response with wiki link", () => {
      const response = {
        links: [
          {
            targetRef: "Other Note",
            linkType: "wiki",
            startLine: 5,
            startCol: 1,
          },
        ],
        meta: {
          docid: "#abc123",
          totalLinks: 1,
          resolvedCount: 0,
          resolutionAvailable: true,
        },
      };
      expect(assertValid(response, schema)).toBe(true);
    });

    test("validates response with markdown link", () => {
      const response = {
        links: [
          {
            targetRef: "./other.md",
            linkType: "markdown",
            targetAnchor: "section",
            linkText: "click here",
            startLine: 10,
            startCol: 1,
            endLine: 10,
            endCol: 25,
            source: "parsed",
          },
        ],
        meta: {
          docid: "#abc123",
          totalLinks: 1,
          resolvedCount: 0,
          resolutionAvailable: true,
        },
      };
      expect(assertValid(response, schema)).toBe(true);
    });

    test("validates response with type filter", () => {
      const response = {
        links: [
          {
            targetRef: "Wiki Link",
            linkType: "wiki",
            startLine: 1,
            startCol: 1,
          },
        ],
        meta: {
          docid: "#abc123",
          totalLinks: 1,
          resolvedCount: 0,
          resolutionAvailable: true,
          typeFilter: "wiki",
        },
      };
      expect(assertValid(response, schema)).toBe(true);
    });

    test("validates response when resolution unavailable", () => {
      const response = {
        links: [
          {
            targetRef: "Other Note",
            linkType: "wiki",
            startLine: 2,
            startCol: 1,
          },
        ],
        meta: {
          docid: "#abc123",
          totalLinks: 1,
          resolvedCount: 0,
          resolutionAvailable: false,
        },
      };
      expect(assertValid(response, schema)).toBe(true);
    });
  });

  describe("invalid inputs", () => {
    test("rejects missing links array", () => {
      const response = {
        meta: { docid: "#abc123", totalLinks: 0 },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects missing meta object", () => {
      const response = {
        links: [],
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects missing meta.docid", () => {
      const response = {
        links: [],
        meta: { totalLinks: 0 },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects missing meta.totalLinks", () => {
      const response = {
        links: [],
        meta: { docid: "#abc123" },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects link without targetRef", () => {
      const response = {
        links: [{ linkType: "wiki", startLine: 1, startCol: 1 }],
        meta: { docid: "#abc123", totalLinks: 1 },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects link without linkType", () => {
      const response = {
        links: [{ targetRef: "Note", startLine: 1, startCol: 1 }],
        meta: { docid: "#abc123", totalLinks: 1 },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects invalid linkType", () => {
      const response = {
        links: [
          { targetRef: "Note", linkType: "invalid", startLine: 1, startCol: 1 },
        ],
        meta: { docid: "#abc123", totalLinks: 1 },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });
  });
});

describe("backlinks schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("backlinks");
  });

  describe("valid inputs", () => {
    test("validates minimal response", () => {
      const response = {
        backlinks: [],
        meta: { docid: "#abc123", totalBacklinks: 0 },
      };
      expect(assertValid(response, schema)).toBe(true);
    });

    test("validates response with backlinks", () => {
      const response = {
        backlinks: [
          {
            sourceDocid: "#def456",
            sourceUri: "gno://notes/source.md",
            startLine: 10,
            startCol: 5,
          },
          {
            sourceDocid: "#ghi789",
            sourceUri: "gno://notes/another.md",
            sourceTitle: "Another Note",
            linkText: "see also",
            startLine: 20,
            startCol: 1,
          },
        ],
        meta: { docid: "#abc123", totalBacklinks: 2 },
      };
      expect(assertValid(response, schema)).toBe(true);
    });
  });

  describe("invalid inputs", () => {
    test("rejects missing backlinks array", () => {
      const response = {
        meta: { docid: "#abc123", totalBacklinks: 0 },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects missing meta.totalBacklinks", () => {
      const response = {
        backlinks: [],
        meta: { docid: "#abc123" },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects backlink without sourceDocid", () => {
      const response = {
        backlinks: [
          { sourceUri: "gno://notes/source.md", startLine: 10, startCol: 5 },
        ],
        meta: { docid: "#abc123", totalBacklinks: 1 },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects backlink without sourceUri", () => {
      const response = {
        backlinks: [{ sourceDocid: "#def456", startLine: 10, startCol: 5 }],
        meta: { docid: "#abc123", totalBacklinks: 1 },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });
  });
});

describe("similar schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("similar");
  });

  describe("valid inputs", () => {
    test("validates minimal response", () => {
      const response = {
        similar: [],
        meta: { docid: "#abc123", totalResults: 0 },
      };
      expect(assertValid(response, schema)).toBe(true);
    });

    test("validates response with similar docs", () => {
      const response = {
        similar: [
          {
            docid: "#def456",
            uri: "gno://notes/similar.md",
            title: "Similar Note",
            score: 0.85,
            collection: "notes",
          },
          {
            docid: "#ghi789",
            uri: "gno://docs/related.md",
            score: 0.72,
          },
        ],
        meta: {
          docid: "#abc123",
          totalResults: 2,
          threshold: 0.7,
          crossCollection: true,
        },
      };
      expect(assertValid(response, schema)).toBe(true);
    });

    test("validates score at boundaries", () => {
      const response = {
        similar: [
          { docid: "#a", uri: "gno://a", score: 0 },
          { docid: "#b", uri: "gno://b", score: 1 },
        ],
        meta: { docid: "#abc123", totalResults: 2 },
      };
      expect(assertValid(response, schema)).toBe(true);
    });
  });

  describe("invalid inputs", () => {
    test("rejects missing similar array", () => {
      const response = {
        meta: { docid: "#abc123", totalResults: 0 },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects missing meta.totalResults", () => {
      const response = {
        similar: [],
        meta: { docid: "#abc123" },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects similar doc without docid", () => {
      const response = {
        similar: [{ uri: "gno://a", score: 0.8 }],
        meta: { docid: "#abc123", totalResults: 1 },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects similar doc without uri", () => {
      const response = {
        similar: [{ docid: "#a", score: 0.8 }],
        meta: { docid: "#abc123", totalResults: 1 },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects similar doc without score", () => {
      const response = {
        similar: [{ docid: "#a", uri: "gno://a" }],
        meta: { docid: "#abc123", totalResults: 1 },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects score below minimum", () => {
      const response = {
        similar: [{ docid: "#a", uri: "gno://a", score: -0.1 }],
        meta: { docid: "#abc123", totalResults: 1 },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects score above maximum", () => {
      const response = {
        similar: [{ docid: "#a", uri: "gno://a", score: 1.1 }],
        meta: { docid: "#abc123", totalResults: 1 },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });
  });
});
