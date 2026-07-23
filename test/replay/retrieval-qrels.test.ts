import { describe, expect, test } from "bun:test";

import type {
  RetrievalTraceBundle,
  RetrievalTraceEventRow,
  RetrievalTraceJudgmentRow,
  RetrievalTraceRunRow,
} from "../../src/store/types";

import {
  buildRetrievalQrelsArtifact,
  type RetrievalQrelsEvidence,
} from "../../src/core/retrieval-qrels";
import { assertValid, loadSchema } from "../spec/schemas/validator";

const sha256 = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

const evidence = (
  name: string,
  rank = 1,
  plannerRank = rank
): RetrievalQrelsEvidence => ({
  docid: `#${sha256(`doc-${name}`).slice(0, 12)}`,
  sourceHash: sha256(`source-${name}`),
  mirrorHash: sha256(`mirror-${name}`),
  uri: `gno://notes/${name}.md`,
  seq: 0,
  startLine: 1,
  endLine: 1,
  passageHash: sha256(`passage-${name}`),
  rank,
  plannerRank,
  score: 0.9,
  sources: ["bm25"],
  graphExpanded: false,
});

const run = (
  runId: string,
  ranked: RetrievalQrelsEvidence[],
  capabilities: string[] = []
): RetrievalTraceRunRow => ({
  runId,
  traceId: "trace",
  idempotencyKey: runId,
  kind: "retrieval",
  payload: {
    ranked,
    capabilities,
    fallbackCodes: ["fallback-z", "fallback-a", "fallback-a"],
  },
  createdAtMs: 100,
  payloadBytes: 1,
  canonicalDigest: sha256(`run-${runId}`),
});

const judgment = (
  judgmentId: string,
  runId: string | null,
  label: RetrievalTraceJudgmentRow["label"],
  target: RetrievalQrelsEvidence,
  createdAtMs: number
): RetrievalTraceJudgmentRow => ({
  judgmentId,
  traceId: "trace",
  runId,
  idempotencyKey: judgmentId,
  label,
  targetKind: "span",
  targetRef: target.uri,
  target: { ...target },
  createdAtMs,
  targetBytes: 1,
  canonicalDigest: sha256(`judgment-${judgmentId}`),
});

const event = (
  eventId: string,
  runId: string | null,
  kind: RetrievalTraceEventRow["kind"],
  payload: Record<string, unknown>
): RetrievalTraceEventRow => ({
  eventId,
  traceId: "trace",
  runId,
  idempotencyKey: eventId,
  kind,
  payload,
  createdAtMs: 101,
  payloadBytes: 1,
  canonicalDigest: sha256(`event-${eventId}`),
});

const bundle = (input: {
  runs: RetrievalTraceRunRow[];
  events?: RetrievalTraceEventRow[];
  judgments?: RetrievalTraceJudgmentRow[];
}): RetrievalTraceBundle => ({
  trace: {
    traceId: "trace",
    schemaVersion: "1.0",
    redactionMode: "replay",
    replayCapable: true,
    queryText: "decision",
    queryDigest: sha256("decision"),
    queryShape: { characters: 8, terms: 1 },
    goalText: null,
    goalDigest: null,
    goalShape: { characters: 0, terms: 0 },
    filters: {
      collections: ["notes", "archive", "notes"],
      lang: "de",
      queryLanguageHint: "de",
      uriPrefix: "gno://notes/projects",
    },
    fingerprints: {
      pipeline: sha256("pipeline"),
      model: sha256("model"),
      config: sha256("config"),
      index: sha256("index"),
    },
    status: "completed",
    createdAtMs: 1,
    updatedAtMs: 2,
    expiresAtMs: 3,
    byteSize: 1,
    creationDigest: sha256("trace"),
  },
  runs: input.runs,
  events: input.events ?? [],
  judgments: input.judgments ?? [],
  exports: [],
});

