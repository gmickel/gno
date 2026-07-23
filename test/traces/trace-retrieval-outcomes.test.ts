import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises: temporary directory creation has no Bun equivalent.
import { mkdtemp } from "node:fs/promises";
// node:os and node:path: Bun has no equivalent temp/path helpers.
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AnswerGenerationResult } from "../../src/pipeline/answer";
import type { SearchResult, SearchResults } from "../../src/pipeline/types";

import { RetrievalTraceSession } from "../../src/core/retrieval-trace-session";
import { processAnswerResultWithTrace } from "../../src/pipeline/answer";
import {
  CITATION_TRACE_METADATA,
  SEARCH_RESULT_PLANNER_METADATA,
  SEARCH_RESULTS_TRACE_METADATA,
} from "../../src/pipeline/types";
import {
  RETRIEVAL_TRACE_HEADER,
  withRetrievalTraceHeader,
} from "../../src/serve/retrieval-trace";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const PASSAGE = "complete first line\ncomplete second line";
const PASSAGE_HASH = new Bun.CryptoHasher("sha256")
  .update(PASSAGE)
  .digest("hex");
const enabledConfig = {
  enabled: true,
  redactionMode: "replay",
  retention: {
    maxAgeDays: 30,
    maxTraces: 100,
    maxRecordsPerTrace: 100,
    maxBytes: 1024 * 1024,
  },
} as const;

const searchResults = (): SearchResults => ({
  results: [
    {
      docid: "#abcdef",
      score: 0.9,
      uri: "gno://notes/exact.md",
      snippet: "presentation may differ",
      snippetRange: { startLine: 10, endLine: 11 },
      source: {
        relPath: "exact.md",
        mime: "text/markdown",
        ext: ".md",
        sourceHash: HASH_A,
      },
      conversion: { mirrorHash: HASH_B },
      [SEARCH_RESULT_PLANNER_METADATA]: {
        retrievalRank: 7,
        mirrorHash: HASH_B,
        seq: 3,
        sources: ["bm25", "graph"],
        graphExpanded: true,
        startLine: 10,
        endLine: 11,
        passageHash: PASSAGE_HASH,
      },
    },
  ],
  meta: {
    query: "exact",
    mode: "hybrid",
    vectorsUsed: true,
    reranked: true,
    totalResults: 1,
    graphExpansion: {
      enabled: true,
      seedCount: 1,
      candidateCount: 1,
      maxCandidates: 10,
      edgeConfidence: {
        explicit: 1,
        inferred: 0,
        ambiguous: 0,
        similarity: 0,
      },
      fallbackReasons: [],
    },
  },
});

const exactEvidence = {
  docid: "#abcdef",
  sourceHash: HASH_A,
  mirrorHash: HASH_B,
  uri: "gno://notes/exact.md",
  seq: 3,
  startLine: 10,
  endLine: 11,
  passageHash: PASSAGE_HASH,
  rank: 1,
  plannerRank: 7,
  sources: ["bm25", "graph"],
  graphExpanded: true,
};

