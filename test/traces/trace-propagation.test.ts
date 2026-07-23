import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises: temporary directory creation has no Bun equivalent.
import { mkdtemp } from "node:fs/promises";
// node:os and node:path: Bun has no equivalent temp/path helpers.
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "../../src/mcp/server";
import type { StorePort } from "../../src/store/types";

import { writeRetrievalTraceReceipt } from "../../src/cli/program";
import {
  finishRetrievalTraceAfterError,
  retrievalTraceFailureStatus,
} from "../../src/core/retrieval-trace-request";
import {
  RETRIEVAL_TRACE_METADATA,
  RetrievalTraceSession,
} from "../../src/core/retrieval-trace-session";
import { runTool } from "../../src/mcp/tools";
import { searchBm25 } from "../../src/pipeline/search";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
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

describe("retrieval trace propagation", () => {
  let testDir = "";
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-trace-propagation-"));
    adapter = new SqliteAdapter();
    expect(
      (await adapter.open(join(testDir, "index.sqlite"), "unicode61")).ok
    ).toBeTrue();
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  test("CLI exposes enabled trace identity only on stderr", () => {
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    let stderr = "";
    let stdout = "";
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderr += String(chunk);
      return true;
    };
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      stdout += String(chunk);
      return true;
    };
    try {
      writeRetrievalTraceReceipt(undefined);
      expect(stderr).toBe("");
      expect(stdout).toBe("");
      writeRetrievalTraceReceipt({ traceId: "trace-for-get" });
      expect(stderr).toBe("Trace: trace-for-get\n");
      expect(stdout).toBe("");
    } finally {
      process.stderr.write = originalStderrWrite;
      process.stdout.write = originalStdoutWrite;
    }
  });

  test("MCP exposes trace identity only in top-level metadata", async () => {
    const data = { results: [{ uri: "gno://notes/exact.md" }] };
    Object.defineProperty(data, RETRIEVAL_TRACE_METADATA, {
      enumerable: false,
      value: { traceId: "mcp-trace" },
    });
    const result = await runTool(
      {
        isShuttingDown: () => false,
        toolMutex: { acquire: async () => () => undefined },
      } as ToolContext,
      "trace-test",
      async () => data,
      () => "ok"
    );
    expect(result._meta).toEqual({
      gno: { retrievalTrace: { traceId: "mcp-trace" } },
    });
    expect(result.structuredContent).toEqual({
      results: [{ uri: "gno://notes/exact.md" }],
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain("mcp-trace");
  });

  test("disabled tracing performs no clock, ID, fingerprint, or store work", async () => {
    const throwingStore = new Proxy({} as StorePort, {
      get: () => {
        throw new Error("store touched");
      },
    });
    const result = await RetrievalTraceSession.start({
      store: throwingStore,
      config: { enabled: false },
      query: "private",
      clock: () => {
        throw new Error("clock touched");
      },
      idFactory: () => {
        throw new Error("ID touched");
      },
      fingerprints: () => {
        throw new Error("fingerprints touched");
      },
    });
    expect(result).toEqual({ ok: true, value: null });
  });

  test("pre-disables record caps 1, 2, and 3 without trace identity or store work", async () => {
    for (const maxRecordsPerTrace of [1, 2, 3]) {
      let fingerprintCalls = 0;
      const throwingStore = new Proxy({} as StorePort, {
        get: () => {
          throw new Error("store touched");
        },
      });
      const started = await RetrievalTraceSession.start({
        store: throwingStore,
        config: {
          ...enabledConfig,
          retention: {
            ...enabledConfig.retention,
            maxRecordsPerTrace,
          },
        },
        query: "private",
        clock: () => {
          throw new Error("clock touched");
        },
        idFactory: () => {
          throw new Error("ID touched");
        },
        fingerprints: () => {
          fingerprintCalls += 1;
          throw new Error("fingerprints touched");
        },
      });
      expect(started).toEqual({ ok: true, value: null });
      expect(fingerprintCalls).toBe(0);
    }
    const retrieval = await searchBm25(adapter, "still succeeds");
    expect(retrieval.ok).toBeTrue();
    const listed = await adapter.listRetrievalTraces(10);
    expect(listed.ok && listed.value).toHaveLength(0);
  });

  test("classifies setup failures and cancellation as terminal trace outcomes", async () => {
    for (const [traceId, cause, expected] of [
      ["setup-failed", new Error("model setup failed"), "failed"],
      [
        "setup-cancelled",
        Object.assign(new Error("cancelled"), { name: "AbortError" }),
        "cancelled",
      ],
    ] as const) {
      const started = await RetrievalTraceSession.start({
        store: adapter,
        config: enabledConfig,
        query: "boundary setup",
        idFactory: () => traceId,
        fingerprints: () => ({
          pipeline: HASH_A,
          model: HASH_B,
          config: HASH_C,
          index: HASH_D,
        }),
      });
      if (!started.ok || !started.value) throw new Error("trace did not start");
      expect(retrievalTraceFailureStatus(cause)).toBe(expected);
      await finishRetrievalTraceAfterError(started.value, cause);
      const stored = await adapter.getRetrievalTrace(traceId);
      expect(stored.ok && stored.value?.trace.status).toBe(expected);
      expect(stored.ok && stored.value?.events.at(-1)?.payload).toEqual({
        outcome: expected,
      });
    }
  });
});
