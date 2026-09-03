/**
 * Static contract tests for the shared memory output schemas
 * (spec/output-schemas/memory-remember.schema.json + memory-recall.schema.json).
 * Fixtures are hand-written; the live cross-surface proof is memory-contract.test.ts.
 */

import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

const SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const URI = "gno://memory/project-gno/2026/09/mem-abc.md";

const fact = {
  uri: URI,
  docid: "#abc123",
  recordId: "mem-abc",
  text: "Finn likes trains.",
  scopes: ["project:gno"],
  caller: "codex",
  session: "session-1",
  createdAt: "2026-09-03T10:00:00.000Z",
  contentHash: SHA,
  supersedes: [],
};

const lineage = {
  effectivePolicy: "local_only",
  digest: SHA,
  sources: [{ collection: "memory", policy: "local_only", source: "explicit" }],
};

const receipt = {
  caller: "codex",
  session: "session-1",
  issuedAt: "2026-09-03T10:00:01.000Z",
  memoryIds: ["#abc123"],
  spanHashes: [SHA],
  digest: SHA,
};

describe("memory-remember schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("memory-remember");
  });

  test.each([
    [
      "added",
      {
        outcome: "added",
        record: { ...fact, source: "Said in standup 2026-09-03" },
        absPath: "/tmp/memory/mem-abc.md",
        sync: { status: "completed" },
        matching: {
          mode: "lexical",
          semanticUnavailable: "no embedding model available",
          threshold: 0.5,
        },
      },
    ],
    [
      "superseded",
      {
        outcome: "superseded",
        record: { ...fact, supersedes: [URI] },
        absPath: "/tmp/memory/mem-def.md",
        sync: { status: "completed" },
        matching: { mode: "semantic", threshold: 0.83 },
      },
    ],
    [
      "existing",
      {
        outcome: "existing",
        record: fact,
        matching: { mode: "lexical", threshold: 0.5 },
      },
    ],
    [
      "candidates",
      {
        outcome: "candidates",
        candidates: [{ ...fact, similarity: 0.7, match: "likely" }],
        matching: { mode: "lexical", threshold: 0.5 },
      },
    ],
  ])("accepts the %s outcome", (_label, result) => {
    expect(assertValid(result, schema)).toBe(true);
  });

  test.each([
    [
      "unknown outcome",
      {
        outcome: "merged",
        record: fact,
        matching: { mode: "lexical", threshold: 0.5 },
      },
    ],
    [
      "added without sync",
      {
        outcome: "added",
        record: fact,
        absPath: "/tmp/x.md",
        matching: { mode: "lexical", threshold: 0.5 },
      },
    ],
    [
      "record without scopes",
      {
        outcome: "existing",
        record: { ...fact, scopes: [] },
        matching: { mode: "lexical", threshold: 0.5 },
      },
    ],
    [
      "record without caller identity",
      {
        outcome: "existing",
        record: { ...fact, caller: "" },
        matching: { mode: "lexical", threshold: 0.5 },
      },
    ],
    [
      "record with empty source evidence",
      {
        outcome: "existing",
        record: { ...fact, source: "" },
        matching: { mode: "lexical", threshold: 0.5 },
      },
    ],
    [
      "candidate without match class",
      {
        outcome: "candidates",
        candidates: [{ ...fact, similarity: 0.7 }],
        matching: { mode: "lexical", threshold: 0.5 },
      },
    ],
  ])("rejects %s", (_label, result) => {
    expect(assertInvalid(result, schema)).toBe(true);
  });
});

describe("memory-recall schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("memory-recall");
  });

  const recalled = {
    ...fact,
    source: "Said in standup 2026-09-03",
    score: 0.016,
    spanHash: SHA,
    egressLineage: lineage,
  };

  test("accepts a populated recall", () => {
    expect(
      assertValid(
        {
          facts: [recalled],
          receipt,
          budget: { maxFacts: 8, maxTokens: 512, usedTokens: 5, omitted: 0 },
          retrieval: { mode: "hybrid" },
          egressLineage: lineage,
        },
        schema
      )
    ).toBe(true);
  });

  test("accepts an empty recall with the self-teaching hint", () => {
    expect(
      assertValid(
        {
          facts: [],
          receipt: { ...receipt, memoryIds: [], spanHashes: [] },
          budget: { maxFacts: 8, maxTokens: 512, usedTokens: 0, omitted: 0 },
          retrieval: {
            mode: "lexical",
            semanticUnavailable: "no embedding model available",
          },
          hint: 'No memories in scope yet. Store one with: gno remember "<fact>" --scope <scope> --decision add',
        },
        schema
      )
    ).toBe(true);
  });

  test.each([
    [
      "fact without egressLineage",
      {
        facts: [{ ...fact, score: 0.016, spanHash: SHA }],
        receipt,
        budget: { maxFacts: 8, maxTokens: 512, usedTokens: 5, omitted: 0 },
        retrieval: { mode: "lexical" },
      },
    ],
    [
      "receipt without session identity",
      {
        facts: [recalled],
        receipt: { ...receipt, session: undefined },
        budget: { maxFacts: 8, maxTokens: 512, usedTokens: 5, omitted: 0 },
        retrieval: { mode: "lexical" },
      },
    ],
    [
      "missing receipt",
      {
        facts: [],
        budget: { maxFacts: 8, maxTokens: 512, usedTokens: 0, omitted: 0 },
        retrieval: { mode: "lexical" },
      },
    ],
    [
      "unknown retrieval mode",
      {
        facts: [],
        receipt,
        budget: { maxFacts: 8, maxTokens: 512, usedTokens: 0, omitted: 0 },
        retrieval: { mode: "rerank" },
      },
    ],
  ])("rejects %s", (_label, result) => {
    expect(assertInvalid(result, schema)).toBe(true);
  });
});
