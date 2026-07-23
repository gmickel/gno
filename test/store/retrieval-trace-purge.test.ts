import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises: temporary directory creation/removal has no Bun equivalent.
import { mkdtemp } from "node:fs/promises";
// node:os and node:path: Bun has no path/temp-directory utilities.
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RetrievalTraceInput } from "../../src/store/types";

import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const HASH = "a".repeat(64);
const DAY_MS = 86_400_000;

const traceInput = (
  traceId: string,
  createdAtMs: number,
  mode: "metadata" | "replay" = "metadata",
  query = "private query"
): RetrievalTraceInput => ({
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
    terms: query.trim().split(/\s+/u).length,
  },
  goalText: null,
  goalDigest: null,
  goalShape: { characters: 0, terms: 0 },
  filters: mode === "replay" ? { collection: "notes" } : { shape: {} },
  fingerprints: {
    pipeline: HASH,
    model: HASH,
    config: HASH,
    index: HASH,
  },
  status: "open",
  createdAtMs,
  updatedAtMs: createdAtMs,
  expiresAtMs: createdAtMs + 30 * DAY_MS,
});

describe("retrieval trace secure deletion", () => {
  let testDir = "";
  let dbPath = "";
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-trace-purge-"));
    dbPath = join(testDir, "index.sqlite");
    adapter = new SqliteAdapter();
    expect((await adapter.open(dbPath, "unicode61")).ok).toBe(true);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  test("fully purges replay canaries from the database and WAL", async () => {
    const canary = "physical-purge-secret-4ab3a54d";
    expect(
      (
        await adapter.createRetrievalTrace(
          traceInput("purge-trace", 2_000, "replay", canary)
        )
      ).ok
    ).toBe(true);
    expect(
      (
        await adapter.appendRetrievalTraceEvent({
          eventId: "purge-event",
          traceId: "purge-trace",
          runId: null,
          idempotencyKey: "purge-event",
          kind: "query",
          payload: { status: "recorded" },
          createdAtMs: 2_001,
        })
      ).ok
    ).toBe(true);
    adapter.getRawDb().exec("PRAGMA secure_delete = FAST");
    const purged = await adapter.purgeRetrievalTraces();
    expect(purged.ok).toBe(true);
    if (!purged.ok) return;
    expect(purged.value).toMatchObject({
      traces: 1,
      events: 1,
      physicalCleanup: "completed",
      remainingWalFrames: 0,
    });
    expect(
      adapter
        .getRawDb()
        .query<{ secure_delete: number }, []>("PRAGMA secure_delete")
        .get()?.secure_delete
    ).toBe(2);
    await adapter.close();
    const dbBytes = new Uint8Array(await Bun.file(dbPath).arrayBuffer());
    expect(new TextDecoder().decode(dbBytes)).not.toContain(canary);
    const walFile = Bun.file(`${dbPath}-wal`);
    expect((await walFile.exists()) ? walFile.size : 0).toBe(0);
  });

  test("deletes cascades exactly and rolls purge back transactionally", async () => {
    expect(
      (await adapter.createRetrievalTrace(traceInput("cascade", 10_000))).ok
    ).toBe(true);
    expect(
      (
        await adapter.appendRetrievalTraceRun({
          runId: "run",
          traceId: "cascade",
          idempotencyKey: "run",
          kind: "retrieval",
          payload: { ranked: [] },
          createdAtMs: 10_001,
        })
      ).ok
    ).toBe(true);
    expect(
      (
        await adapter.appendRetrievalTraceEvent({
          eventId: "event",
          traceId: "cascade",
          runId: "run",
          idempotencyKey: "event",
          kind: "query",
          payload: { status: "recorded" },
          createdAtMs: 10_002,
        })
      ).ok
    ).toBe(true);
    expect(
      (
        await adapter.appendRetrievalTraceJudgment({
          judgmentId: "judgment",
          traceId: "cascade",
          runId: "run",
          idempotencyKey: "judgment",
          label: "relevant",
          targetKind: "document",
          targetRef: "doc-safe",
          target: { docid: "doc-safe", sourceHash: HASH },
          createdAtMs: 10_003,
        })
      ).ok
    ).toBe(true);
    expect(
      (
        await adapter.appendRetrievalTraceExport({
          exportId: "export",
          traceId: "cascade",
          format: "qrels",
          artifactHash: HASH,
          createdAtMs: 10_004,
        })
      ).ok
    ).toBe(true);
    expect(await adapter.deleteRetrievalTrace("cascade")).toEqual({
      ok: true,
      value: {
        traces: 1,
        runs: 1,
        events: 1,
        judgments: 1,
        exports: 1,
        exportLinks: 1,
      },
    });
    const deleted = await adapter.getRetrievalTrace("cascade");
    expect(deleted.ok).toBe(true);
    if (deleted.ok) expect(deleted.value).toBeNull();
    expect(
      adapter
        .getRawDb()
        .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
        .all()
    ).toEqual([]);

    expect(
      (await adapter.createRetrievalTrace(traceInput("rollback", 20_000))).ok
    ).toBe(true);
    adapter.getRawDb().exec(`
      CREATE TRIGGER block_trace_purge
      BEFORE DELETE ON retrieval_traces
      BEGIN
        SELECT RAISE(ABORT, 'test rollback');
      END
    `);
    const failed = await adapter.purgeRetrievalTraces();
    expect(failed.ok).toBe(false);
    adapter.getRawDb().exec("DROP TRIGGER block_trace_purge");
    const rolledBack = await adapter.getRetrievalTrace("rollback");
    expect(rolledBack.ok).toBe(true);
    if (rolledBack.ok) expect(rolledBack.value).not.toBeNull();
  });

  test("preserves a shared aggregate manifest until its final trace is deleted", async () => {
    for (const [traceId, createdAtMs] of [
      ["aggregate-a", 1000],
      ["aggregate-b", 2000],
    ] as const) {
      expect(
        (await adapter.createRetrievalTrace(traceInput(traceId, createdAtMs)))
          .ok
      ).toBeTrue();
      expect(
        (
          await adapter.finalizeRetrievalTrace(
            traceId,
            "completed",
            createdAtMs + 1
          )
        ).ok
      ).toBeTrue();
    }
    expect(
      (
        await adapter.appendRetrievalTraceExportManifest({
          exportId: "aggregate-export",
          traceIds: ["aggregate-a", "aggregate-b"],
          format: "qrels",
          artifactHash: HASH,
          createdAtMs: 3000,
        })
      ).ok
    ).toBeTrue();

    expect(await adapter.deleteRetrievalTrace("aggregate-a")).toEqual({
      ok: true,
      value: {
        traces: 1,
        runs: 0,
        events: 0,
        judgments: 0,
        exports: 0,
        exportLinks: 1,
      },
    });
    const retained =
      await adapter.getRetrievalTraceExportManifest("aggregate-export");
    expect(retained.ok && retained.value?.traceIds).toEqual(["aggregate-b"]);

    expect(await adapter.deleteRetrievalTrace("aggregate-b")).toEqual({
      ok: true,
      value: {
        traces: 1,
        runs: 0,
        events: 0,
        judgments: 0,
        exports: 1,
        exportLinks: 1,
      },
    });
    const removed =
      await adapter.getRetrievalTraceExportManifest("aggregate-export");
    expect(removed.ok && removed.value).toBeNull();
  });

  test("reports WAL readers truthfully and completes after they release", async () => {
    expect(
      (
        await adapter.createRetrievalTrace(
          traceInput("wal-reader", 10_000, "replay", "reader canary")
        )
      ).ok
    ).toBeTrue();
    const reader = new Database(dbPath);
    try {
      reader.exec("PRAGMA journal_mode = WAL; BEGIN");
      reader.query("SELECT COUNT(*) FROM retrieval_traces").get();
      adapter.getRawDb().exec("PRAGMA busy_timeout = 0");

      const busy = await adapter.purgeRetrievalTraces();
      expect(busy.ok && busy.value).toMatchObject({
        traces: 1,
        physicalCleanup: "wal_busy",
      });
      if (busy.ok) expect(busy.value.remainingWalFrames).toBeGreaterThan(0);
    } finally {
      reader.exec("ROLLBACK");
      reader.close();
    }

    const completed = await adapter.purgeRetrievalTraces();
    expect(completed.ok && completed.value).toMatchObject({
      traces: 0,
      physicalCleanup: "completed",
      remainingWalFrames: 0,
    });
  });
});
