/**
 * REST adapters for the session archive (fn-171): status, import by
 * registered source ID, owner-only discovery/registration/init, and the
 * error envelope. Hermetic: temp GNO dirs, synthetic fixtures only.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
// node:fs/promises for temp fixtures (no Bun equivalent for cp/mkdir/readdir)
import { cp, mkdir, readdir } from "node:fs/promises";
// node:path has no Bun path utilities
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { ServerContext } from "../../src/serve/context";
import type { RequestPeerServer } from "../../src/serve/request-locality";
import type { ContextHolder } from "../../src/serve/routes/api";
import type { SqliteAdapter } from "../../src/store/sqlite/adapter";

import { initStore } from "../../src/cli/commands/shared";
import { getConfigPaths, loadConfig, saveConfigToPath } from "../../src/config";
import { acquireWriteLock } from "../../src/core/file-lock";
import { searchBm25 } from "../../src/pipeline/search";
import { ReaderGate } from "../../src/serve/resident-admission";
import {
  handleSessionsAddSource,
  handleSessionsAutomationDisable,
  handleSessionsAutomationEnable,
  handleSessionsAutomationPreview,
  handleSessionsAutomationRemove,
  handleSessionsAutomationRun,
  handleSessionsAutomationSet,
  handleSessionsDiscover,
  handleSessionsImport,
  handleSessionsInit,
  handleSessionsRemoveSource,
  handleSessionsStatus,
  refreshSessionsConfig,
  sessionsErrorResponse,
} from "../../src/serve/routes/sessions";
import { startServer } from "../../src/serve/server";
import { setAutomationProfile } from "../../src/sessions/automation";
import {
  addSessionSource,
  initSessionArchive,
  removeSessionSource,
} from "../../src/sessions/setup";
import { importLockPath } from "../../src/sessions/state";
import { safeRm } from "../helpers/cleanup";
import {
  FIXTURES,
  snapshotSessionEnv,
  tempDir,
  writeSyntheticCodexRollouts,
} from "../sessions/helpers";
import { assertValid, loadSchema } from "../spec/schemas/validator";

const INDEX = "sessions";
const ORIGIN = "http://127.0.0.1:3000";

interface ErrorBody {
  error: { code: string; message: string; details?: { sessionsCode?: string } };
}

const localServer: RequestPeerServer = {
  requestIP: () => ({ address: "127.0.0.1", port: 49_152, family: "IPv4" }),
};
const remoteServer: RequestPeerServer = {
  requestIP: () => ({ address: "10.0.0.8", port: 49_152, family: "IPv4" }),
};

let root: string;
let configPath: string;
let archiveRoot: string;
let codexRoot: string;
let store: SqliteAdapter;
let ctxHolder: ContextHolder;
let markContent: ReturnType<typeof mock>;
const restoreEnv = snapshotSessionEnv();

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, {
    recursive: true,
    withFileTypes: true,
  }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

async function openHolder(path: string, indexName = INDEX): Promise<void> {
  const opened = await initStore({
    configPath: path,
    indexName,
    allowEmptyCollections: true,
  });
  if (!opened.ok) throw new Error(opened.error);
  store = opened.store;
  markContent = mock(() => undefined);
  ctxHolder = {
    current: {
      config: opened.config,
      indexName,
    } as unknown as ServerContext,
    config: opened.config,
    actualConfigPath: path,
    scheduler: null,
    eventBus: null,
    watchService: null,
    markContentMutation: markContent,
    markIndexMutation: () => undefined,
  };
}

function post(path: string, body: unknown, method = "POST"): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:3000",
      origin: ORIGIN,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function expectError(
  response: Response,
  status: number,
  sessionsCode?: string
): Promise<ErrorBody> {
  expect(response.status).toBe(status);
  const body = (await response.json()) as ErrorBody;
  if (sessionsCode) expect(body.error.details?.sessionsCode).toBe(sessionsCode);
  return body;
}

beforeEach(async () => {
  root = await tempDir("gno-sessions-api-");
  process.env.GNO_CONFIG_DIR = join(root, "gno-config");
  process.env.GNO_DATA_DIR = join(root, "gno-data");
  process.env.GNO_CACHE_DIR = join(root, "gno-cache");
  configPath = join(root, "archive.yml");
  archiveRoot = join(root, "archive");
  codexRoot = join(root, "sources", "codex");
  await mkdir(codexRoot, { recursive: true });
  await cp(join(FIXTURES, "codex"), codexRoot, { recursive: true });
  await initSessionArchive({
    configPath,
    indexName: INDEX,
    archiveRoot,
    collection: "work",
  });
  await addSessionSource({
    configPath,
    id: "codex-main",
    harness: "codex",
    path: codexRoot,
    collection: "work",
  });
  await openHolder(configPath);
});

afterEach(async () => {
  restoreEnv();
  await store?.close();
  await safeRm(root);
});

describe("GET /api/sessions/status", () => {
  test("reports the bound archive without host paths", async () => {
    const response = await handleSessionsStatus(ctxHolder);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(root);
    const status = JSON.parse(text) as {
      configured: boolean;
      index: string;
      sources: Array<{ id: string; units: { pending: number } }>;
    };
    expect(status.configured).toBe(true);
    expect(status.index).toBe(INDEX);
    expect(status.sources[0]?.id).toBe("codex-main");
    expect(status.sources[0]?.units.pending).toBe(4);
  });

  test("an instance without a sessions block is not configured", async () => {
    const curated = { ...ctxHolder.config, sessions: undefined } as Config;
    await saveConfigToPath(curated, configPath);
    expect(await refreshSessionsConfig(ctxHolder, store)).toBeNull();
    await expectError(
      await handleSessionsStatus(ctxHolder),
      400,
      "SESSIONS_NOT_CONFIGURED"
    );
  });

  test("CLI source changes show without a restart and Remove still succeeds", async () => {
    const sourceIds = async (): Promise<string[]> => {
      expect(await refreshSessionsConfig(ctxHolder, store)).toBeNull();
      const response = await handleSessionsStatus(ctxHolder);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        sources: Array<{ id: string }>;
      };
      return body.sources.map((source) => source.id);
    };
    expect(await sourceIds()).toEqual(["codex-main"]);

    // Same config file, changed by another process (the CLI).
    await addSessionSource({
      configPath,
      id: "codex-two",
      harness: "codex",
      path: codexRoot,
      collection: "second",
    });
    expect(await sourceIds()).toEqual(["codex-main", "codex-two"]);
    const stored = await store.getCollections();
    expect(stored.ok && stored.value.map((c) => c.name)).toContain("second");

    // The page still lists codex-main after the CLI removed it.
    await removeSessionSource({ configPath, id: "codex-main" });
    const removed = await handleSessionsRemoveSource(
      ctxHolder,
      store,
      "codex-main",
      post("/api/sessions/sources/codex-main", undefined, "DELETE"),
      { server: localServer }
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({
      id: "codex-main",
      removed: true,
      archiveRetained: true,
    });
    expect(await sourceIds()).toEqual(["codex-two"]);
  });

  test("an unreadable config is reported, not served stale", async () => {
    await Bun.write(configPath, "version: [not valid\n");
    const failed = await refreshSessionsConfig(ctxHolder, store);
    if (!failed) throw new Error("expected an error response");
    const body = await expectError(failed, 500, "SESSIONS_RUNTIME_FAILURE");
    expect(body.error.message).toContain("could not read its config file");
    expect(body.error.message).not.toContain(root);
  });

  test("a config rebound to another index is refused before it touches this one", async () => {
    const served = ctxHolder.config;
    const rebound = {
      ...served,
      collections: [],
      sessions: { ...served.sessions!, index: "other" },
    } as Config;
    await saveConfigToPath(rebound, configPath);
    const failed = await refreshSessionsConfig(ctxHolder, store);
    if (!failed) throw new Error("expected an error response");
    await expectError(failed, 400, "SESSIONS_BINDING_MISMATCH");
    expect(ctxHolder.config).toBe(served);
    const stored = await store.getCollections();
    expect(stored.ok && stored.value.map((c) => c.name)).toEqual(["work"]);
  });
});

describe("POST /api/sessions/import", () => {
  test("the import child uses the server's config and never syncs the file's into the index", async () => {
    const loaded = await loadConfig(configPath);
    if (!loaded.ok) throw new Error(loaded.error.message);
    await saveConfigToPath(
      {
        ...loaded.value,
        collections: [
          ...loaded.value.collections,
          {
            ...loaded.value.collections[0]!,
            name: "ghost",
            path: join(root, "ghost"),
          },
        ],
      },
      configPath
    );
    const response = await handleSessionsImport(
      ctxHolder,
      post("/api/sessions/import", { sourceId: "codex-main" })
    );
    expect(response.status).toBe(200);
    const collections = await store.getCollections();
    if (!collections.ok) throw new Error(collections.error.message);
    expect(collections.value.map((row) => row.name)).not.toContain("ghost");
  });

  // Imported in-process, each of these archive files syncs in one multi-second
  // transaction and the server stops answering; the child process keeps the
  // event loop free. The bound is generous for slow CI runners.
  test(
    "a large import leaves the server's event loop responsive",
    async () => {
      const MAX_TIMER_DRIFT_MS = 1000;
      await writeSyntheticCodexRollouts(codexRoot, 3, 300);
      let maxDrift = 0;
      let expected = performance.now() + 20;
      const probe = setInterval(() => {
        const now = performance.now();
        maxDrift = Math.max(maxDrift, now - expected);
        expected = now + 20;
      }, 20);
      let response: Response;
      try {
        response = await handleSessionsImport(
          ctxHolder,
          post("/api/sessions/import", { sourceId: "codex-main" })
        );
      } finally {
        clearInterval(probe);
      }
      expect(response.status).toBe(200);
      const receipt = (await response.json()) as {
        counts: { imported: number };
      };
      expect(receipt.counts.imported).toBeGreaterThanOrEqual(3);
      expect(maxDrift).toBeLessThan(MAX_TIMER_DRIFT_MS);
    },
    { timeout: 180_000 }
  );

  test(
    "an automation Run now leaves the server's event loop responsive",
    async () => {
      const MAX_TIMER_DRIFT_MS = 1000;
      await writeSyntheticCodexRollouts(codexRoot, 3, 300);
      await setAutomationProfile(
        { configPath, indexName: INDEX },
        { id: "main", sources: ["codex-main"] }
      );
      let maxDrift = 0;
      let expected = performance.now() + 20;
      const probe = setInterval(() => {
        const now = performance.now();
        maxDrift = Math.max(maxDrift, now - expected);
        expected = now + 20;
      }, 20);
      let response: Response;
      try {
        response = await handleSessionsAutomationRun(
          ctxHolder,
          store,
          post("/api/sessions/automation/run", { profileId: "main" })
        );
      } finally {
        clearInterval(probe);
      }
      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        ran: boolean;
        receipts: Array<{ counts: { imported: number } }>;
      };
      expect(result.ran).toBe(true);
      expect(result.receipts[0]?.counts.imported).toBeGreaterThanOrEqual(3);
      expect(maxDrift).toBeLessThan(MAX_TIMER_DRIFT_MS);
    },
    { timeout: 180_000 }
  );

  test("dry run writes nothing and reports redaction/destination policy", async () => {
    const response = await handleSessionsImport(
      ctxHolder,
      post("/api/sessions/import", { sourceId: "codex-main", dryRun: true })
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(root);
    const receipt = JSON.parse(text) as {
      dryRun: boolean;
      units: Array<{ collections: string[] }>;
      turns: { redactions: number };
    };
    expect(receipt.dryRun).toBe(true);
    expect(
      receipt.units.some((unit) => unit.collections.includes("work"))
    ).toBe(true);
    expect(typeof receipt.turns.redactions).toBe("number");
    expect(await listFiles(join(archiveRoot, "work"))).toEqual([]);
    expect(markContent).not.toHaveBeenCalled();
  });

  test("imports a registered source by ID and makes it searchable", async () => {
    const response = await handleSessionsImport(
      ctxHolder,
      post("/api/sessions/import", { sourceId: "codex-main" })
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(root);
    const receipt = JSON.parse(text) as {
      dryRun: boolean;
      status: string;
      counts: { imported: number };
      lexical: { status: string; collections: string[] };
    };
    expect(receipt.dryRun).toBe(false);
    expect(["complete", "partial"]).toContain(receipt.status);
    expect(receipt.counts.imported).toBeGreaterThan(0);
    expect(receipt.lexical).toMatchObject({
      status: "ready",
      collections: ["work"],
    });
    expect(markContent).toHaveBeenCalled();
    expect((await listFiles(join(archiveRoot, "work"))).length).toBeGreaterThan(
      0
    );
    const found = await searchBm25(store, "Human", {
      limit: 5,
      tagsAll: ["session", "harness/codex"],
    });
    expect(found.ok && found.value.results.length > 0).toBe(true);
  });

  test("host paths are refused before any read or write", async () => {
    await expectError(
      await handleSessionsImport(
        ctxHolder,
        post("/api/sessions/import", { paths: [codexRoot] })
      ),
      400,
      "SESSIONS_UNSAFE_PATH"
    );
    for (const extra of [{ collection: "work" }, { format: "codex" }]) {
      await expectError(
        await handleSessionsImport(
          ctxHolder,
          post("/api/sessions/import", { sourceId: "codex-main", ...extra })
        ),
        400,
        "SESSIONS_INVALID_INPUT"
      );
    }
    await expectError(
      await handleSessionsImport(ctxHolder, post("/api/sessions/import", {})),
      400,
      "SESSIONS_SELECTION_REQUIRED"
    );
    expect(await listFiles(archiveRoot)).toEqual([]);
  });

  test("an unknown source is a validation error", async () => {
    await expectError(
      await handleSessionsImport(
        ctxHolder,
        post("/api/sessions/import", { sourceId: "nope" })
      ),
      400,
      "SESSIONS_UNKNOWN_SOURCE"
    );
  });

  test("a concurrent import answers 409 busy", async () => {
    await mkdir(join(archiveRoot, ".gno-sessions"), { recursive: true });
    const held = await acquireWriteLock(importLockPath(archiveRoot), 1_000);
    expect(held).not.toBeNull();
    try {
      const body = await expectError(
        await handleSessionsImport(
          ctxHolder,
          post("/api/sessions/import", { sourceId: "codex-main" })
        ),
        409,
        "SESSIONS_BUSY"
      );
      expect(body.error.code).toBe("BUSY");
    } finally {
      await held?.release();
    }
  });
});

describe("owner-only routes", () => {
  test("discover, sources and init refuse non-local requests", async () => {
    for (const server of [undefined, remoteServer]) {
      const deps = server ? { server } : {};
      await expectError(
        await handleSessionsDiscover(
          ctxHolder,
          new Request(`${ORIGIN}/api/sessions/discover`, {
            headers: { host: "127.0.0.1:3000" },
          }),
          deps
        ),
        403
      );
      await expectError(
        await handleSessionsAddSource(
          ctxHolder,
          store,
          post("/api/sessions/sources", {
            id: "other",
            harness: "codex",
            path: codexRoot,
            collection: "work",
          }),
          deps
        ),
        403
      );
      await expectError(
        await handleSessionsRemoveSource(
          ctxHolder,
          store,
          "codex-main",
          post("/api/sessions/sources/codex-main", undefined, "DELETE"),
          deps
        ),
        403
      );
      await expectError(
        await handleSessionsInit(
          ctxHolder,
          store,
          post("/api/sessions/init", { archive: archiveRoot, collection: "x" }),
          deps
        ),
        403
      );
    }
    const loaded = await loadConfig(configPath);
    expect(loaded.ok && loaded.value.sessions?.sources.length).toBe(1);
  });

  test("local discovery lists synthetic candidates with host paths", async () => {
    const home = join(root, "home");
    await mkdir(join(home, ".codex", "sessions"), { recursive: true });
    await cp(join(FIXTURES, "codex"), join(home, ".codex", "sessions"), {
      recursive: true,
    });
    const response = await handleSessionsDiscover(
      ctxHolder,
      new Request(`${ORIGIN}/api/sessions/discover`, {
        headers: { host: "127.0.0.1:3000" },
      }),
      { server: localServer, env: { HOME: home } }
    );
    expect(response.status).toBe(200);
    const discovery = (await response.json()) as {
      candidates: Array<{ harness: string; path: string; units: number }>;
    };
    expect(discovery.candidates).toHaveLength(1);
    expect(discovery.candidates[0]?.harness).toBe("codex");
    expect(discovery.candidates[0]?.units).toBe(4);
  });

  test("local register and remove refresh the running context", async () => {
    const response = await handleSessionsAddSource(
      ctxHolder,
      store,
      post("/api/sessions/sources", {
        id: "codex-two",
        harness: "codex",
        path: codexRoot,
        collection: "second",
      }),
      { server: localServer }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "codex-two",
      registered: true,
    });
    expect(ctxHolder.config.sessions?.sources.map((s) => s.id)).toEqual([
      "codex-main",
      "codex-two",
    ]);
    expect(ctxHolder.config.collections.map((c) => c.name)).toContain("second");
    const stored = await store.getCollections();
    expect(stored.ok && stored.value.map((c) => c.name)).toContain("second");
    expect(markContent).toHaveBeenCalled();

    await expectError(
      await handleSessionsAddSource(
        ctxHolder,
        store,
        post("/api/sessions/sources", {
          id: "../bad",
          harness: "codex",
          path: codexRoot,
          collection: "work",
        }),
        { server: localServer }
      ),
      400,
      "SESSIONS_INVALID_INPUT"
    );

    const removed = await handleSessionsRemoveSource(
      ctxHolder,
      store,
      "codex-two",
      post("/api/sessions/sources/codex-two", undefined, "DELETE"),
      { server: localServer }
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({
      id: "codex-two",
      removed: true,
      archiveRetained: true,
    });
    expect(ctxHolder.config.sessions?.sources.map((s) => s.id)).toEqual([
      "codex-main",
    ]);

    // Removing it again is a no-op: success, and no egress policy reset.
    let invalidations = 0;
    ctxHolder.invalidateEgressPolicy = async () => {
      invalidations += 1;
      return {
        policyEpoch: "2",
        queuedJobsInvalidated: 0,
        sessionsInvalidated: 0,
        staleWorkMustRetry: true,
      };
    };
    const again = await handleSessionsRemoveSource(
      ctxHolder,
      store,
      "codex-two",
      post("/api/sessions/sources/codex-two", undefined, "DELETE"),
      { server: localServer }
    );
    expect(again.status).toBe(200);
    expect(invalidations).toBe(0);
  });

  test("local init binds this instance's own config and refuses the default config", async () => {
    await store.close();
    const freshConfig = join(root, "fresh.yml");
    await Bun.write(
      freshConfig,
      'version: "1.0"\nftsTokenizer: snowball english\ncollections: []\ncontexts: []\n'
    );
    await openHolder(freshConfig, "fresh-sessions");
    const freshArchive = join(root, "fresh-archive");
    const response = await handleSessionsInit(
      ctxHolder,
      store,
      post("/api/sessions/init", {
        archive: freshArchive,
        collection: "notes",
      }),
      { server: localServer }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      index: "fresh-sessions",
      collection: "notes",
    });
    expect(ctxHolder.config.sessions?.index).toBe("fresh-sessions");
    expect(ctxHolder.config.collections.map((c) => c.name)).toEqual(["notes"]);
    const status = await handleSessionsStatus(ctxHolder);
    expect(status.status).toBe(200);

    ctxHolder.actualConfigPath = getConfigPaths().configFile;
    await expectError(
      await handleSessionsInit(
        ctxHolder,
        store,
        post("/api/sessions/init", {
          archive: freshArchive,
          collection: "notes",
        }),
        { server: localServer }
      ),
      400,
      "SESSIONS_INVALID_INPUT"
    );
  });
});

describe("server wiring", () => {
  test("routes enforce CSRF and same-host checks with the real peer", async () => {
    type Handler = (
      req: Request,
      server: RequestPeerServer
    ) => Promise<Response>;
    let routes: Record<string, Record<string, Handler>> = {};
    const result = await startServer(
      { index: INDEX, port: 3000 },
      {
        startBackgroundRuntime: (async () => ({
          success: true as const,
          runtime: {
            actualConfigPath: configPath,
            config: ctxHolder.config,
            store,
            ctxHolder,
            dispose: async () => undefined,
          },
        })) as never,
        createMcpHttpGateway: (async () => ({
          route: async () => new Response("ok"),
          close: async () => undefined,
          security: {},
          transport: {},
        })) as never,
        serve: ((options: { routes: typeof routes }) => {
          routes = options.routes;
          return { port: 3000, stop: async () => undefined } as never;
        }) as never,
        waitForShutdown: async () => {
          expect(routes["/sessions"]).toBe(routes["/"]);
          const csrf = await routes["/api/sessions/import"]?.POST?.(
            new Request(`${ORIGIN}/api/sessions/import`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                origin: "https://cross-site.example",
              },
              body: JSON.stringify({ sourceId: "codex-main" }),
            }),
            localServer
          );
          expect(csrf?.status).toBe(403);
          // Discovery returns host paths: a cross-origin GET is refused too.
          const crossOriginDiscover = await routes[
            "/api/sessions/discover"
          ]?.GET?.(
            new Request(`${ORIGIN}/api/sessions/discover`, {
              headers: { origin: "http://evil.example" },
            }),
            localServer
          );
          expect(crossOriginDiscover?.status).toBe(403);
          expect(
            ((await csrf?.json()) as ErrorBody | undefined)?.error.code
          ).toBe("CSRF_VIOLATION");

          // The automation preview returns host paths: a cross-origin page
          // is refused even though it is a GET.
          const crossOriginPreview = await routes[
            "/api/sessions/automation/:id/preview"
          ]?.GET?.(
            new Request(`${ORIGIN}/api/sessions/automation/main/preview`, {
              headers: {
                host: "127.0.0.1:3000",
                origin: "http://evil.example",
              },
            }),
            localServer
          );
          expect(crossOriginPreview?.status).toBe(403);

          const remote = await routes["/api/sessions/sources/:id"]?.DELETE?.(
            post("/api/sessions/sources/codex-main", undefined, "DELETE"),
            remoteServer
          );
          expect(remote?.status).toBe(403);

          const removed = await routes["/api/sessions/sources/:id"]?.DELETE?.(
            post("/api/sessions/sources/codex-main", undefined, "DELETE"),
            localServer
          );
          expect(removed?.status).toBe(200);
          expect(await removed?.json()).toMatchObject({ id: "codex-main" });

          const preview = await routes["/api/sessions/import"]?.POST?.(
            post("/api/sessions/import", { sourceId: "codex-main" }),
            remoteServer
          );
          expect(preview?.status).toBe(400);
        },
      }
    );
    expect(result).toEqual({ success: true });
  });
});

test("the status route adopts a CLI-added collection without voiding the read", async () => {
  let epoch = 1;
  ctxHolder.invalidateEgressPolicy = async () => {
    epoch += 1;
    return {
      policyEpoch: String(epoch),
      queuedJobsInvalidated: 0,
      sessionsInvalidated: 0,
      staleWorkMustRetry: true,
    };
  };
  const runtime = {
    actualConfigPath: configPath,
    config: ctxHolder.config,
    store,
    ctxHolder,
    readerGate: new ReaderGate(1, 1),
    admitRequest: () => {
      const admittedEpoch = epoch;
      return {
        id: crypto.randomUUID(),
        signal: new AbortController().signal,
        isAuthorizationEpochCurrent: () => admittedEpoch === epoch,
        finish: () => undefined,
      };
    },
    dispose: async () => undefined,
  };
  let routes: Record<
    string,
    Record<string, (req: Request) => Promise<Response>>
  > = {};
  const result = await startServer(
    { index: INDEX, port: 3000 },
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
      serve: ((options: { routes: typeof routes }) => {
        routes = options.routes;
        return { port: 3000, stop: async () => undefined } as never;
      }) as never,
      waitForShutdown: async () => {
        await addSessionSource({
          configPath,
          id: "codex-two",
          harness: "codex",
          path: codexRoot,
          collection: "second",
        });
        const response = await routes["/api/sessions/status"]?.GET?.(
          new Request(`${ORIGIN}/api/sessions/status`)
        );
        expect(response?.status).toBe(200);
        const body = (await response?.json()) as {
          sources: Array<{ id: string }>;
        };
        expect(body.sources.map((source) => source.id)).toEqual([
          "codex-main",
          "codex-two",
        ]);
        expect(epoch).toBe(2);
      },
    }
  );
  expect(result).toEqual({ success: true });
});

test("non-session failures map to a typed, path-free REST error", async () => {
  const response = sessionsErrorResponse(
    new Error(
      "ENOENT: no such file or directory, open '/home/owner/archive/state.json'"
    )
  );
  expect(response.status).toBe(500);
  const body = (await response.json()) as {
    error: { message: string; details: { sessionsCode: string } };
  };
  expect(body.error.details.sessionsCode).toBe("SESSIONS_RUNTIME_FAILURE");
  expect(body.error.message).not.toContain("/home/owner");
});

describe("automation routes", () => {
  test("managing profiles and triggers is same-host only; nothing changes remotely", async () => {
    await setAutomationProfile(
      { configPath, indexName: INDEX },
      { id: "main", sources: ["codex-main"] }
    );
    const path = "/api/sessions/automation/main";
    for (const server of [undefined, remoteServer]) {
      const deps = server ? { server } : {};
      const refusals = [
        handleSessionsAutomationSet(
          ctxHolder,
          store,
          "main",
          post(path, { sources: ["codex-main"], cadence: "1m" }, "PUT"),
          deps
        ),
        handleSessionsAutomationEnable(
          ctxHolder,
          store,
          "main",
          post(`${path}/enable`, { schedule: { cadence: "1h" } }),
          deps
        ),
        handleSessionsAutomationDisable(
          ctxHolder,
          store,
          "main",
          post(`${path}/disable`, {}),
          deps
        ),
        handleSessionsAutomationRemove(
          ctxHolder,
          store,
          "main",
          post(path, undefined, "DELETE"),
          deps
        ),
        handleSessionsAutomationPreview(
          ctxHolder,
          "main",
          new Request(`${ORIGIN}${path}/preview`, {
            headers: { host: "127.0.0.1:3000" },
          }),
          deps
        ),
      ];
      for (const response of await Promise.all(refusals)) {
        await expectError(response, 403);
      }
    }
    const loaded = await loadConfig(configPath);
    expect(loaded.ok && loaded.value.sessions?.automation).toEqual([
      { id: "main", sources: ["codex-main"] },
    ]);
  });

  test("the browser cannot choose a hook settings file", async () => {
    await setAutomationProfile(
      { configPath, indexName: INDEX },
      { id: "main", sources: ["codex-main"] }
    );
    await expectError(
      await handleSessionsAutomationEnable(
        ctxHolder,
        store,
        "main",
        post("/api/sessions/automation/main/enable", {
          hook: { harness: "claude-code", settings: join(root, "any.json") },
        }),
        { server: localServer }
      ),
      400,
      "SESSIONS_INVALID_INPUT"
    );
    expect(await Bun.file(join(root, "any.json")).exists()).toBe(false);
  });

  test("a local owner enables a schedule; any allowed client runs the profile", async () => {
    const deps = { server: localServer };
    const path = "/api/sessions/automation/main";
    const set = await handleSessionsAutomationSet(
      ctxHolder,
      store,
      "main",
      post(path, { sources: ["codex-main"] }, "PUT"),
      deps
    );
    expect(set.status).toBe(200);
    const enabled = await handleSessionsAutomationEnable(
      ctxHolder,
      store,
      "main",
      post(`${path}/enable`, { schedule: { cadence: "1h" } }),
      deps
    );
    expect(await enabled.json()).toMatchObject({
      schedule: { enabled: true, cadence: "1h" },
      daemon: { state: "not_running" },
    });

    const run = await handleSessionsAutomationRun(
      ctxHolder,
      store,
      post("/api/sessions/automation/run", { profileId: "main" })
    );
    const body = await run.json();
    assertValid(body, await loadSchema("sessions-automation-run"));
    expect(body).toMatchObject({ ran: true, outcome: "partial" });
    expect(JSON.stringify(body)).not.toContain(root);
    expect(markContent).toHaveBeenCalled();

    await expectError(
      await handleSessionsAutomationRun(
        ctxHolder,
        store,
        post("/api/sessions/automation/run", {
          profileId: "main",
          sources: ["other"],
        })
      ),
      400,
      "SESSIONS_INVALID_INPUT"
    );
    const status = await handleSessionsStatus(ctxHolder);
    const current = await status.json();
    assertValid(current, await loadSchema("sessions-status"));
    expect(current.automation.profiles[0]).toMatchObject({
      id: "main",
      schedule: { enabled: true, cadence: "1h", nextDueAt: null },
    });
  });
});
