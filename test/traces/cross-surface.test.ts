import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises, node:os, and node:path provide temporary directory structure.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "../../src/mcp/server";

import { RetrievalTraceManagementService } from "../../src/core/retrieval-trace-management";
import {
  handleTraceLabel as handleMcpTraceLabel,
  handleTraceList as handleMcpTraceList,
  handleTraceShow as handleMcpTraceShow,
} from "../../src/mcp/tools/trace";
import {
  handleTraceDelete,
  handleTraceExport,
  handleTraceLabel,
  handleTraceList,
  handleTracePurge,
  handleTraceShow,
} from "../../src/serve/routes/traces";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const QUERY_HASH = new Bun.CryptoHasher("sha256")
  .update("private query")
  .digest("hex");

describe("retrieval trace cross-surface management", () => {
  let root = "";
  let store: SqliteAdapter;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-trace-surfaces-"));
    store = new SqliteAdapter();
    expect((await store.open(join(root, "index.sqlite"), "unicode61")).ok).toBe(
      true
    );
    expect(
      (
        await store.createRetrievalTrace({
          traceId: "surface-trace",
          schemaVersion: "1.0",
          redactionMode: "replay",
          replayCapable: true,
          queryText: "private query",
          queryDigest: QUERY_HASH,
          queryShape: { characters: 13, terms: 2 },
          goalText: null,
          goalDigest: null,
          goalShape: { characters: 0, terms: 0 },
          filters: {},
          fingerprints: {
            pipeline: HASH_A,
            model: HASH_B,
            config: HASH_C,
            index: HASH_D,
          },
          status: "open",
          createdAtMs: 100,
          updatedAtMs: 100,
          expiresAtMs: 100_000,
        })
      ).ok
    ).toBe(true);
    expect(
      (
        await store.appendRetrievalTraceRun({
          runId: "surface-run",
          traceId: "surface-trace",
          idempotencyKey: "surface-run",
          kind: "retrieval",
          payload: {
            ranked: [
              {
                docid: "#abcdef",
                uri: "gno://notes/evidence.md",
                sourceHash: HASH_A,
                mirrorHash: HASH_B,
                passageHash: HASH_C,
                startLine: 3,
                endLine: 4,
                rank: 1,
              },
            ],
          },
          createdAtMs: 101,
        })
      ).ok
    ).toBe(true);
    expect(
      (await store.finalizeRetrievalTrace("surface-trace", "partial", 102)).ok
    ).toBe(true);
  });

  afterEach(async () => {
    await store.close();
    await safeRm(root);
  });

  const context = (enableWrite = false): ToolContext =>
    ({
      store,
      config: {
        version: "1.0",
        ftsTokenizer: "unicode61",
        collections: [],
        contexts: [],
      },
      collections: [],
      actualConfigPath: join(root, "config.yml"),
      indexName: "default",
      toolMutex: { acquire: async () => () => {} },
      jobManager: {},
      serverInstanceId: "test",
      writeLockPath: join(root, ".write.lock"),
      enableWrite,
      isShuttingDown: () => false,
    }) as unknown as ToolContext;

  test("REST and MCP reads project the same bounded service receipts", async () => {
    const service = new RetrievalTraceManagementService(store);
    const directList = await service.list({ limit: 10 });
    if (!directList.ok) throw new Error(directList.error.message);

    const restList = await handleTraceList(
      store,
      new Request("http://127.0.0.1/api/traces?limit=10")
    );
    expect(restList.status).toBe(200);
    expect(await restList.json()).toEqual(directList.value);

    const mcpList = await handleMcpTraceList({ limit: 10 }, context());
    expect(mcpList.isError).toBeUndefined();
    expect(JSON.stringify(mcpList.structuredContent)).toBe(
      JSON.stringify(directList.value)
    );

    const restShow = await handleTraceShow(
      store,
      "surface-trace",
      new Request("http://127.0.0.1/api/traces/surface-trace?detailLimit=10")
    );
    const mcpShow = await handleMcpTraceShow(
      { traceId: "surface-trace", detailLimit: 10 },
      context()
    );
    expect(mcpShow.structuredContent).toEqual(await restShow.json());
    expect(JSON.stringify(directList.value)).not.toContain("private query");
  });

  test("REST labels, aggregate exports, deletes, and purges explicit receipts", async () => {
    const labeled = await handleTraceLabel(
      store,
      "surface-trace",
      new Request("http://127.0.0.1/api/traces/surface-trace/judgments", {
        method: "POST",
        body: JSON.stringify({
          label: "relevant",
          targetRef: "gno://notes/evidence.md",
        }),
      })
    );
    expect(labeled.status).toBe(200);
    expect(await labeled.json()).toMatchObject({
      schemaVersion: "1.0",
      result: "inserted",
      judgment: { label: "relevant" },
    });
    const mcpLabeled = await handleMcpTraceLabel(
      {
        traceId: "surface-trace",
        label: "relevant",
        targetRef: "gno://notes/evidence.md",
      },
      context(true)
    );
    expect(mcpLabeled.isError).toBeUndefined();
    expect(mcpLabeled.structuredContent).toMatchObject({
      schemaVersion: "1.0",
      result: "duplicate",
      judgment: { label: "relevant" },
    });
    expect(JSON.stringify(mcpLabeled.structuredContent)).not.toContain(
      "private query"
    );

    const exported = await handleTraceExport(
      store,
      new Request("http://127.0.0.1/api/traces/export", {
        method: "POST",
        body: JSON.stringify({
          traceIds: ["surface-trace"],
          format: "agentic-receipt",
        }),
      })
    );
    expect(exported.status).toBe(200);
    expect(await exported.json()).toMatchObject({
      manifest: {
        traceIds: ["surface-trace"],
      },
      artifact: {
        traces: [{ trace: { status: "partial" } }],
      },
    });

    const deleted = await handleTraceDelete(store, "surface-trace");
    expect(await deleted.json()).toMatchObject({
      deleted: true,
      counts: { traces: 1 },
    });
    const missing = await handleTraceShow(
      store,
      "surface-trace",
      new Request("http://127.0.0.1/api/traces/surface-trace")
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Retrieval trace not found",
      },
    });

    const purged = await handleTracePurge(store);
    expect(purged.status).toBe(200);
    expect(await purged.json()).toMatchObject({
      schemaVersion: "1.0",
      traces: 0,
    });
  });

  test("malformed requests fail with stable content-free errors", async () => {
    const response = await handleTraceLabel(
      store,
      "secret-trace-id",
      new Request("http://127.0.0.1/api/traces/secret-trace-id/judgments", {
        method: "POST",
        body: "not-json",
      })
    );
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("INVALID_INPUT");
    expect(body).not.toContain("secret-trace-id");

    const malformedExport = await handleTraceExport(
      store,
      new Request("http://127.0.0.1/api/traces/export", {
        method: "POST",
        body: JSON.stringify({ traceIds: "surface-trace" }),
      })
    );
    expect(malformedExport.status).toBe(400);
    expect(await malformedExport.json()).toEqual({
      error: {
        code: "INVALID_INPUT",
        message: "Export trace IDs must be a string array",
      },
    });
  });
});
