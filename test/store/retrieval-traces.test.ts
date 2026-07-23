import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises: temporary directory creation/removal has no Bun equivalent.
import { mkdtemp } from "node:fs/promises";
// node:os and node:path: Bun has no path/temp-directory utilities.
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RetrievalTraceInput, StorePort } from "../../src/store/types";

import { RetrievalTraceConfigSchema } from "../../src/config";
import { RetrievalTraceRecorder } from "../../src/core/retrieval-trace";
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

describe("private retrieval trace storage", () => {
  let testDir = "";
  let dbPath = "";
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-retrieval-traces-"));
    dbPath = join(testDir, "index.sqlite");
    adapter = new SqliteAdapter();
    const opened = await adapter.open(dbPath, "unicode61");
    expect(opened.ok).toBe(true);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  test("keeps recording off by default and requires explicit enabled controls", async () => {
    expect(
      RetrievalTraceConfigSchema.safeParse({ enabled: false }).success
    ).toBe(true);
    expect(
      RetrievalTraceConfigSchema.safeParse({
        enabled: false,
        redactionMode: "replay",
      }).success
    ).toBe(false);
    expect(
      RetrievalTraceConfigSchema.safeParse({ enabled: true }).success
    ).toBe(false);

    let idCalls = 0;
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("Network access forbidden in retrieval trace tests");
    }) as unknown as typeof fetch;
    const recorder = new RetrievalTraceRecorder({} as StorePort, undefined, {
      idFactory: () => {
        idCalls += 1;
        return "should-not-be-created";
      },
    });
    let result: Awaited<ReturnType<typeof recorder.start>>;
    try {
      result = await recorder.start({
        query: "must never be persisted",
        fingerprints: {
          pipeline: HASH,
          model: HASH,
          config: HASH,
          index: HASH,
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(result).toEqual({
      ok: true,
      value: {
        recorded: false,
        traceId: null,
        replayCapable: false,
        result: "disabled",
      },
    });
    expect(idCalls).toBe(0);
    expect(fetchCalls).toBe(0);
    const listed = await adapter.listRetrievalTraces(10);
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value).toHaveLength(0);
  });

  test("pre-disables undersized lifecycles and reports concurrent retention eviction", async () => {
    for (const maxRecordsPerTrace of [1, 2, 3]) {
      const recorder = new RetrievalTraceRecorder(
        new Proxy({} as StorePort, {
          get: () => {
            throw new Error("store touched");
          },
        }),
        {
          enabled: true,
          redactionMode: "replay",
          retention: {
            maxAgeDays: 30,
            maxTraces: 100,
            maxRecordsPerTrace,
            maxBytes: 1_000_000,
          },
        },
        {
          clock: () => {
            throw new Error("clock touched");
          },
          idFactory: () => {
            throw new Error("ID touched");
          },
        }
      );
      expect(
        await recorder.start({
          query: "must not start",
          fingerprints: {
            pipeline: HASH,
            model: HASH,
            config: HASH,
            index: HASH,
          },
        })
      ).toEqual({
        ok: true,
        value: {
          recorded: false,
          traceId: null,
          replayCapable: false,
          result: "disabled",
        },
      });
    }

    const config = {
      enabled: true,
      redactionMode: "replay" as const,
      retention: {
        maxAgeDays: 30,
        maxTraces: 1,
        maxRecordsPerTrace: 100,
        maxBytes: 1_000_000,
      },
    };
    const first = new RetrievalTraceRecorder(adapter, config, {
      clock: () => 1_000,
      idFactory: () => "direct-first",
    });
    const second = new RetrievalTraceRecorder(adapter, config, {
      clock: () => 2_000,
      idFactory: () => "direct-second",
    });
    expect(
      (
        await first.start({
          query: "first",
          fingerprints: {
            pipeline: HASH,
            model: HASH,
            config: HASH,
            index: HASH,
          },
        })
      ).ok
    ).toBeTrue();
    expect(
      (
        await second.start({
          query: "second",
          fingerprints: {
            pipeline: HASH,
            model: HASH,
            config: HASH,
            index: HASH,
          },
        })
      ).ok
    ).toBeTrue();
    const evictedWrite = await first.appendEvent({
      eventId: "evicted-event",
      traceId: "direct-first",
      runId: null,
      idempotencyKey: "evicted-event",
      kind: "query",
      payload: {},
      createdAtMs: 1_001,
    });
    expect(evictedWrite.ok).toBeFalse();
    if (!evictedWrite.ok) {
      expect(evictedWrite.error.code).toBe("CONSTRAINT_VIOLATION");
    }
  });

  test("metadata mode persists only content-free shapes", async () => {
    const recorder = new RetrievalTraceRecorder(
      adapter,
      {
        enabled: true,
        redactionMode: "metadata",
        retention: {
          maxAgeDays: 30,
          maxTraces: 100,
          maxRecordsPerTrace: 1000,
          maxBytes: 1_000_000,
        },
      },
      {
        clock: () => 10_000,
        idFactory: () => "metadata-trace",
        redactionSecret: "test-redaction-secret",
      }
    );
    const result = await recorder.start({
      query: "unique secret query canary",
      goal: "private customer goal",
      filters: {
        collection: "secret-client",
        uriPrefix: "/Users/private/client",
      },
      fingerprints: {
        pipeline: HASH,
        model: HASH,
        config: HASH,
        index: HASH,
      },
    });
    expect(result.ok).toBe(true);
    const stored = await adapter.getRetrievalTrace("metadata-trace");
    expect(stored.ok).toBe(true);
    if (!(stored.ok && stored.value)) return;
    expect(stored.value.trace).toMatchObject({
      queryText: null,
      queryDigest: null,
      goalText: null,
      goalDigest: null,
      replayCapable: false,
    });
    const serialized = JSON.stringify(stored.value);
    expect(serialized).not.toContain("unique secret query canary");
    expect(serialized).not.toContain("secret-client");
    expect(serialized).not.toContain("/Users/private/client");

    const event = await recorder.appendEvent({
      eventId: "metadata-evidence",
      traceId: "metadata-trace",
      runId: null,
      idempotencyKey: "metadata-evidence",
      kind: "retrieval",
      payload: {
        ranked: [
          {
            docid: "doc-safe",
            sourceHash: HASH,
            uri: "gno://notes/safe.md",
            startLine: 4,
            endLine: 8,
            rank: 1,
            score: 0.9,
          },
        ],
      },
      createdAtMs: 10_001,
    });
    expect(event.ok).toBe(true);
    const withEvidence = await adapter.getRetrievalTrace("metadata-trace");
    expect(withEvidence.ok && withEvidence.value?.events[0]?.payload).toEqual({
      ranked: [
        {
          docid: "doc-safe",
          sourceHash: HASH,
          uri: "gno://notes/safe.md",
          startLine: 4,
          endLine: 8,
          rank: 1,
          score: 0.9,
        },
      ],
    });
  });

  test("rejects replay passages, absolute paths, and external evidence URLs", async () => {
    const recorder = new RetrievalTraceRecorder(
      adapter,
      {
        enabled: true,
        redactionMode: "replay",
        retention: {
          maxAgeDays: 30,
          maxTraces: 100,
          maxRecordsPerTrace: 1000,
          maxBytes: 1_000_000,
        },
      },
      { clock: () => 10_000, idFactory: () => "safe-replay" }
    );
    expect(
      (
        await recorder.start({
          query: "consented query",
          fingerprints: {
            pipeline: HASH,
            model: HASH,
            config: HASH,
            index: HASH,
          },
        })
      ).ok
    ).toBe(true);
    const rawCanary = "raw-passage-canary-9341";
    const rejected = await recorder.appendEvent({
      eventId: "unsafe-event",
      traceId: "safe-replay",
      runId: null,
      idempotencyKey: "unsafe-event",
      kind: "retrieval",
      payload: {
        ranked: [
          {
            docid: "doc",
            uri: "https://example.test/private?token=secret",
            path: "/Users/private/customer.md",
            passage: rawCanary,
          },
        ],
      },
      createdAtMs: 10_001,
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("INVALID_INPUT");
    for (const [index, evidence] of [
      {},
      { docid: "doc", startLine: 4 },
      { docid: "doc", startLine: 8, endLine: 4 },
    ].entries()) {
      const invalidRange = await recorder.appendEvent({
        eventId: `invalid-evidence-${index}`,
        traceId: "safe-replay",
        runId: null,
        idempotencyKey: `invalid-evidence-${index}`,
        kind: "retrieval",
        payload: { ranked: [evidence] },
        createdAtMs: 10_002 + index,
      });
      expect(invalidRange.ok).toBe(false);
      if (!invalidRange.ok) {
        expect(invalidRange.error.code).toBe("INVALID_INPUT");
      }
    }
    const stored = await adapter.getRetrievalTrace("safe-replay");
    expect(stored.ok && stored.value?.events).toHaveLength(0);
    expect(JSON.stringify(stored)).not.toContain(rawCanary);
  });

  test("replay mode is explicit, idempotent, and finalization preserves creation identity", async () => {
    const input = traceInput(
      "replay-trace",
      1_000,
      "replay",
      "consented replay query"
    );
    expect(await adapter.createRetrievalTrace(input)).toEqual({
      ok: true,
      value: "inserted",
    });
    expect(await adapter.createRetrievalTrace(input)).toEqual({
      ok: true,
      value: "duplicate",
    });
    expect(
      await adapter.finalizeRetrievalTrace("replay-trace", "partial", 2_000)
    ).toEqual({ ok: true, value: "inserted" });
    expect(await adapter.createRetrievalTrace(input)).toEqual({
      ok: true,
      value: "duplicate",
    });
    const stored = await adapter.getRetrievalTrace("replay-trace");
    expect(stored.ok && stored.value?.trace.status).toBe("partial");
    expect(stored.ok && stored.value?.trace.queryText).toBe(
      "consented replay query"
    );
  });

  test("settles duplicate events once across two SQLite processes", async () => {
    expect(
      (await adapter.createRetrievalTrace(traceInput("concurrent-trace", 500)))
        .ok
    ).toBe(true);
    const barrier = join(testDir, "start");
    const worker = join(
      import.meta.dir,
      "../fixtures/retrieval-trace-concurrent-worker.ts"
    );
    const processes = [0, 1].map(() =>
      Bun.spawn([process.execPath, worker, dbPath, barrier], {
        stdout: "pipe",
        stderr: "pipe",
      })
    );
    await Bun.sleep(100);
    await Bun.write(barrier, "go");
    const outputs = await Promise.all(
      processes.map(async (process) => {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
          process.exited,
        ]);
        expect(stderr).toBe("");
        expect(exitCode).toBe(0);
        return JSON.parse(stdout) as {
          ok: boolean;
          value: "inserted" | "duplicate";
        };
      })
    );
    expect(outputs.map((output) => output.value).sort()).toEqual([
      "duplicate",
      "inserted",
    ]);
    const stored = await adapter.getRetrievalTrace("concurrent-trace");
    expect(stored.ok && stored.value?.events).toHaveLength(1);

    const mismatch = await adapter.appendRetrievalTraceEvent({
      eventId: "different-event",
      traceId: "concurrent-trace",
      runId: null,
      idempotencyKey: "same-event",
      kind: "query",
      payload: { status: "different" },
      createdAtMs: 1_000,
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.code).toBe("CONSTRAINT_VIOLATION");
  });

  test("keeps idempotent retries valid at the hard record cap", async () => {
    expect(
      (await adapter.createRetrievalTrace(traceInput("cap-trace", 500))).ok
    ).toBe(true);
    const db = adapter.getRawDb();
    db.exec(`
      DROP TRIGGER cap_retrieval_trace_events;
      CREATE TRIGGER cap_retrieval_trace_events
      BEFORE INSERT ON retrieval_trace_events
      WHEN (
        SELECT COUNT(*) FROM retrieval_trace_events
        WHERE trace_id = NEW.trace_id
      ) >= 1
      AND NOT EXISTS (
        SELECT 1 FROM retrieval_trace_events existing
        WHERE existing.event_id = NEW.event_id
           OR (
             existing.trace_id = NEW.trace_id
             AND existing.idempotency_key = NEW.idempotency_key
           )
      )
      BEGIN
        SELECT RAISE(ABORT, 'retrieval trace record cap exceeded');
      END
    `);
    const event = {
      eventId: "cap-event",
      traceId: "cap-trace",
      runId: null,
      idempotencyKey: "cap-event",
      kind: "query" as const,
      payload: { status: "recorded" },
      createdAtMs: 501,
    };
    expect(await adapter.appendRetrievalTraceEvent(event)).toEqual({
      ok: true,
      value: "inserted",
    });
    expect(await adapter.appendRetrievalTraceEvent(event)).toEqual({
      ok: true,
      value: "duplicate",
    });
    const capped = await adapter.appendRetrievalTraceEvent({
      ...event,
      eventId: "cap-event-2",
      idempotencyKey: "cap-event-2",
    });
    expect(capped.ok).toBe(false);
    if (!capped.ok) {
      expect(capped.error.code).toBe("CONSTRAINT_VIOLATION");
      expect(capped.error.message).toContain("record cap exceeded");
    }
  });

  test("applies changed age and aggregate byte limits deterministically", async () => {
    for (const [index, traceId] of ["older-a", "older-b", "newer"].entries()) {
      const createdAtMs = index;
      expect(
        (await adapter.createRetrievalTrace(traceInput(traceId, createdAtMs)))
          .ok
      ).toBe(true);
      expect(
        (
          await adapter.appendRetrievalTraceEvent({
            eventId: `event-${traceId}`,
            traceId,
            runId: null,
            idempotencyKey: `event-${traceId}`,
            kind: "retrieval",
            payload: { tags: Array(12).fill("x".repeat(4000)) },
            createdAtMs,
          })
        ).ok
      ).toBe(true);
    }
    const result = await adapter.enforceRetrievalTraceRetention(
      {
        maxAgeDays: 1,
        maxTraces: 100,
        maxRecordsPerTrace: 1000,
        maxBytes: 65_536,
      },
      DAY_MS
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deletedTraceIds).toEqual(["older-a", "older-b"]);
    expect(result.value.remainingTraces).toBe(1);
    expect(result.value.deleted.events).toBe(2);
  });

  test("rejects UTF-8 byte overflow before SQLite", async () => {
    const oversized = traceInput(
      "unicode-overflow",
      1_000,
      "replay",
      "🔥".repeat(3000)
    );
    const rejected = await adapter.createRetrievalTrace(oversized);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("INVALID_INPUT");
  });
});
