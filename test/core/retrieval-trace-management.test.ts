import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises only supplies temporary-directory structure operations.
import { mkdtemp } from "node:fs/promises";
// node:os/node:path have no Bun utility equivalents.
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  RetrievalTraceInput,
  RetrievalTraceTerminalStatus,
} from "../../src/store/types";

import { RetrievalTraceManagementService } from "../../src/core/retrieval-trace-management";
import { SqliteAdapter } from "../../src/store";
import { safeRm } from "../helpers/cleanup";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const DAY_MS = 86_400_000;

const traceInput = (
  traceId: string,
  createdAtMs: number,
  mode: "metadata" | "replay" = "metadata"
): RetrievalTraceInput => {
  const query = `private query for ${traceId}`;
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
    queryShape: {
      characters: Array.from(query).length,
      terms: query.split(/\s+/u).length,
    },
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
    expiresAtMs: createdAtMs + DAY_MS,
  };
};

describe("retrieval trace management", () => {
  let root = "";
  let dbPath = "";
  let store: SqliteAdapter;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-trace-management-"));
    dbPath = join(root, "index.sqlite");
    store = new SqliteAdapter();
    expect((await store.open(dbPath, "unicode61")).ok).toBeTrue();
  });

  afterEach(async () => {
    await store.close();
    await safeRm(root);
  });

  test("paginates stably and never exposes replay query material in list rows", async () => {
    for (const traceId of ["a", "b", "c"]) {
      expect(
        (await store.createRetrievalTrace(traceInput(traceId, 1000, "replay")))
          .ok
      ).toBeTrue();
    }
    const service = new RetrievalTraceManagementService(store);
    const first = await service.list({ limit: 2 });
    expect(first.ok).toBeTrue();
    if (!first.ok) return;
    expect(first.value.traces.map(({ traceId }) => traceId)).toEqual([
      "a",
      "b",
    ]);
    expect(JSON.stringify(first.value)).not.toContain("private query");
    expect(first.value.nextCursor).not.toBeNull();
    const second = await service.list({
      limit: 2,
      cursor: first.value.nextCursor!,
    });
    expect(
      second.ok && second.value.traces.map(({ traceId }) => traceId)
    ).toEqual(["c"]);
    expect(second.ok && second.value.nextCursor).toBeNull();
  });

  test("bounds trace detail and reports exact totals", async () => {
    expect(
      (await store.createRetrievalTrace(traceInput("bounded", 1000))).ok
    ).toBeTrue();
    for (const eventId of ["one", "two"]) {
      expect(
        (
          await store.appendRetrievalTraceEvent({
            eventId,
            traceId: "bounded",
            runId: null,
            idempotencyKey: eventId,
            kind: "query",
            payload: {},
            createdAtMs: 1001,
          })
        ).ok
      ).toBeTrue();
    }
    const detail = await new RetrievalTraceManagementService(store).show(
      "bounded",
      { detailLimit: 1 }
    );
    expect(detail.ok && detail.value.events).toHaveLength(1);
    expect(detail.ok && detail.value.totals.events).toBe(2);
    expect(detail.ok && detail.value.truncated.events).toBeTrue();
    const boundedRead = await store.getBoundedRetrievalTrace("bounded", 1);
    expect(boundedRead.ok && boundedRead.value?.bundle.events).toHaveLength(1);
    expect(boundedRead.ok && boundedRead.value?.totals.events).toBe(2);
  });

  test("derives exact evidence labels and preserves append-only corrections", async () => {
    expect(
      (await store.createRetrievalTrace(traceInput("feedback", 1000))).ok
    ).toBeTrue();
    expect(
      (
        await store.appendRetrievalTraceEvent({
          eventId: "evidence",
          traceId: "feedback",
          runId: null,
          idempotencyKey: "evidence",
          kind: "retrieval",
          payload: {
            ranked: [
              {
                docid: "#abcdef",
                sourceHash: HASH_A,
                uri: "gno://notes/evidence.md",
                startLine: 4,
                endLine: 8,
                rank: 1,
              },
            ],
          },
          createdAtMs: 1001,
        })
      ).ok
    ).toBeTrue();
    const service = new RetrievalTraceManagementService(store, {
      clock: () => 2000,
    });
    const relevant = await service.label({
      traceId: "feedback",
      label: "relevant",
      targetRef: "gno://notes/evidence.md",
      targetKind: "span",
      startLine: 4,
      endLine: 8,
    });
    expect(relevant.ok && relevant.value.result).toBe("inserted");
    if (!relevant.ok) return;
    expect(relevant.value.judgment.targetRef).toMatch(
      /^redacted:[a-f0-9]{64}$/
    );
    expect(relevant.value.judgment.target).toEqual({
      docid: "#abcdef",
      sourceHash: HASH_A,
      uri: "gno://notes/evidence.md",
      startLine: 4,
      endLine: 8,
    });
    const retry = await service.label({
      traceId: "feedback",
      label: "relevant",
      targetRef: "gno://notes/evidence.md",
      targetKind: "span",
      startLine: 4,
      endLine: 8,
    });
    expect(retry.ok && retry.value.result).toBe("duplicate");
    const correction = await service.label({
      traceId: "feedback",
      label: "irrelevant",
      targetRef: "gno://notes/evidence.md",
      targetKind: "span",
      startLine: 4,
      endLine: 8,
    });
    expect(correction.ok && correction.value.result).toBe("inserted");
    const correctedBack = await service.label({
      traceId: "feedback",
      label: "relevant",
      targetRef: "gno://notes/evidence.md",
      targetKind: "span",
      startLine: 4,
      endLine: 8,
    });
    expect(correctedBack.ok && correctedBack.value.result).toBe("inserted");
    const stored = await store.getRetrievalTrace("feedback");
    expect(
      stored.ok && stored.value?.judgments.map(({ label }) => label)
    ).toEqual(["relevant", "irrelevant", "relevant"]);
  });

  test("settles concurrent identical labels as one insert and one duplicate", async () => {
    expect(
      (await store.createRetrievalTrace(traceInput("concurrent", 1000))).ok
    ).toBeTrue();
    expect(
      (
        await store.appendRetrievalTraceEvent({
          eventId: "evidence",
          traceId: "concurrent",
          runId: null,
          idempotencyKey: "evidence",
          kind: "retrieval",
          payload: {
            ranked: [
              {
                docid: "#abcdef",
                sourceHash: HASH_A,
                uri: "gno://notes/evidence.md",
                startLine: 4,
                endLine: 8,
              },
            ],
          },
          createdAtMs: 1001,
        })
      ).ok
    ).toBeTrue();
    const input = {
      traceId: "concurrent",
      label: "relevant" as const,
      targetRef: "gno://notes/evidence.md",
    };
    const results = await Promise.all([
      new RetrievalTraceManagementService(store, {
        clock: () => 2000,
      }).label(input),
      new RetrievalTraceManagementService(store, {
        clock: () => 2001,
      }).label(input),
    ]);
    expect(
      results
        .map((result) => (result.ok ? result.value.result : "error"))
        .sort()
    ).toEqual(["duplicate", "inserted"]);
  });

  test("keeps the metadata redaction secret durable and accepts content-free missing documents", async () => {
    for (const traceId of ["first", "second"]) {
      expect(
        (await store.createRetrievalTrace(traceInput(traceId, 1000))).ok
      ).toBeTrue();
    }
    const firstService = new RetrievalTraceManagementService(store, {
      clock: () => 2000,
    });
    const first = await firstService.label({
      traceId: "first",
      label: "missing_expected",
      targetRef: "gno://notes/missing.md",
      sourceHash: HASH_B,
    });
    expect(first.ok).toBeTrue();
    const unsafe = await firstService.label({
      traceId: "first",
      label: "missing_expected",
      targetRef: "/Users/private/customer.md",
      sourceHash: HASH_B,
    });
    expect(unsafe.ok).toBeFalse();
    if (!unsafe.ok) expect(unsafe.error.code).toBe("INVALID_INPUT");
    const storedFirst = await store.getRetrievalTrace("first");
    expect(JSON.stringify(storedFirst)).not.toContain("/Users/private");
    await store.close();
    store = new SqliteAdapter();
    expect((await store.open(dbPath, "unicode61")).ok).toBeTrue();
    const second = await new RetrievalTraceManagementService(store, {
      clock: () => 2000,
    }).label({
      traceId: "second",
      label: "missing_expected",
      targetRef: "gno://notes/missing.md",
      sourceHash: HASH_B,
    });
    expect(second.ok).toBeTrue();
    if (!(first.ok && second.ok)) return;
    expect(second.value.judgment.targetRef).toBe(
      first.value.judgment.targetRef
    );
    expect(JSON.stringify(second.value)).not.toContain("private query");
  });

  test("exports sorted terminal snapshots atomically without inventing negatives", async () => {
    const statuses: Array<[string, RetrievalTraceTerminalStatus]> = [
      ["complete", "completed"],
      ["partial", "partial"],
      ["failed", "failed"],
      ["cancelled", "cancelled"],
    ];
    for (const [traceId, status] of statuses) {
      expect(
        (await store.createRetrievalTrace(traceInput(traceId, 1000))).ok
      ).toBeTrue();
      expect(
        (await store.finalizeRetrievalTrace(traceId, status, 1001)).ok
      ).toBeTrue();
    }
    expect(
      (await store.createRetrievalTrace(traceInput("open", 1000))).ok
    ).toBeTrue();
    const service = new RetrievalTraceManagementService(store, {
      clock: () => 2000,
    });
    const exported = await service.export({
      traceIds: ["partial", "cancelled", "failed", "complete", "partial"],
    });
    expect(exported.ok).toBeTrue();
    if (!exported.ok) return;
    expect(exported.value.manifest.traceIds).toEqual([
      "cancelled",
      "complete",
      "failed",
      "partial",
    ]);
    expect(
      exported.value.artifact.traces.map(({ trace }) => trace.status)
    ).toEqual(["cancelled", "completed", "failed", "partial"]);
    expect(
      exported.value.artifact.traces.flatMap(({ judgments }) => judgments)
    ).toEqual([]);
    const duplicate = await service.export({
      traceIds: ["complete", "partial", "failed", "cancelled"],
    });
    expect(duplicate.ok && duplicate.value.result).toBe("duplicate");
    expect(duplicate.ok && duplicate.value.manifest.artifactHash).toBe(
      exported.value.manifest.artifactHash
    );
    const rejected = await service.export({ traceIds: ["open"] });
    expect(rejected.ok).toBeFalse();
    if (!rejected.ok) expect(rejected.error.code).toBe("CONSTRAINT_VIOLATION");

    const missingMember = await store.appendRetrievalTraceExportManifest({
      exportId: "atomic-reject",
      traceIds: ["complete", "does-not-exist"],
      format: "agentic-receipt",
      artifactHash: HASH_B,
      createdAtMs: 2000,
    });
    expect(missingMember.ok).toBeFalse();
    const rolledBack =
      await store.getRetrievalTraceExportManifest("atomic-reject");
    expect(rolledBack.ok && rolledBack.value).toBeNull();

    const malformed = await service.export({
      traceIds: "complete" as unknown as string[],
    });
    expect(malformed.ok).toBeFalse();
    if (!malformed.ok) expect(malformed.error.code).toBe("INVALID_INPUT");
  });

  test("rejects deletion of an unknown trace instead of fabricating a receipt", async () => {
    const deleted = await new RetrievalTraceManagementService(store).delete(
      "missing"
    );
    expect(deleted.ok).toBeFalse();
    if (!deleted.ok) {
      expect(deleted.error).toMatchObject({
        code: "NOT_FOUND",
        message: "Retrieval trace not found",
      });
    }
  });
});
