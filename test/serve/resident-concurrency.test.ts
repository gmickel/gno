import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises only supplies temporary-directory structure operations.
import { mkdtemp } from "node:fs/promises";
// node:os/node:path have no Bun utility equivalents.
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { HttpMcpTransportRuntime } from "../../src/mcp/http-transport";

import { createToolContext } from "../../src/mcp/context";
import { HttpMcpTransport } from "../../src/mcp/http-transport";
import {
  AdmissionController,
  ReaderGate,
} from "../../src/serve/resident-admission";
import { buildResidentStatusSnapshot } from "../../src/serve/resident-status";
import { SqliteAdapter } from "../../src/store";
import { safeRm } from "../helpers/cleanup";

const MCP_URL = "http://127.0.0.1:3210/mcp";
const MCP_ACCEPT = "application/json, text/event-stream";
const PROTOCOL_VERSION = "2025-11-25";

function config(collection: string): Config {
  return {
    version: "1.0",
    ftsTokenizer: "unicode61",
    collections: [
      {
        name: collection,
        path: `/tmp/${collection}`,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ],
    contexts: [],
  };
}

function createTransportRuntime(): HttpMcpTransportRuntime {
  const toolContext = createToolContext({
    store: {} as never,
    getConfig: () => config("notes"),
    actualConfigPath: "/tmp/config.yml",
    indexName: "default",
    toolMutex: { acquire: async () => () => undefined },
    jobManager: {} as never,
    serverInstanceId: "matrix",
    writeLockPath: "/tmp/write.lock",
    enableWrite: false,
    isShuttingDown: () => false,
  });
  return {
    mcpContext: toolContext,
    isShuttingDown: false,
    admitRequest: () => ({
      id: crypto.randomUUID(),
      signal: new AbortController().signal,
      finish: () => undefined,
    }),
    openSession: () => () => undefined,
  };
}

function postInitialize(id: number): Request {
  return new Request(MCP_URL, {
    method: "POST",
    headers: {
      accept: MCP_ACCEPT,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: `matrix-${id}`, version: "1" },
      },
    }),
  });
}

function sessionRequest(sessionId: string, method = "GET"): Request {
  return new Request(MCP_URL, {
    method,
    headers: {
      accept: "text/event-stream",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": PROTOCOL_VERSION,
    },
  });
}

async function initialize(
  transport: HttpMcpTransport,
  id: number
): Promise<string> {
  const response = await transport.handleRequest(postInitialize(id));
  expect(response.status).toBe(200);
  await response.text();
  return response.headers.get("mcp-session-id")!;
}

