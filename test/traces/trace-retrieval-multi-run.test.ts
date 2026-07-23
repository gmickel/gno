import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises: temporary directory creation has no Bun equivalent.
import { mkdtemp } from "node:fs/promises";
// node:os and node:path: Bun has no equivalent temp/path helpers.
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RetrievalTraceEvidence } from "../../src/core/retrieval-trace-session";
import type { FusionSource, SearchResults } from "../../src/pipeline/types";

import { buildRetrievalQrelsArtifact } from "../../src/core/retrieval-qrels";
import { RetrievalTraceManagementService } from "../../src/core/retrieval-trace-management";
import { RetrievalTraceSession } from "../../src/core/retrieval-trace-session";
import { SEARCH_RESULT_PLANNER_METADATA } from "../../src/pipeline/types";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const passageHash = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");
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
const fingerprints = () => ({
  pipeline: HASH_A,
  model: HASH_B,
  config: HASH_C,
  index: HASH_D,
});
type OriginEvidence = RetrievalTraceEvidence & {
  seq: number;
  plannerRank: number;
  sources: FusionSource[];
  graphExpanded: boolean;
};
const evidence: Record<"first" | "second", OriginEvidence> = {
  first: {
    docid: "#abcdef",
    sourceHash: HASH_A,
    mirrorHash: HASH_B,
    uri: "gno://notes/first.md",
    seq: 0,
    startLine: 10,
    endLine: 11,
    passageHash: passageHash("first passage"),
    rank: 1,
    plannerRank: 7,
    sources: ["bm25"],
    graphExpanded: false,
  },
  second: {
    docid: "#fedcba",
    sourceHash: HASH_C,
    mirrorHash: HASH_D,
    uri: "gno://notes/second.md",
    seq: 1,
    startLine: 20,
    endLine: 20,
    passageHash: passageHash("second passage"),
    rank: 1,
    plannerRank: 2,
    sources: ["vector"],
    graphExpanded: false,
  },
};

const searchResults = (
  item: (typeof evidence)[keyof typeof evidence]
): SearchResults => ({
  results: [
    {
      docid: item.docid,
      score: 0.9,
      uri: item.uri,
      snippet: "presentation",
      snippetRange: {
        startLine: item.startLine,
        endLine: item.endLine,
      },
      source: {
        relPath: item.uri.split("/").at(-1)!,
        mime: "text/markdown",
        ext: ".md",
        sourceHash: item.sourceHash,
      },
      conversion: { mirrorHash: item.mirrorHash },
      [SEARCH_RESULT_PLANNER_METADATA]: {
        retrievalRank: item.plannerRank,
        mirrorHash: item.mirrorHash,
        seq: item.seq!,
        sources: [...item.sources],
        graphExpanded: item.graphExpanded,
        startLine: item.startLine,
        endLine: item.endLine,
        passageHash: item.passageHash,
      },
    },
  ],
  meta: {
    query: "multi run",
    mode: "hybrid",
    vectorsUsed: true,
    reranked: true,
    totalResults: 1,
  },
});

describe("multi-run retrieval trace outcomes", () => {
  let testDir = "";
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-trace-multi-run-"));
    adapter = new SqliteAdapter();
    expect(
      (await adapter.open(join(testDir, "index.sqlite"), "unicode61")).ok
    ).toBeTrue();
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  test("attributes outcomes to exact origins and isolates qrels", async () => {
    const started = await RetrievalTraceSession.start({
      store: adapter,
      config: enabledConfig,
      query: "multi run",
      idFactory: () => "multi-run-outcomes",
      fingerprints,
    });
    if (!started.ok || !started.value) throw new Error("trace did not start");
    for (const item of [evidence.first, evidence.second]) {
      expect(
        (await started.value.recordRetrieval(searchResults(item))).ok
      ).toBeTrue();
    }
    expect(
      (await started.value.recordEvidence("open", [evidence.first])).ok
    ).toBeTrue();
    expect(
      (await started.value.recordEvidence("cite", [evidence.second])).ok
    ).toBeTrue();
    expect(
      (
        await started.value.recordEvidence("pin", [
          evidence.first,
          evidence.second,
        ])
      ).ok
    ).toBeTrue();
    expect((await started.value.finish("completed")).ok).toBeTrue();

    const management = new RetrievalTraceManagementService(adapter, {
      clock: () => 10_000,
    });
    for (const item of [evidence.first, evidence.second]) {
      expect(
        (
          await management.label({
            traceId: "multi-run-outcomes",
            label: "relevant",
            targetRef: item.uri,
          })
        ).ok
      ).toBeTrue();
    }
    const stored = await adapter.getRetrievalTrace("multi-run-outcomes");
    if (!stored.ok || !stored.value) throw new Error("trace missing");
    const runIds = stored.value.runs
      .filter((run) => run.kind === "retrieval")
      .map((run) => run.runId);
    expect(
      stored.value.events.find((event) => event.kind === "open")?.runId
    ).toBe(runIds[0]);
    expect(
      stored.value.events.find((event) => event.kind === "cite")?.runId
    ).toBe(runIds[1]);
    expect(
      stored.value.events
        .filter((event) => event.kind === "pin")
        .map((event) => event.runId)
        .sort((left, right) => (left ?? "").localeCompare(right ?? ""))
    ).toEqual([...runIds].sort((left, right) => left.localeCompare(right)));

    const qrels = buildRetrievalQrelsArtifact([stored.value]);
    expect(qrels.ok).toBeTrue();
    if (!qrels.ok) return;
    const cases = new Map(
      qrels.value.cases.map((item) => [item.retrievalRunId, item])
    );
    expect(cases.get(runIds[0]!)?.baseline.outcomes).toMatchObject({
      opened: [{ uri: evidence.first.uri }],
      cited: [],
      pinned: [{ uri: evidence.first.uri }],
    });
    expect(cases.get(runIds[1]!)?.baseline.outcomes).toMatchObject({
      opened: [],
      cited: [{ uri: evidence.second.uri }],
      pinned: [{ uri: evidence.second.uri }],
    });
  });

  test("rejects ambiguous evidence instead of using the latest run", async () => {
    const started = await RetrievalTraceSession.start({
      store: adapter,
      config: enabledConfig,
      query: "ambiguous run",
      idFactory: () => "ambiguous-run-outcome",
      fingerprints,
    });
    if (!started.ok || !started.value) throw new Error("trace did not start");
    for (const _ of [0, 1]) {
      expect(
        (await started.value.recordRetrieval(searchResults(evidence.first))).ok
      ).toBeTrue();
    }
    const opened = await started.value.recordEvidence("open", [evidence.first]);
    expect(opened.ok).toBeFalse();
    if (!opened.ok) {
      expect(opened.error.code).toBe("INVALID_INPUT");
      expect(opened.error.message).toContain("outcome_evidence_ambiguous");
    }
    const stored = await adapter.getRetrievalTrace("ambiguous-run-outcome");
    expect(
      stored.ok && stored.value?.events.some((event) => event.kind === "open")
    ).toBeFalse();
  });
});
