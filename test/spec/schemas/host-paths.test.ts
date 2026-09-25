/**
 * Host path contract (fn-181): a remote caller identifies results by `uri`
 * and collection-relative `source.relPath` and never receives
 * `source.absPath`; a same-host caller keeps it for Reveal / Open original.
 * One local and one remote caller per surface (REST /api/search, MCP
 * gno_search), both validated against the search-results schema.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// node:fs/promises for temp fixtures (no Bun equivalent for mkdtemp/mkdir)
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os provides the temporary root
import { tmpdir } from "node:os";
// node:path has no Bun path utilities
import { join } from "node:path";

import type { Collection, Config } from "../../../src/config/types";
import type { RequestPeerServer } from "../../../src/serve/request-locality";
import type { ContextHolder } from "../../../src/serve/routes/api";

import { ENV_DATA_DIR } from "../../../src/app/constants";
import { createDefaultConfig } from "../../../src/config/defaults";
import { SyncService } from "../../../src/ingestion/sync";
import { createToolContext, Mutex } from "../../../src/mcp/context";
import { handleSearch as handleMcpSearch } from "../../../src/mcp/tools/search";
import { withRemoteHostPathRedaction } from "../../../src/serve/host-path-redaction";
import { startServer } from "../../../src/serve/server";
import { SqliteAdapter } from "../../../src/store/sqlite/adapter";
import { safeRm } from "../../helpers/cleanup";
import { assertValid, loadSchema } from "./validator";

const PORT = 3998;
const QUERY = "heliotrope";

interface SearchPayload {
  results: Array<{
    uri: string;
    source: { relPath: string; absPath?: string };
  }>;
}

let root: string;
let collection: Collection;
let config: Config;
let store: SqliteAdapter;
let schema: object;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "gno-host-paths-"));
  const notes = join(root, "notes");
  await mkdir(notes, { recursive: true });
  await Bun.write(join(notes, "garden.md"), `# Garden\n\n${QUERY} beds\n`);
  collection = {
    name: "notes",
    path: notes,
    pattern: "**/*.md",
    include: [],
    exclude: [],
  };
  config = { ...createDefaultConfig(), collections: [collection] };
  store = new SqliteAdapter();
  expect(
    (await store.open(join(root, "index.sqlite"), config.ftsTokenizer)).ok
  ).toBe(true);
  expect((await store.syncCollections(config.collections)).ok).toBe(true);
  await new SyncService().syncCollection(collection, store);
  schema = await loadSchema("search-results");
});

afterAll(async () => {
  await store.close();
  await safeRm(root);
});

/** Both callers see the document by URI and relative path. */
function expectIdentified(payload: SearchPayload): void {
  expect(assertValid(payload, schema)).toBe(true);
  expect(payload.results[0]?.uri).toBe("gno://notes/garden.md");
  expect(payload.results[0]?.source.relPath).toBe("garden.md");
}

