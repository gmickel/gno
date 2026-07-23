import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises only supplies temporary-directory structure operations.
import { mkdtemp } from "node:fs/promises";
// node:os/node:path have no Bun utility equivalents.
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RetrievalTraceInput } from "../../src/store/types";

import { RetrievalTraceRecorder } from "../../src/core/retrieval-trace";
import { RetrievalTraceManagementService } from "../../src/core/retrieval-trace-management";
import { SqliteAdapter } from "../../src/store";
import { safeRm } from "../helpers/cleanup";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const traceInput = (
  traceId: string,
  createdAtMs: number,
  mode: "metadata" | "replay" = "metadata"
): RetrievalTraceInput => {
  const query = `query ${traceId}`;
  return {
    traceId,
    schemaVersion: "1.0",
    redactionMode: mode,
    replayCapable: mode === "replay",
    queryText: mode === "replay" ? query : null,
    queryDigest:
      mode === "replay"
        ? new Bun.CryptoHasher("sha256").update(query).digest("hex")
        : null,
    queryShape: { characters: query.length, terms: 2 },
    goalText: null,
    goalDigest: null,
    goalShape: { characters: 0, terms: 0 },
    filters: mode === "replay" ? { collection: "notes" } : { shape: {} },
    fingerprints: {
      pipeline: HASH_A,
      model: HASH_A,
      config: HASH_A,
      index: HASH_A,
    },
    status: "open",
    createdAtMs,
    updatedAtMs: createdAtMs,
    expiresAtMs: createdAtMs + 86_400_000,
  };
};