describe("resident concurrency matrix", () => {
  let directory: string;
  let dbPath: string;
  let store: SqliteAdapter;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "gno-resident-matrix-"));
    dbPath = join(directory, "index.sqlite");
    store = new SqliteAdapter();
    expect((await store.open(dbPath, "unicode61")).ok).toBe(true);
  });

  afterEach(async () => {
    await store.close();
    await safeRm(directory);
  });

  const matrix: Array<{
    name: string;
    run: () => Promise<void>;
  }> = [
    {
      name: "HTTP/REST reads remain responsive during serialized indexing writes",
      run: async () => {
        store
          .getRawDb()
          .exec("CREATE TABLE resident_probe (value TEXT NOT NULL)");
        let releaseFirst!: () => void;
        const held = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        const firstWrite = store.withTransaction(async () => {
          store
            .getRawDb()
            .run("INSERT INTO resident_probe VALUES (?)", ["first"]);
          await held;
        });
        await Bun.sleep(5);
        const secondWrite = store.withTransaction(async () => {
          store
            .getRawDb()
            .run("INSERT INTO resident_probe VALUES (?)", ["second"]);
        });
        const reads = await Promise.all(
          Array.from({ length: 16 }, async () =>
            store
              .getRawDb()
              .query<{ count: number }, []>(
                "SELECT COUNT(*) AS count FROM resident_probe"
              )
              .get()
          )
        );
        expect(reads.every((row) => (row?.count ?? 0) >= 1)).toBe(true);
        releaseFirst();
        const writes = await Promise.all([firstWrite, secondWrite]);
        expect(writes.every((result) => result.ok)).toBe(true);
      },
    },
    {
      name: "two sessions isolate disconnect and idle reap accounting",
      run: async () => {
        let now = 10;
        const transport = new HttpMcpTransport(createTransportRuntime(), {
          createServer: () => new McpServer({ name: "matrix", version: "1" }),
          idleTimeoutMs: 50,
          maxConcurrentRequests: 2,
          maxQueuedRequests: 2,
          maxSessions: 2,
          now: () => now,
        });
        const [first, second] = await Promise.all([
          initialize(transport, 1),
          initialize(transport, 2),
        ]);
        expect(transport.getStatus().activeSessions).toBe(2);
        const stream = await transport.handleRequest(sessionRequest(first));
        expect(transport.getStatus().activeRequests).toBe(1);
        await stream.body?.cancel("client disconnected");
        await transport.handleRequest(sessionRequest(second, "DELETE"));
        now = 100;
        expect(await transport.reapIdleSessions()).toBe(1);
        expect(transport.getStatus()).toMatchObject({
          activeRequests: 0,
          activeSessions: 0,
          queuedRequests: 0,
        });
        await transport.close();
      },
    },
    {
      name: "cancellation, config refresh, and model failure stay request-local",
      run: async () => {
        const admission = new AdmissionController();
        const firstParent = new AbortController();
        const first = admission.admit(firstParent.signal);
        const second = admission.admit();
        firstParent.abort("cancel first");
        expect(first?.signal.aborted).toBe(true);
        expect(second?.signal.aborted).toBe(false);
        first?.finish();
        second?.finish();

        const readers = new ReaderGate(1, 1);
        const releaseReader = await readers.acquire();
        const queuedReader = readers.acquire();
        let readerQueueError: unknown;
        try {
          await readers.acquire();
        } catch (error) {
          readerQueueError = error;
        }
        expect(readerQueueError).toBeInstanceOf(Error);
        expect((readerQueueError as Error).message).toBe(
          "Resident reader queue is full"
        );
        releaseReader();
        (await queuedReader)();

        let currentConfig = config("before");
        const context = createToolContext({
          store: {} as never,
          getConfig: () => currentConfig,
          actualConfigPath: "/tmp/config.yml",
          indexName: "default",
          toolMutex: { acquire: async () => () => undefined },
          jobManager: {} as never,
          serverInstanceId: "matrix",
          writeLockPath: "/tmp/write.lock",
          enableWrite: false,
          isShuttingDown: () => false,
        });
        const observed = await context.runWithSnapshot?.(async () => {
          currentConfig = config("after");
          await Promise.resolve();
          return context.collections[0]?.name;
        });
        expect(observed).toBe("before");
        expect(context.collections[0]?.name).toBe("after");

        const status = buildResidentStatusSnapshot({
          mode: "serve",
          startedAt: 0,
          now: 1,
          listenerPort: 3210,
          admission: { state: "accepting", activeRequests: 0 },
          shutdown: { state: "none" },
          transport: {
            activeRequests: 0,
            activeSessions: 0,
            queuedRequests: 0,
            maxConcurrentRequests: 2,
            maxQueuedRequests: 2,
            maxSessions: 2,
          },
          readers: { active: 0, queued: 0, limit: 8, maxQueued: 64 },
          models: {
            activeLeases: 0,
            leaseAcquisitions: 1,
            leaseReleases: 1,
            loadedModels: 0,
            loadAttempts: 1,
            loadSuccesses: 0,
            loadFailures: 1,
            inflightLoads: 0,
          },
          jobs: { active: 0, recent: 0, failed: 0 },
          generations: { content: 0, index: 0 },
        });
        expect(status.models).toMatchObject({
          activeLeases: 0,
          loadFailures: 1,
          inflightLoads: 0,
        });
      },
    },
    {
      name: "graceful drain, deadline shutdown, restart, and DB recovery preserve integrity",
      run: async () => {
        const graceful = new AdmissionController();
        const gracefulRequest = graceful.admit();
        const gracefulDrain = graceful.closeAndDrain(100);
        gracefulRequest?.finish();
        expect(await gracefulDrain).toBe(false);

        const forced = new AdmissionController();
        const forcedRequest = forced.admit();
        expect(await forced.closeAndDrain(0)).toBe(true);
        expect(forcedRequest?.signal.aborted).toBe(true);

        await store.close();
        store = new SqliteAdapter();
        expect((await store.open(dbPath, "unicode61")).ok).toBe(true);
        const integrity = store
          .getRawDb()
          .query<{ quick_check: string }, []>("PRAGMA quick_check")
          .get()?.quick_check;
        expect(integrity).toBe("ok");
      },
    },
  ];

  for (const scenario of matrix) {
    test(scenario.name, scenario.run);
  }
});
