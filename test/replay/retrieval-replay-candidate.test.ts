import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { EmbeddingPort } from "../../src/llm/types";
import type { SearchResults } from "../../src/pipeline/types";
import type { VectorIndexPort } from "../../src/store/vector/types";

import { createDefaultConfig } from "../../src/config";
import { retrievalReplayTraceMetadata } from "../../src/core/retrieval-replay-candidate";
import { SEARCH_RESULTS_TRACE_METADATA } from "../../src/pipeline/types";
import { ok } from "../../src/store/types";
import {
  createReplayTestHarness,
  type ReplayTestHarness,
} from "./retrieval-replay-fixture";

const emptyResults = (
  mode: SearchResults["meta"]["mode"],
  vectorsUsed = false
): SearchResults => ({
  results: [],
  meta: { query: "candidate", mode, vectorsUsed, totalResults: 0 },
});

describe("retrieval replay candidates", () => {
  let harness: ReplayTestHarness;

  beforeEach(async () => {
    harness = await createReplayTestHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  test("uses the persisted limit for a zero-hit baseline and finds missing evidence", async () => {
    const { service, exportId } = await harness.buildZeroHitReceipt();
    const replayed = await service.replay(
      {
        exportId,
        candidate: { id: "zero-hit-bm25", type: "bm25" },
      },
      {
        config: createDefaultConfig(),
        vectorIndex: null,
        embedPort: null,
        expandPort: null,
        rerankPort: null,
        indexName: "default",
      }
    );
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value).toMatchObject({
      verdict: "improved",
      recommendation: "promote",
      applied: false,
      cases: [
        {
          verdict: "improved",
          metrics: {
            baseline: { recallAtK: 0 },
            candidate: {
              precisionAtK: 0.2,
              recallAtK: 1,
              mrr: 1,
              ndcgAtK: 1,
            },
            baselineCoverage: 0,
            candidateCoverage: 1,
          },
          capabilityOutcomes: {
            candidate: [{ capability: "lexical_search", status: "used" }],
          },
          qrels: [
            {
              label: "missing_expected",
              baselineRank: null,
              candidateRank: 1,
            },
          ],
        },
      ],
    });
  });

  test("projects truthful BM25, vector, and degraded hybrid capability outcomes", () => {
    expect(
      retrievalReplayTraceMetadata(
        { id: "bm25", type: "bm25" },
        emptyResults("bm25")
      )
    ).toEqual({
      capabilityOutcomes: [{ capability: "lexical_search", status: "used" }],
      fallbackCodes: [],
    });
    expect(
      retrievalReplayTraceMetadata(
        { id: "vector", type: "vector" },
        emptyResults("vector", true)
      )
    ).toEqual({
      capabilityOutcomes: [{ capability: "semantic_search", status: "used" }],
      fallbackCodes: [],
    });
    expect(
      retrievalReplayTraceMetadata(
        { id: "hybrid-fallback", type: "hybrid" },
        emptyResults("bm25_only")
      )
    ).toEqual({
      capabilityOutcomes: [
        { capability: "lexical_search", status: "used" },
        {
          capability: "semantic_search",
          status: "unavailable",
          reasonCode: "vector_unavailable",
        },
      ],
      fallbackCodes: ["vector_unavailable"],
    });
  });

  test("preserves explicit hybrid capability and fallback metadata", () => {
    const metadata = {
      capabilityOutcomes: [
        { capability: "lexical_search", status: "used" as const },
        {
          capability: "semantic_search",
          status: "failed" as const,
          reasonCode: "vector_embed_error",
        },
      ],
      fallbackCodes: ["vector_embed_error"],
    };
    const results = emptyResults("bm25_only");
    Object.defineProperty(results, SEARCH_RESULTS_TRACE_METADATA, {
      enumerable: false,
      value: metadata,
    });
    expect(
      retrievalReplayTraceMetadata({ id: "hybrid", type: "hybrid" }, results)
    ).toBe(metadata);
  });

  test("applies URI-prefix scope before ranking more than 100 distractors", async () => {
    const { service, exportId } = await harness.buildReceipt({
      filters: {
        collection: "notes",
        uriPrefix: "gno://notes/projects",
        limit: 5,
      },
    });
    for (let index = 0; index < 125; index += 1) {
      await harness.indexDocument(
        "notes",
        `outside/distractor-${index}.md`,
        `${"Alpha decision ".repeat(20)}distractor ${index}`
      );
    }
    await harness.indexDocument(
      "notes",
      "projects2/sibling.md",
      "Alpha decision ".repeat(30)
    );
    const replayed = await service.replay(
      {
        exportId,
        candidate: { id: "prefix-bm25", type: "bm25" },
      },
      {
        config: createDefaultConfig(),
        vectorIndex: null,
        embedPort: null,
        expandPort: null,
        rerankPort: null,
        indexName: "default",
      }
    );
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(
      replayed.value.cases[0]?.qrels.find((qrel) => qrel.label === "relevant")
    ).toMatchObject({
      candidateRank: 1,
      sourceState: "unchanged",
    });
  });

  test("treats a collection-root URI prefix as BM25 collection scope", async () => {
    const { service, exportId } = await harness.buildReceipt({
      traceId: "root-prefix-bm25",
      filters: {
        collection: "notes",
        uriPrefix: "gno://notes",
        limit: 5,
      },
    });
    const replayed = await service.replay(
      {
        exportId,
        candidate: { id: "root-prefix-bm25", type: "bm25" },
      },
      {
        config: createDefaultConfig(),
        vectorIndex: null,
        embedPort: null,
        expandPort: null,
        rerankPort: null,
        indexName: "default",
      }
    );
    expect(replayed.ok).toBeTrue();
    if (!replayed.ok) return;
    expect(
      replayed.value.cases[0]?.qrels.find((qrel) => qrel.label === "relevant")
        ?.candidateRank
    ).toBe(1);
  });

  test("keeps vector and hybrid candidates inside collection-root scope", async () => {
    const { service, exportId } = await harness.buildReceipt({
      traceId: "root-prefix-semantic",
      filters: {
        collection: "notes",
        uriPrefix: "gno://notes/",
        limit: 5,
      },
    });
    const document = await harness.store.getDocumentByUri(
      "gno://notes/projects/decision.md"
    );
    if (!document.ok || !document.value?.mirrorHash) {
      throw new Error("target document missing");
    }
    const mirrorHash = document.value.mirrorHash;
    const observedAllowLists: string[][] = [];
    const vectorIndex = {
      searchAvailable: true,
      model: "test-model",
      dimensions: 2,
      vecDirty: false,
      searchNearest: async (
        _embedding: Float32Array,
        _limit: number,
        options?: { allowedMirrorHashes?: string[] }
      ) => {
        observedAllowLists.push(options?.allowedMirrorHashes ?? []);
        return ok([{ mirrorHash, seq: 0, distance: 0 }]);
      },
    } as unknown as VectorIndexPort;
    const embedPort = {
      modelUri: "test-model",
      init: async () => ({ ok: true, value: undefined }) as const,
      embed: async () => ({ ok: true, value: [1, 0] }) as const,
      embedBatch: async (texts: string[]) =>
        ({ ok: true, value: texts.map(() => [1, 0]) }) as const,
      dimensions: () => 2,
      dispose: async () => undefined,
    } satisfies EmbeddingPort;
    for (const type of ["vector", "hybrid"] as const) {
      const replayed = await service.replay(
        {
          exportId,
          candidate: {
            id: `root-prefix-${type}`,
            type,
            noExpand: true,
            noRerank: true,
          },
        },
        {
          config: createDefaultConfig(),
          vectorIndex,
          embedPort,
          expandPort: null,
          rerankPort: null,
          indexName: "default",
        }
      );
      expect(replayed.ok).toBeTrue();
      if (!replayed.ok) continue;
      expect(
        replayed.value.cases[0]?.qrels.find((qrel) => qrel.label === "relevant")
          ?.candidateRank
      ).toBe(1);
    }
    expect(observedAllowLists.length).toBeGreaterThanOrEqual(2);
    expect(
      observedAllowLists.every((hashes) => hashes.includes(mirrorHash))
    ).toBeTrue();
  });
});