describe("REST /api/search", () => {
  const peer = (address: string): RequestPeerServer =>
    ({ requestIP: () => ({ address, port: 50_000, family: "IPv4" }) }) as never;

  test("local caller keeps source.absPath; remote caller gets none", async () => {
    type Handler = (
      req: Request,
      server: RequestPeerServer
    ) => Promise<Response>;
    let routes: Record<string, { POST?: Handler }> = {};
    const ctxHolder: ContextHolder = {
      current: {
        config,
        store,
        indexName: "default",
        vectorIndex: null,
        embedPort: null,
        expandPort: null,
        answerPort: null,
        rerankPort: null,
        capabilities: {
          bm25: true,
          vector: false,
          hybrid: false,
          answer: false,
        },
      },
      config,
      scheduler: null,
      eventBus: null,
      watchService: null,
    };
    const runtime = {
      config,
      store,
      ctxHolder,
      actualConfigPath: join(root, "index.yml"),
      dispose: async () => undefined,
      admitRequest: () => ({
        signal: new AbortController().signal,
        finish: () => undefined,
        authorizationEpoch: "epoch-1",
        isAuthorizationEpochCurrent: () => true,
      }),
      readerGate: { acquire: async () => () => undefined },
      withModelLease: <T>(operation: () => Promise<T>) => operation(),
    };
    const search = async (server: RequestPeerServer) => {
      const response = await routes["/api/search"]?.POST?.(
        new Request(`http://127.0.0.1:${PORT}/api/search`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            host: `127.0.0.1:${PORT}`,
          },
          body: JSON.stringify({ query: QUERY }),
        }),
        server
      );
      expect(response?.status).toBe(200);
      return (await response?.json()) as SearchPayload;
    };

    const previousDataDir = process.env[ENV_DATA_DIR];
    process.env[ENV_DATA_DIR] = join(root, "data");
    try {
      const result = await startServer(
        { port: PORT },
        {
          startBackgroundRuntime: (async () => ({
            success: true as const,
            runtime,
          })) as never,
          createMcpHttpGateway: (async () => ({
            route: async () => new Response("ok"),
            close: async () => undefined,
            security: {},
            transport: {},
          })) as never,
          createClipperRouteGateway: (() => ({ routes: {} })) as never,
          serve: ((options: { routes: typeof routes }) => {
            routes = options.routes;
            return { port: PORT, stop: async () => undefined } as never;
          }) as never,
          waitForShutdown: async () => {
            const local = await search(peer("127.0.0.1"));
            expectIdentified(local);
            expect(local.results[0]?.source.absPath).toBe(
              join(collection.path, "garden.md")
            );

            const remote = await search(peer("203.0.113.7"));
            expectIdentified(remote);
            expect(remote.results[0]?.source).not.toHaveProperty("absPath");
          },
        }
      );
      expect(result).toEqual({ success: true });
    } finally {
      if (previousDataDir === undefined) delete process.env[ENV_DATA_DIR];
      else process.env[ENV_DATA_DIR] = previousDataDir;
    }
  });
});

test("remote original-file download keeps its bytes (doc-asset is exempt)", async () => {
  const source = '{"absPath":"owner data","keep":true}';
  const routes = withRemoteHostPathRedaction({
    "/api/doc-asset": {
      GET: async () =>
        new Response(source, {
          headers: { "content-type": "application/json" },
        }),
    },
  });
  const response = await routes["/api/doc-asset"].GET();
  expect(await response.text()).toBe(source);
});

describe("MCP gno_search", () => {
  test("stdio caller keeps source.absPath; HTTP caller gets none", async () => {
    const ctx = createToolContext({
      store,
      getConfig: () => config,
      actualConfigPath: join(root, "index.yml"),
      indexName: "default",
      toolMutex: new Mutex(),
      jobManager: {} as never,
      serverInstanceId: "host-paths-test",
      writeLockPath: join(root, ".write.lock"),
      enableWrite: false,
      isShuttingDown: () => false,
    });
    const search = async () => {
      const result = await handleMcpSearch({ query: QUERY, limit: 5 }, ctx);
      expect(result.isError).toBeUndefined();
      return {
        payload: result.structuredContent as unknown as SearchPayload,
        text: result.content[0]?.text ?? "",
      };
    };

    const stdio = await search();
    expectIdentified(stdio.payload);
    expect(stdio.payload.results[0]?.source.absPath).toBe(
      join(collection.path, "garden.md")
    );

    const http = await ctx.runWithEgressContext?.(
      {
        destinationZone: "remote",
        caller: { authenticated: true, operationAuthorized: true },
      },
      search
    );
    if (!http) throw new Error("tool context lacks an HTTP egress scope");
    expectIdentified(http.payload);
    expect(http.payload.results[0]?.source).not.toHaveProperty("absPath");
    expect(http.text).not.toContain(root);
  });
});