describe("retrieval trace outcomes", () => {
  let testDir = "";
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-trace-outcomes-"));
    adapter = new SqliteAdapter();
    expect(
      (await adapter.open(join(testDir, "index.sqlite"), "unicode61")).ok
    ).toBeTrue();
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  test("records final rank separately from planner rank without serializing metadata", async () => {
    const result = searchResults();
    const publicBytes = JSON.stringify(result);
    expect(publicBytes).not.toContain("passageHash");
    expect(publicBytes).not.toContain("retrievalRank");

    const started = await RetrievalTraceSession.start({
      store: adapter,
      config: enabledConfig,
      query: "exact",
      filters: { collection: "notes" },
      idFactory: () => "trace-propagation",
      clock: () => 1_000,
      fingerprints: () => ({
        pipeline: HASH_A,
        model: HASH_B,
        config: HASH_C,
        index: HASH_D,
      }),
    });
    expect(started.ok).toBeTrue();
    if (!started.ok || !started.value) throw new Error("trace did not start");
    const retrieval = await started.value.recordRetrieval(result, 4);
    if (!retrieval.ok) throw new Error(JSON.stringify(retrieval.error));
    for (const kind of ["open", "cite", "pin"] as const) {
      expect(
        (await started.value.recordEvidence(kind, [exactEvidence])).ok
      ).toBeTrue();
    }
    expect(JSON.stringify(result)).toBe(publicBytes);
    expect((await started.value.finish("completed", 5)).ok).toBeTrue();

    const stored = await adapter.getRetrievalTrace("trace-propagation");
    expect(stored.ok).toBeTrue();
    if (!stored.ok || !stored.value) throw new Error("trace missing");
    expect(stored.value.trace.status).toBe("completed");
    expect(stored.value.runs[0]?.payload).toMatchObject({
      ranked: [
        {
          rank: 1,
          plannerRank: 7,
          seq: 3,
          sources: ["bm25", "graph"],
          graphExpanded: true,
          startLine: 10,
          endLine: 11,
          passageHash: PASSAGE_HASH,
        },
      ],
    });
    expect(stored.value.events.map((event) => event.kind)).toEqual([
      "query",
      "retrieval",
      "capability",
      "capability",
      "open",
      "cite",
      "pin",
      "complete",
    ]);
    const retrievalRunId = stored.value.runs[0]?.runId;
    expect(retrievalRunId).toBeDefined();
    expect(
      stored.value.events
        .filter((event) =>
          ["capability", "open", "cite", "pin"].includes(event.kind)
        )
        .every((event) => event.runId === retrievalRunId)
    ).toBeTrue();
  });

  test("keeps resumed get runs separate while opening the retrieval evidence", async () => {
    const started = await RetrievalTraceSession.start({
      store: adapter,
      config: enabledConfig,
      query: "get continuation",
      idFactory: () => "get-continuation",
      fingerprints: () => ({
        pipeline: HASH_A,
        model: HASH_B,
        config: HASH_C,
        index: HASH_D,
      }),
    });
    if (!started.ok || !started.value) throw new Error("trace did not start");
    expect(
      (await started.value.recordRetrieval(searchResults())).ok
    ).toBeTrue();
    const resumed = await RetrievalTraceSession.resume({
      store: adapter,
      config: enabledConfig,
      traceId: "get-continuation",
    });
    if (!resumed.ok || !resumed.value) throw new Error("trace did not resume");
    expect(
      (await resumed.value.recordEvidence("get", [exactEvidence])).ok
    ).toBeTrue();
    expect(
      (await resumed.value.recordEvidence("open", [exactEvidence])).ok
    ).toBeTrue();
    expect((await resumed.value.finish("completed")).ok).toBeTrue();

    const stored = await adapter.getRetrievalTrace("get-continuation");
    if (!stored.ok || !stored.value) throw new Error("trace missing");
    const retrievalRun = stored.value.runs.find(
      (run) => run.kind === "retrieval"
    );
    const getRun = stored.value.runs.find((run) => run.kind === "get");
    expect(retrievalRun?.runId).toBeDefined();
    expect(getRun?.runId).toBeDefined();
    expect(
      stored.value.events.find((event) => event.kind === "get")?.runId
    ).toBe(getRun?.runId);
    expect(
      stored.value.events.find((event) => event.kind === "open")?.runId
    ).toBe(retrievalRun?.runId);
  });

  test("records vector-only and degraded hybrid capabilities without inventing lexical use", async () => {
    const cases = [
      {
        traceId: "vector-capability",
        result: {
          ...searchResults(),
          meta: {
            ...searchResults().meta,
            mode: "vector" as const,
            vectorsUsed: true,
          },
        },
        expectedCapabilities: ["semantic_search"],
        expectedFallbacks: [],
      },
      {
        traceId: "hybrid-degraded",
        result: Object.assign(
          {
            ...searchResults(),
            meta: {
              ...searchResults().meta,
              mode: "bm25_only" as const,
              vectorsUsed: false,
            },
          },
          {
            [SEARCH_RESULTS_TRACE_METADATA]: {
              capabilityOutcomes: [
                { capability: "lexical_search", status: "used" as const },
                {
                  capability: "semantic_search",
                  status: "failed" as const,
                  reasonCode: "vector_embed_error",
                },
              ],
              fallbackCodes: ["vector_embed_error"],
            },
          }
        ),
        expectedCapabilities: ["lexical_search"],
        expectedFallbacks: ["vector_embed_error"],
      },
    ];
    for (const item of cases) {
      const started = await RetrievalTraceSession.start({
        store: adapter,
        config: enabledConfig,
        query: item.traceId,
        idFactory: () => item.traceId,
        fingerprints: () => ({
          pipeline: HASH_A,
          model: HASH_B,
          config: HASH_C,
          index: HASH_D,
        }),
      });
      if (!started.ok || !started.value) throw new Error("trace did not start");
      expect((await started.value.recordRetrieval(item.result)).ok).toBeTrue();
      expect((await started.value.finish("completed")).ok).toBeTrue();
      const stored = await adapter.getRetrievalTrace(item.traceId);
      expect(stored.ok && stored.value?.runs[0]?.payload).toMatchObject({
        capabilities: item.expectedCapabilities,
        fallbackCodes: item.expectedFallbacks,
      });
      const capabilityEvents =
        stored.ok && stored.value
          ? stored.value.events.filter((event) => event.kind === "capability")
          : [];
      expect(
        capabilityEvents.some(
          (event) => event.payload.capability === "lexical_search"
        )
      ).toBe(item.expectedCapabilities.includes("lexical_search"));
    }
  });

  test("retains citation final rank and planner provenance when answer citation order differs", async () => {
    const started = await RetrievalTraceSession.start({
      store: adapter,
      config: enabledConfig,
      query: "citation order",
      idFactory: () => "citation-provenance",
      fingerprints: () => ({
        pipeline: HASH_A,
        model: HASH_B,
        config: HASH_C,
        index: HASH_D,
      }),
    });
    if (!started.ok || !started.value) throw new Error("trace did not start");
    const raw: AnswerGenerationResult = {
      answer: "Second result first [2], then the first result [1].",
      citations: [
        {
          docid: "#first",
          uri: "gno://notes/first.md",
          startLine: 1,
          endLine: 1,
          [CITATION_TRACE_METADATA]: {
            sourceHash: HASH_A,
            mirrorHash: HASH_B,
            passageHash: HASH_C,
            rank: 4,
            plannerRank: 9,
            sources: ["bm25"],
            graphExpanded: false,
          },
        },
        {
          docid: "#second",
          uri: "gno://notes/second.md",
          startLine: 5,
          endLine: 6,
          [CITATION_TRACE_METADATA]: {
            sourceHash: HASH_B,
            mirrorHash: HASH_C,
            passageHash: HASH_D,
            rank: 2,
            plannerRank: 7,
            sources: ["vector", "graph"],
            graphExpanded: true,
          },
        },
      ],
      answerContext: {
        strategy: "adaptive_coverage_v1",
        targetSources: 2,
        facets: [],
        selected: [],
        dropped: [],
      },
    };
    const retrieval: SearchResults = {
      results: raw.citations.map<SearchResult>((citation, index) => {
        const metadata = citation[CITATION_TRACE_METADATA]!;
        return {
          docid: citation.docid,
          score: 1 - index / 10,
          uri: citation.uri,
          snippet: "citation source",
          snippetRange: {
            startLine: citation.startLine!,
            endLine: citation.endLine!,
          },
          source: {
            relPath: citation.uri.split("/").at(-1)!,
            mime: "text/markdown",
            ext: ".md",
            sourceHash: metadata.sourceHash,
          },
          conversion: { mirrorHash: metadata.mirrorHash },
          [SEARCH_RESULT_PLANNER_METADATA]: {
            retrievalRank: metadata.plannerRank ?? index + 1,
            mirrorHash: metadata.mirrorHash,
            seq: metadata.seq ?? index,
            sources: metadata.sources ?? [],
            graphExpanded: metadata.graphExpanded ?? false,
            startLine: citation.startLine!,
            endLine: citation.endLine!,
            passageHash: metadata.passageHash,
          },
        };
      }),
      meta: {
        query: "citation order",
        mode: "hybrid",
        vectorsUsed: true,
        reranked: true,
        totalResults: raw.citations.length,
      },
    };
    expect((await started.value.recordRetrieval(retrieval)).ok).toBeTrue();
    const processed = await processAnswerResultWithTrace(raw, started.value);
    expect(processed.citations).toHaveLength(2);
    expect((await started.value.finish("completed")).ok).toBeTrue();
    const stored = await adapter.getRetrievalTrace("citation-provenance");
    const cited =
      stored.ok && stored.value
        ? stored.value.events.find((event) => event.kind === "cite")
        : undefined;
    expect(cited?.payload).toMatchObject({
      evidence: [
        { rank: 4, plannerRank: 9, sources: ["bm25"] },
        {
          rank: 2,
          plannerRank: 7,
          sources: ["vector", "graph"],
          graphExpanded: true,
        },
      ],
    });
  });

  test("fails soft without exposing an evicted concurrent trace or leaving an open orphan", async () => {
    const capConfig = {
      ...enabledConfig,
      retention: { ...enabledConfig.retention, maxTraces: 1 },
    };
    const start = async (traceId: string, now: number) =>
      RetrievalTraceSession.start({
        store: adapter,
        config: capConfig,
        query: traceId,
        clock: () => now,
        idFactory: () => traceId,
        fingerprints: () => ({
          pipeline: HASH_A,
          model: HASH_B,
          config: HASH_C,
          index: HASH_D,
        }),
      });
    const first = await start("concurrent-first", 1_000);
    const second = await start("concurrent-second", 2_000);
    if (!first.ok || !first.value || !second.ok || !second.value) {
      throw new Error("traces did not start");
    }
    const retrieval = searchResults();
    expect((await first.value.recordRetrieval(retrieval)).ok).toBeTrue();
    expect(first.value.metadata()).toBeUndefined();
    expect(
      withRetrievalTraceHeader(new Response("ok"), first.value).headers.has(
        RETRIEVAL_TRACE_HEADER
      )
    ).toBeFalse();
    expect((await second.value.recordRetrieval(retrieval)).ok).toBeTrue();
    expect((await second.value.finish("completed")).ok).toBeTrue();
    const listed = await adapter.listRetrievalTraces(10);
    expect(listed.ok && listed.value).toHaveLength(1);
    expect(listed.ok && listed.value[0]?.status).toBe("completed");
    expect(
      listed.ok && listed.value.some((trace) => trace.status === "open")
    ).toBeFalse();
  });
});
