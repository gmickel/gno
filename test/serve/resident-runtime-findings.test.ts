/**
 * Daemon-mode findings wiring in the resident runtime: enabled-without-a
 * collection fails startup with the operator-facing message; serve mode
 * ignores the block; a valid daemon config arms the scheduler and persists
 * the pending state; a disabled daemon clears a stale state file.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { ResidentRuntimeDeps } from "../../src/serve/resident-runtime";

import { getIndexDbPath } from "../../src/app/constants";
import {
  createPendingFindingsRunState,
  findingsRunStatePath,
  readFindingsRunStatus,
  writeFindingsRunState,
} from "../../src/core/findings-run-state";
import { startResidentRuntime } from "../../src/serve/resident-runtime";
import { safeRm } from "../helpers/cleanup";

let dir: string;
const ENV_KEYS = ["GNO_CONFIG_DIR", "GNO_DATA_DIR", "GNO_CACHE_DIR"] as const;
let envSnapshot: Partial<Record<(typeof ENV_KEYS)[number], string>>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gno-rr-findings-"));
  await mkdir(join(dir, "data"), { recursive: true });
  envSnapshot = {};
  for (const key of ENV_KEYS) {
    const prior = process.env[key];
    if (prior !== undefined) envSnapshot[key] = prior;
  }
  process.env.GNO_CONFIG_DIR = join(dir, "config");
  process.env.GNO_DATA_DIR = join(dir, "data");
  process.env.GNO_CACHE_DIR = join(dir, "cache");
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const prior = envSnapshot[key];
    if (prior === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = prior;
  }
  await safeRm(dir);
});

const buildConfig = (findings?: Config["findings"]): Config => ({
  version: "1.0",
  ftsTokenizer: "unicode61",
  collections: [
    {
      name: "notes",
      path: join(dir, "notes"),
      pattern: "**/*.md",
      include: [],
      exclude: [],
    },
    {
      name: "findings",
      path: join(dir, "findings"),
      pattern: "**/*.md",
      include: [],
      exclude: [],
    },
  ],
  contexts: [],
  findings,
});

function createDeps(config: Config): ResidentRuntimeDeps {
  const store = {
    setConfigPath: () => undefined,
    open: async () => ({ ok: true as const, value: undefined }),
    syncCollections: async () => ({ ok: true as const, value: undefined }),
    syncContexts: async () => ({ ok: true as const, value: undefined }),
    getRawDb: () => ({}),
    close: async () => undefined,
  };
  return {
    isInitialized: async () => true,
    loadConfig: async () => ({ ok: true, value: config }) as never,
    ensureDirectories: async () => ({ ok: true, value: undefined }) as never,
    getConfigPaths: () =>
      ({
        configDir: join(dir, "config"),
        configFile: join(dir, "config", "index.yml"),
        dataDir: join(dir, "data"),
        cacheDir: join(dir, "cache"),
      }) as never,
    acquireOwnerLock: async () => ({ release: async () => undefined }),
    storeFactory: () => store as never,
    createServerContext: async () =>
      ({
        store,
        config,
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
      }) as never,
    disposeServerContext: async () => undefined,
    createEmbedScheduler: () =>
      ({
        notifySyncComplete: () => undefined,
        triggerNow: async () => ({ embedded: 0, errors: 0 }),
        getState: () => ({ pendingDocCount: 0, running: false }),
        dispose: () => undefined,
      }) as never,
    syncAllService: async () => ({}) as never,
    watchServiceFactory: () =>
      ({
        start: () => undefined,
        updateCollections: () => undefined,
        dispose: () => undefined,
        getState: () => ({
          expectedCollections: [],
          activeCollections: [],
          failedCollections: [],
          queuedCollections: [],
          syncingCollections: [],
          lastEventAt: null,
          lastSyncAt: null,
        }),
      }) as never,
    modelManagerFactory: () =>
      ({
        getLifecycleStats: () => ({}),
        disposeAll: async () => undefined,
        acquireLease: () => ({ release: () => undefined }),
      }) as never,
  };
}

describe("resident runtime findings wiring", () => {
  test("daemon refuses to start when findings is enabled without a collection", async () => {
    const config = buildConfig({ enabled: true, cadence: "6h" });
    const result = await startResidentRuntime(
      { mode: "daemon" },
      createDeps(config)
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("findings.collection is not set");
    }
  });

  test("daemon refuses an unknown findings collection; serve ignores the block", async () => {
    const config = buildConfig({
      enabled: true,
      cadence: "6h",
      collection: "ghost",
    });
    const daemon = await startResidentRuntime(
      { mode: "daemon" },
      createDeps(config)
    );
    expect(daemon.success).toBe(false);
    if (!daemon.success)
      expect(daemon.error).toContain('"ghost" is not a configured collection');

    const serve = await startResidentRuntime(
      { mode: "serve" },
      createDeps(config)
    );
    expect(serve.success).toBe(true);
    if (serve.success) {
      expect(serve.runtime.findingsScheduler).toBeNull();
      await serve.runtime.dispose();
    }
  });

  test("daemon with a valid block arms the scheduler and persists pending state", async () => {
    const config = buildConfig({
      enabled: true,
      cadence: "1h",
      collection: "findings",
    });
    const result = await startResidentRuntime(
      { mode: "daemon" },
      createDeps(config)
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.runtime.findingsScheduler).not.toBeNull();
    const statePath = findingsRunStatePath(getIndexDbPath());
    const status = await readFindingsRunStatus(statePath);
    expect(status).toMatchObject({
      state: "pending",
      collection: "findings",
      cadence: "1h",
    });
    await result.runtime.dispose();
  });

  test("daemon with findings disabled removes a stale state file", async () => {
    const statePath = findingsRunStatePath(getIndexDbPath());
    await writeFindingsRunState(
      statePath,
      createPendingFindingsRunState(
        {
          collection: buildConfig().collections[1]!,
          cadence: "1h",
          cadenceMs: 3_600_000,
        },
        new Date()
      )
    );
    const result = await startResidentRuntime(
      { mode: "daemon" },
      createDeps(buildConfig())
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.runtime.findingsScheduler).toBeNull();
    expect(await readFindingsRunStatus(statePath)).toBeNull();
    await result.runtime.dispose();
  });
});