describe("retrieval trace frozen management contract", () => {
  let root = "";
  let store: SqliteAdapter;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-trace-contract-"));
    store = new SqliteAdapter();
    expect((await store.open(join(root, "index.sqlite"), "unicode61")).ok).toBe(
      true
    );
  });

  afterEach(async () => {
    await store.close();
    await safeRm(root);
  });

  test("uses an opaque versioned cursor and preserves a stable newest-first page", async () => {
    for (const [traceId, createdAtMs] of [
      ["old", 100],
      ["middle", 200],
      ["new", 300],
    ] as const) {
      expect(
        (await store.createRetrievalTrace(traceInput(traceId, createdAtMs))).ok
      ).toBeTrue();
    }
    const service = new RetrievalTraceManagementService(store);
    const first = await service.list({ limit: 2 });
    expect(
      first.ok && first.value.traces.map(({ traceId }) => traceId)
    ).toEqual(["new", "middle"]);
    if (!first.ok || !first.value.nextCursor) return;
    expect(first.value.nextCursor).toStartWith("gno-trace-v1.");
    expect(first.value.nextCursor).not.toContain("middle");
    expect(first.value.nextCursor).not.toContain("200");

    expect(
      (await store.createRetrievalTrace(traceInput("newest-later", 400))).ok
    ).toBeTrue();
    const second = await service.list({
      limit: 2,
      cursor: first.value.nextCursor,
    });
    expect(
      second.ok && second.value.traces.map(({ traceId }) => traceId)
    ).toEqual(["old"]);

    const invalid = await service.list({
      cursor: "gno-trace-v1.bm90LWpzb24",
    });
    expect(invalid.ok).toBeFalse();
    if (!invalid.ok) expect(invalid.error.code).toBe("INVALID_INPUT");
  });

  test("bounds every detail section while reporting exact totals", async () => {
    const traceId = "bounded-all";
    expect(
      (await store.createRetrievalTrace(traceInput(traceId, 100))).ok
    ).toBeTrue();
    for (const suffix of ["a", "b"]) {
      expect(
        (
          await store.appendRetrievalTraceRun({
            runId: `run-${suffix}`,
            traceId,
            idempotencyKey: `run-${suffix}`,
            kind: "retrieval",
            payload: { ranked: [] },
            createdAtMs: 101,
          })
        ).ok
      ).toBeTrue();
      expect(
        (
          await store.appendRetrievalTraceEvent({
            eventId: `event-${suffix}`,
            traceId,
            runId: `run-${suffix}`,
            idempotencyKey: `event-${suffix}`,
            kind: "query",
            payload: {},
            createdAtMs: 102,
          })
        ).ok
      ).toBeTrue();
      expect(
        (
          await store.appendRetrievalTraceJudgment({
            judgmentId: `judgment-${suffix}`,
            traceId,
            runId: `run-${suffix}`,
            idempotencyKey: `judgment-${suffix}`,
            label: suffix === "a" ? "relevant" : "irrelevant",
            targetKind: "document",
            targetRef: `gno://notes/${suffix}.md`,
            target: {
              uri: `gno://notes/${suffix}.md`,
              sourceHash: suffix === "a" ? HASH_A : HASH_B,
            },
            createdAtMs: 103,
          })
        ).ok
      ).toBeTrue();
    }
    expect(
      (await store.finalizeRetrievalTrace(traceId, "completed", 104)).ok
    ).toBeTrue();
    for (const [suffix, artifactHash] of [
      ["a", HASH_A],
      ["b", HASH_B],
    ] as const) {
      expect(
        (
          await store.appendRetrievalTraceExport({
            exportId: `export-${suffix}`,
            traceId,
            format: "agentic-receipt",
            artifactHash,
            createdAtMs: 105,
          })
        ).ok
      ).toBeTrue();
    }

    const detail = await new RetrievalTraceManagementService(store).show(
      traceId,
      { detailLimit: 1 }
    );
    expect(detail.ok).toBeTrue();
    if (!detail.ok) return;
    expect(detail.value.totals).toEqual({
      runs: 2,
      events: 2,
      judgments: 2,
      exports: 2,
    });
    expect(detail.value.truncated).toEqual({
      runs: true,
      events: true,
      judgments: true,
      exports: true,
    });
    expect(detail.value.runs).toHaveLength(1);
    expect(detail.value.events).toHaveLength(1);
    expect(detail.value.judgments).toHaveLength(1);
    expect(detail.value.exports).toHaveLength(1);
  });

  test("resolves URI docid hash and exact-span labels without collections", async () => {
    const traceId = "label-identities";
    expect(
      (await store.createRetrievalTrace(traceInput(traceId, 100))).ok
    ).toBeTrue();
    expect(
      (
        await store.appendRetrievalTraceEvent({
          eventId: "evidence",
          traceId,
          runId: null,
          idempotencyKey: "evidence",
          kind: "retrieval",
          payload: {
            ranked: [
              {
                docid: "#abcdef",
                uri: "gno://notes/evidence.md",
                sourceHash: HASH_B,
                mirrorHash: HASH_C,
                startLine: 4,
                endLine: 8,
                rank: 1,
              },
            ],
          },
          createdAtMs: 101,
        })
      ).ok
    ).toBeTrue();
    const service = new RetrievalTraceManagementService(store, {
      clock: () => 200,
    });
    const byUri = await service.label({
      traceId,
      label: "relevant",
      targetRef: "gno://notes/evidence.md",
      targetKind: "span",
      startLine: 4,
      endLine: 8,
    });
    expect(byUri.ok && byUri.value.judgment.target).toMatchObject({
      uri: "gno://notes/evidence.md",
      startLine: 4,
      endLine: 8,
    });
    const byDocid = await service.label({
      traceId,
      label: "irrelevant",
      targetRef: "#abcdef",
      targetKind: "document",
    });
    expect(byDocid.ok && byDocid.value.judgment.target.docid).toBe("#abcdef");
    const byHash = await service.label({
      traceId,
      label: "relevant",
      targetRef: HASH_B,
      targetKind: "document",
    });
    expect(byHash.ok && byHash.value.judgment.target.sourceHash).toBe(HASH_B);
  });

  test("returns NOT_FOUND for missing and retention-evicted receipts", async () => {
    const service = new RetrievalTraceManagementService(store);
    const missingReads = [
      await service.show("missing"),
      await service.label({
        traceId: "missing",
        label: "missing_expected",
        targetRef: "gno://notes/missing.md",
      }),
      await service.delete("missing"),
    ];
    for (const result of missingReads) {
      expect(result.ok).toBeFalse();
      if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    }

    expect(
      (await store.createRetrievalTrace(traceInput("evicted", 100))).ok
    ).toBeTrue();
    expect(
      (await store.createRetrievalTrace(traceInput("retained", 200))).ok
    ).toBeTrue();
    expect(
      (
        await store.enforceRetrievalTraceRetention(
          {
            maxAgeDays: 30,
            maxTraces: 1,
            maxRecordsPerTrace: 100,
            maxBytes: 1_000_000,
          },
          200
        )
      ).ok
    ).toBeTrue();
    const evicted = await service.show("evicted");
    expect(evicted.ok).toBeFalse();
    if (!evicted.ok) expect(evicted.error.code).toBe("NOT_FOUND");
    expect((await service.show("retained")).ok).toBeTrue();
  });

  test("canonicalizes set-like replay filters before persistence", async () => {
    const recorder = new RetrievalTraceRecorder(
      store,
      {
        enabled: true,
        redactionMode: "replay",
        retention: {
          maxAgeDays: 30,
          maxTraces: 10,
          maxRecordsPerTrace: 100,
          maxBytes: 1_000_000,
        },
      },
      { clock: () => 100, idFactory: () => "canonical-filters" }
    );
    const started = await recorder.start({
      query: "filter order",
      filters: {
        collections: ["zeta", "alpha", "zeta"],
        categories: ["policy", "decision", "policy"],
        exclude: ["draft", "archive", "draft"],
        tagsAll: ["urgent", "client", "urgent"],
        tagsAny: ["beta", "alpha", "beta"],
      },
      fingerprints: {
        pipeline: HASH_A,
        model: HASH_A,
        config: HASH_A,
        index: HASH_A,
      },
    });
    expect(started.ok).toBeTrue();
    const stored = await store.getRetrievalTrace("canonical-filters");
    expect(stored.ok && stored.value?.trace.filters).toEqual({
      categories: ["decision", "policy"],
      collections: ["alpha", "zeta"],
      exclude: ["archive", "draft"],
      tagsAll: ["client", "urgent"],
      tagsAny: ["alpha", "beta"],
    });
  });
});
