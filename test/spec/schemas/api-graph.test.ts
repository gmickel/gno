/**
 * Contract tests for graph API schema.
 */

import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

describe("graph schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("graph");
  });

  function report(overrides: Record<string, unknown> = {}) {
    return {
      hubs: [],
      bridgeCandidates: [],
      isolated: { total: 0, examples: [] },
      unresolvedLinks: { total: 0, byType: { wiki: 0, markdown: 0 } },
      edgeTypes: { wiki: 0, markdown: 0, similar: 0 },
      edgeConfidence: { explicit: 0, inferred: 0, ambiguous: 0, similarity: 0 },
      audit: { inferredEdges: 0, ambiguousEdges: 0, similarityEdges: 0 },
      ...overrides,
    };
  }

  describe("valid inputs", () => {
    test("validates minimal response", () => {
      const response = {
        nodes: [],
        links: [],
        report: report(),
        meta: {
          collection: null,
          nodeLimit: 2000,
          edgeLimit: 10000,
          totalNodes: 0,
          totalEdges: 0,
          totalEdgesUnresolved: 0,
          returnedNodes: 0,
          returnedEdges: 0,
          truncated: false,
          linkedOnly: true,
          includedSimilar: false,
          similarAvailable: false,
          similarTopK: 5,
          similarTruncatedByComputeBudget: false,
          warnings: [],
        },
      };
      expect(assertValid(response, schema)).toBe(true);
    });

    test("validates response with nodes and links", () => {
      const response = {
        nodes: [
          {
            id: "#abc123",
            uri: "gno://notes/doc1.md",
            title: "Document 1",
            collection: "notes",
            relPath: "doc1.md",
            degree: 3,
          },
          {
            id: "#def456",
            uri: "gno://notes/doc2.md",
            title: null,
            collection: "notes",
            relPath: "doc2.md",
            degree: 1,
          },
        ],
        links: [
          {
            source: "#abc123",
            target: "#def456",
            type: "wiki",
            weight: 2,
            confidence: "explicit",
            audit: { resolution: "exact-title", matchCount: 1 },
          },
        ],
        report: report({
          hubs: [
            {
              id: "#abc123",
              uri: "gno://notes/doc1.md",
              title: "Document 1",
              collection: "notes",
              relPath: "doc1.md",
              degree: 3,
            },
          ],
          bridgeCandidates: [
            {
              id: "#abc123",
              uri: "gno://notes/doc1.md",
              title: "Document 1",
              collection: "notes",
              relPath: "doc1.md",
              degree: 3,
            },
          ],
          edgeTypes: { wiki: 1, markdown: 0, similar: 0 },
        }),
        meta: {
          collection: "notes",
          nodeLimit: 2000,
          edgeLimit: 10000,
          totalNodes: 2,
          totalEdges: 1,
          totalEdgesUnresolved: 0,
          returnedNodes: 2,
          returnedEdges: 1,
          truncated: false,
          linkedOnly: true,
          includedSimilar: false,
          similarAvailable: true,
          similarTopK: 5,
          similarTruncatedByComputeBudget: false,
          warnings: [],
        },
      };
      expect(assertValid(response, schema)).toBe(true);
    });

    test("validates response with similarity links", () => {
      const response = {
        nodes: [
          {
            id: "#abc123",
            uri: "gno://notes/doc1.md",
            title: "Doc 1",
            collection: "notes",
            relPath: "doc1.md",
            degree: 2,
          },
          {
            id: "#def456",
            uri: "gno://notes/doc2.md",
            title: "Doc 2",
            collection: "notes",
            relPath: "doc2.md",
            degree: 2,
          },
        ],
        links: [
          {
            source: "#abc123",
            target: "#def456",
            type: "markdown",
            weight: 1,
            confidence: "explicit",
            audit: { resolution: "exact-path", matchCount: 1 },
          },
          {
            source: "#abc123",
            target: "#def456",
            type: "similar",
            weight: 0.85,
            confidence: "similarity",
            audit: { resolution: "similarity", score: 0.85 },
          },
        ],
        report: report({
          edgeTypes: { wiki: 0, markdown: 1, similar: 1 },
          edgeConfidence: {
            explicit: 1,
            inferred: 0,
            ambiguous: 0,
            similarity: 1,
          },
          audit: { inferredEdges: 0, ambiguousEdges: 0, similarityEdges: 1 },
        }),
        meta: {
          collection: null,
          nodeLimit: 2000,
          edgeLimit: 10000,
          totalNodes: 2,
          totalEdges: 2,
          totalEdgesUnresolved: 0,
          returnedNodes: 2,
          returnedEdges: 2,
          truncated: false,
          linkedOnly: true,
          includedSimilar: true,
          similarAvailable: true,
          similarTopK: 5,
          similarTruncatedByComputeBudget: false,
          warnings: [],
        },
      };
      expect(assertValid(response, schema)).toBe(true);
    });

    test("validates truncated response with warnings", () => {
      const response = {
        nodes: [
          {
            id: "#abc123",
            uri: "gno://notes/doc1.md",
            title: "Doc",
            collection: "notes",
            relPath: "doc1.md",
            degree: 0,
          },
        ],
        links: [],
        report: report({
          isolated: {
            total: 400,
            examples: [
              {
                id: "#def456",
                uri: "gno://notes/isolated.md",
                title: "Isolated",
                collection: "notes",
                relPath: "isolated.md",
                degree: 0,
              },
            ],
          },
          unresolvedLinks: {
            total: 10,
            byType: { wiki: 7, markdown: 3 },
          },
        }),
        meta: {
          collection: null,
          nodeLimit: 100,
          edgeLimit: 1000,
          totalNodes: 500,
          totalEdges: 2000,
          totalEdgesUnresolved: 10,
          returnedNodes: 100,
          returnedEdges: 1000,
          truncated: true,
          linkedOnly: false,
          includedSimilar: false,
          similarAvailable: false,
          similarTopK: 5,
          similarTruncatedByComputeBudget: false,
          warnings: [
            "Nodes truncated: 500 → 100",
            "Edges truncated: 2000 → 1000",
          ],
        },
      };
      expect(assertValid(response, schema)).toBe(true);
    });
  });

  describe("invalid inputs", () => {
    test("rejects missing nodes array", () => {
      const response = {
        links: [],
        meta: {
          collection: null,
          nodeLimit: 2000,
          edgeLimit: 10000,
          totalNodes: 0,
          totalEdges: 0,
          totalEdgesUnresolved: 0,
          returnedNodes: 0,
          returnedEdges: 0,
          truncated: false,
          linkedOnly: true,
          includedSimilar: false,
          similarAvailable: false,
          similarTopK: 5,
          similarTruncatedByComputeBudget: false,
          warnings: [],
        },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects missing links array", () => {
      const response = {
        nodes: [],
        meta: {
          collection: null,
          nodeLimit: 2000,
          edgeLimit: 10000,
          totalNodes: 0,
          totalEdges: 0,
          totalEdgesUnresolved: 0,
          returnedNodes: 0,
          returnedEdges: 0,
          truncated: false,
          linkedOnly: true,
          includedSimilar: false,
          similarAvailable: false,
          similarTopK: 5,
          similarTruncatedByComputeBudget: false,
          warnings: [],
        },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects missing meta object", () => {
      const response = {
        nodes: [],
        links: [],
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects node without id", () => {
      const response = {
        nodes: [
          {
            uri: "gno://notes/doc.md",
            title: "Doc",
            collection: "notes",
            relPath: "doc.md",
            degree: 0,
          },
        ],
        links: [],
        meta: {
          collection: null,
          nodeLimit: 2000,
          edgeLimit: 10000,
          totalNodes: 1,
          totalEdges: 0,
          totalEdgesUnresolved: 0,
          returnedNodes: 1,
          returnedEdges: 0,
          truncated: false,
          linkedOnly: true,
          includedSimilar: false,
          similarAvailable: false,
          similarTopK: 5,
          similarTruncatedByComputeBudget: false,
          warnings: [],
        },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects link without source", () => {
      const response = {
        nodes: [],
        links: [{ target: "#def456", type: "wiki", weight: 1 }],
        meta: {
          collection: null,
          nodeLimit: 2000,
          edgeLimit: 10000,
          totalNodes: 0,
          totalEdges: 1,
          totalEdgesUnresolved: 0,
          returnedNodes: 0,
          returnedEdges: 1,
          truncated: false,
          linkedOnly: true,
          includedSimilar: false,
          similarAvailable: false,
          similarTopK: 5,
          similarTruncatedByComputeBudget: false,
          warnings: [],
        },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects invalid link type", () => {
      const response = {
        nodes: [],
        links: [
          { source: "#abc123", target: "#def456", type: "invalid", weight: 1 },
        ],
        meta: {
          collection: null,
          nodeLimit: 2000,
          edgeLimit: 10000,
          totalNodes: 0,
          totalEdges: 1,
          totalEdgesUnresolved: 0,
          returnedNodes: 0,
          returnedEdges: 1,
          truncated: false,
          linkedOnly: true,
          includedSimilar: false,
          similarAvailable: false,
          similarTopK: 5,
          similarTruncatedByComputeBudget: false,
          warnings: [],
        },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects negative weight", () => {
      const response = {
        nodes: [],
        links: [
          { source: "#abc123", target: "#def456", type: "wiki", weight: -1 },
        ],
        meta: {
          collection: null,
          nodeLimit: 2000,
          edgeLimit: 10000,
          totalNodes: 0,
          totalEdges: 1,
          totalEdgesUnresolved: 0,
          returnedNodes: 0,
          returnedEdges: 1,
          truncated: false,
          linkedOnly: true,
          includedSimilar: false,
          similarAvailable: false,
          similarTopK: 5,
          similarTruncatedByComputeBudget: false,
          warnings: [],
        },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects missing required meta fields", () => {
      const response = {
        nodes: [],
        links: [],
        meta: {
          collection: null,
          // Missing most required fields
          nodeLimit: 2000,
        },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });
  });
});
