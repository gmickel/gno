import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

describe("graph-query schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("graph-query");
  });

  test("validates graph query response", () => {
    const response = {
      schemaVersion: "1.0",
      root: {
        id: "#abcdef12",
        uri: "gno://notes/root.md",
        title: "Root",
        collection: "notes",
        relPath: "root.md",
        depth: 0,
        graphHints: ["mentions"],
      },
      nodes: [
        {
          id: "#abcdef12",
          uri: "gno://notes/root.md",
          title: "Root",
          collection: "notes",
          relPath: "root.md",
          depth: 0,
          graphHints: ["mentions"],
        },
      ],
      edges: [],
      meta: {
        direction: "both",
        edgeType: null,
        maxDepth: 2,
        maxNodes: 100,
        frontierLimit: 100,
        visitedLimit: 500,
        returnedNodes: 1,
        returnedEdges: 0,
        truncated: false,
        warnings: [],
      },
    };

    expect(assertValid(response, schema)).toBe(true);
  });

  test("rejects missing schemaVersion", () => {
    const response = {
      root: {
        id: "#abcdef12",
        uri: "gno://notes/root.md",
        title: null,
        collection: "notes",
        relPath: "root.md",
        depth: 0,
        graphHints: [],
      },
      nodes: [],
      edges: [],
      meta: {},
    };

    expect(assertInvalid(response, schema)).toBe(true);
  });
});
