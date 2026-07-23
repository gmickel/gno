import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

const snapshot = {
  relPath: "plan.md",
  docid: "#abcdef12",
  uri: "gno://notes/plan.md",
  sourceHash: "source-a",
  mirrorHash: "mirror-a",
  active: true,
};

const structureDelta = {
  headings: { added: ["# Plan"], removed: [] },
  links: { added: [], removed: [] },
  typedEdges: { added: [], removed: [] },
  dates: { added: [], removed: [], changed: [] },
  truncated: false,
};

const change = {
  id: "opaque-change",
  kind: "create",
  collection: "notes",
  observedAt: "2026-07-23T12:00:00.000Z",
  previous: null,
  current: snapshot,
  structureDelta,
};

describe("knowledge delta schemas", () => {
  let changesSchema: object;
  let diffSchema: object;
  let impactSchema: object;

  beforeAll(async () => {
    changesSchema = await loadSchema("changes");
    diffSchema = await loadSchema("document-diff");
    impactSchema = await loadSchema("impact");
  });

  test("validates changes and explicit retention metadata", () => {
    expect(
      assertValid(
        {
          schemaVersion: "1.0",
          changes: [change],
          page: {
            nextCursor: null,
            earliestCursor: "earliest",
            latestCursor: "latest",
            cursorExpired: false,
            truncated: false,
            retentionTruncated: false,
          },
          warnings: [],
        },
        changesSchema
      )
    ).toBe(true);
  });

  test("validates metadata-only diff states", () => {
    expect(
      assertValid(
        {
          schemaVersion: "1.0",
          status: "available",
          document: {
            id: snapshot.docid,
            uri: snapshot.uri,
            title: "Plan",
            collection: "notes",
            relPath: snapshot.relPath,
            active: true,
          },
          change,
          content: {
            status: "not_retained",
            reason: "journal_metadata_only",
          },
          history: { status: "available", reason: null },
          warnings: [],
        },
        diffSchema
      )
    ).toBe(true);
  });

  test("validates impact evidence paths and rejects missing caps", () => {
    const result = {
      schemaVersion: "1.0",
      root: {
        id: "#abcdef12",
        uri: "gno://notes/root.md",
        title: "Root",
        collection: "notes",
        relPath: "root.md",
      },
      impacted: [
        {
          document: {
            id: "#defabc12",
            uri: "gno://notes/source.md",
            title: "Source",
            collection: "notes",
            relPath: "source.md",
          },
          depth: 1,
          evidencePath: [
            {
              source: {
                id: "#defabc12",
                uri: "gno://notes/source.md",
              },
              target: {
                id: "#abcdef12",
                uri: "gno://notes/root.md",
              },
              edgeType: "mentions",
              relationType: "mentions",
              confidence: "parsed",
              edgeSource: "wikilink",
            },
          ],
        },
      ],
      meta: {
        maxDepth: 3,
        maxNodes: 100,
        maxEdges: 250,
        frontierLimit: 100,
        visitedLimit: 500,
        returnedNodes: 2,
        returnedEdges: 1,
        truncated: false,
        warnings: [],
      },
    };
    expect(assertValid(result, impactSchema)).toBe(true);
    const { maxEdges: _, ...incompleteMeta } = result.meta;
    expect(
      assertInvalid({ ...result, meta: incompleteMeta }, impactSchema)
    ).toBe(true);
  });
});