describe("retrieval qrels construction", () => {
  test("accepts a zero-hit run with an explicit missing-expected judgment", async () => {
    const missing = evidence("missing");
    const built = buildRetrievalQrelsArtifact([
      bundle({
        runs: [run("run-empty", [], ["lexical_search"])],
        judgments: [
          judgment("missing-judgment", null, "missing_expected", missing, 200),
        ],
      }),
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(
      assertValid(built.value, await loadSchema("retrieval-trace-qrels"))
    ).toBe(true);
    expect(built.value.cases).toHaveLength(1);
    expect(built.value.cases[0]).toMatchObject({
      retrievalRunId: "run-empty",
      baseline: {
        ranked: [],
        capabilities: ["lexical_search"],
        fallbackCodes: ["fallback-a", "fallback-z"],
      },
      qrels: [
        {
          label: "missing_expected",
          relevance: 1,
          baselineMissing: true,
          evidence: null,
        },
      ],
    });
  });

  test("isolates every run and omits an unlabeled retrieval run", () => {
    const alpha = evidence("alpha");
    const beta = evidence("beta");
    const ignored = evidence("ignored");
    const built = buildRetrievalQrelsArtifact([
      bundle({
        runs: [
          run("run-a", [alpha], ["zeta", "alpha", "alpha"]),
          run("run-b", [beta], ["vector_search"]),
          run("run-unlabeled", [ignored], ["must_not_leak"]),
        ],
        events: [
          event("cap-a", "run-a", "capability", {
            capability: "lexical_search",
            status: "used",
          }),
          event("cap-b", "run-b", "capability", {
            capability: "vector_search",
            status: "used",
          }),
          event("cap-null", null, "capability", {
            capability: "must_not_leak",
            status: "used",
          }),
          event("open-a", "run-a", "open", { evidence: [alpha] }),
          event("cite-b", "run-b", "cite", { evidence: [beta] }),
        ],
        judgments: [
          judgment("a-relevant", "run-a", "relevant", alpha, 200),
          judgment("a-correction", "run-a", "irrelevant", alpha, 201),
          judgment("b-relevant", "run-b", "relevant", beta, 200),
        ],
      }),
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.cases).toHaveLength(2);
    const byRun = new Map(
      built.value.cases.map((item) => [item.retrievalRunId, item])
    );
    expect(byRun.has("run-unlabeled")).toBe(false);
    expect(byRun.get("run-a")).toMatchObject({
      baseline: {
        capabilities: ["alpha", "zeta"],
        capabilityOutcomes: [
          {
            capability: "lexical_search",
            status: "used",
            reasonCode: null,
          },
        ],
        outcomes: { opened: [alpha], cited: [], pinned: [] },
      },
      judgments: {
        effective: ["a-correction"],
      },
      qrels: [{ judgmentId: "a-correction", label: "irrelevant" }],
    });
    expect(
      byRun.get("run-a")?.judgments.history.map((item) => item.judgmentId)
    ).toEqual(["a-relevant", "a-correction"]);
    expect(byRun.get("run-b")).toMatchObject({
      baseline: {
        capabilities: ["vector_search"],
        capabilityOutcomes: [
          {
            capability: "vector_search",
            status: "used",
            reasonCode: null,
          },
        ],
        outcomes: { opened: [], cited: [beta], pinned: [] },
      },
      judgments: { effective: ["b-relevant"] },
      qrels: [{ judgmentId: "b-relevant", label: "relevant" }],
    });
  });

  test("fails a null-run missing judgment when multiple retrieval runs exist", () => {
    const missing = evidence("missing");
    const built = buildRetrievalQrelsArtifact([
      bundle({
        runs: [run("run-a", []), run("run-b", [])],
        judgments: [
          judgment("missing", null, "missing_expected", missing, 200),
        ],
      }),
    ]);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.message).toContain("ambiguous_missing_expected_run");
  });

  test("rejects a trace without a retrieval run", () => {
    const built = buildRetrievalQrelsArtifact([bundle({ runs: [] })]);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.message).toContain("no_retrieval_run");
  });
});
