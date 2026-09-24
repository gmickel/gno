import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises for temp fixtures (no Bun equivalent for cp/mkdir/readdir)
import { appendFile, cp, mkdir, readdir, rename } from "node:fs/promises";
// node:path has no Bun path utilities
import { join } from "node:path";

import type { Config } from "../../src/config/types";

import { getIndexDbPath } from "../../src/app/constants";
import { initStore } from "../../src/cli/commands/shared";
import { loadConfig, saveConfigToPath } from "../../src/config";
import { acquireWriteLock } from "../../src/core/file-lock";
import { searchBm25 } from "../../src/pipeline/search";
import { assertSessionBinding } from "../../src/sessions/binding";
import {
  addSessionSource,
  initSessionArchive,
  SessionsService,
} from "../../src/sessions/service";
import { importLockPath } from "../../src/sessions/state";
import { SessionsError } from "../../src/sessions/types";
import { openScopedIndexStore } from "../../src/store/sqlite/scoped-index";
import { safeRm } from "../helpers/cleanup";
import { FIXTURE_SECRETS, FIXTURES, tempDir } from "./helpers";

const INDEX = "sessions";
const CODEX_MAIN =
  "rollout-2026-09-20T10-00-00-0000c0de-0000-7000-8000-000000000001.jsonl";
const CODEX_TRUNCATED =
  "rollout-2026-09-22T12-00-00-0000c0de-0000-7000-8000-000000000004.jsonl";

let root: string;
let configPath: string;
let archiveRoot: string;
let codexRoot: string;
const env = {
  config: process.env.GNO_CONFIG_DIR,
  data: process.env.GNO_DATA_DIR,
  cache: process.env.GNO_CACHE_DIR,
};

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, {
    recursive: true,
    withFileTypes: true,
  }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

async function readAll(dir: string): Promise<string> {
  const files = await listFiles(dir);
  const parts = await Promise.all(files.map((file) => Bun.file(file).text()));
  return parts.join("\n");
}

async function loadArchiveConfig(): Promise<Config> {
  const loaded = await loadConfig(configPath);
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value;
}

async function withService<T>(
  run: (service: SessionsService, config: Config) => Promise<T>
): Promise<T> {
  const opened = await initStore({
    configPath,
    indexName: INDEX,
    allowEmptyCollections: true,
  });
  if (!opened.ok) throw new Error(opened.error);
  try {
    return await run(
      new SessionsService({
        config: opened.config,
        configPath,
        indexName: INDEX,
        store: opened.store,
      }),
      opened.config
    );
  } finally {
    await opened.store.close();
  }
}

async function searchArchive(query: string): Promise<string[]> {
  const opened = await initStore({ configPath, indexName: INDEX });
  if (!opened.ok) throw new Error(opened.error);
  try {
    const result = await searchBm25(opened.store, query, { limit: 20 });
    if (!result.ok) throw new Error(result.error.message);
    return result.value.results.map((item) => item.snippet ?? "");
  } finally {
    await opened.store.close();
  }
}

async function expectSessionsError(
  promise: Promise<unknown>,
  code: SessionsError["code"]
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SessionsError);
    expect((error as SessionsError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

beforeEach(async () => {
  root = await tempDir("gno-sessions-service-");
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
});

afterEach(async () => {
  process.env.GNO_CONFIG_DIR = env.config;
  process.env.GNO_DATA_DIR = env.data;
  process.env.GNO_CACHE_DIR = env.cache;
  await safeRm(root);
});

describe("manual selection (R1)", () => {
  test("a fresh archive has imported nothing until asked", async () => {
    const status = await new SessionsService({
      config: await loadArchiveConfig(),
      configPath,
      indexName: INDEX,
    }).status();
    expect(status.collections).toEqual([{ name: "work", threads: 0 }]);
    expect(status.sources[0]?.lastImportAt).toBeNull();
    expect(status.sources[0]?.units.pending).toBe(4);
  });

  const errors: Array<
    [string, Record<string, unknown>, boolean, SessionsError["code"]]
  > = [
    ["missing selection", {}, true, "SESSIONS_SELECTION_REQUIRED"],
    [
      "path import without destination",
      { paths: ["/tmp"] },
      true,
      "SESSIONS_DESTINATION_REQUIRED",
    ],
    ["unknown source", { sourceId: "nope" }, true, "SESSIONS_UNKNOWN_SOURCE"],
    [
      "remote surface naming a host path",
      { paths: ["/tmp"], collection: "work" },
      false,
      "SESSIONS_UNSAFE_PATH",
    ],
    [
      "unsupported format override",
      { paths: ["/tmp"], collection: "work", format: "irc" },
      true,
      "SESSIONS_UNSUPPORTED_FORMAT",
    ],
    [
      "unknown destination collection",
      { paths: ["/tmp"], collection: "elsewhere" },
      true,
      "SESSIONS_UNKNOWN_COLLECTION",
    ],
    [
      "inaccessible root",
      {
        paths: [join("/", "nonexistent-gno-session-root")],
        collection: "work",
      },
      true,
      "SESSIONS_SOURCE_UNAVAILABLE",
    ],
  ];
  for (const [name, input, allowPaths, code] of errors) {
    test(name, async () => {
      await withService((service) =>
        expectSessionsError(service.import(input, { allowPaths }), code)
      );
      expect(await listFiles(join(archiveRoot, "work"))).toEqual([]);
    });
  }

  test("a path inside the archive or GNO data is refused", async () => {
    await withService((service) =>
      expectSessionsError(
        service.import(
          { paths: [archiveRoot], collection: "work" },
          { allowPaths: true }
        ),
        "SESSIONS_UNSAFE_PATH"
      )
    );
  });

  test("an unrecognised file is reported unsupported, not guessed", async () => {
    const odd = join(root, "odd", "notes.jsonl");
    await mkdir(join(root, "odd"), { recursive: true });
    await Bun.write(odd, `${JSON.stringify({ hello: "world" })}\n`);
    const receipt = await withService((service) =>
      service.import({ paths: [odd], collection: "work" }, { allowPaths: true })
    );
    expect(receipt.counts.unsupported).toBe(1);
    expect(receipt.units[0]?.outcome).toBe("unsupported");
  });

  test("the sessions block and default config stay separate", async () => {
    await expectSessionsError(
      initSessionArchive({
        configPath: join(process.env.GNO_CONFIG_DIR!, "index.yml"),
        indexName: INDEX,
        archiveRoot: join(root, "other"),
        collection: "work",
      }),
      "SESSIONS_INVALID_INPUT"
    );
    await expectSessionsError(
      initSessionArchive({
        configPath: join(root, "other.yml"),
        indexName: "default",
        archiveRoot: join(root, "other"),
        collection: "work",
      }),
      "SESSIONS_INVALID_INPUT"
    );
    await expectSessionsError(
      initSessionArchive({
        configPath: join(root, "other.yml"),
        indexName: "other",
        archiveRoot: join(process.env.GNO_DATA_DIR!, "archive"),
        collection: "work",
      }),
      "SESSIONS_UNSAFE_PATH"
    );
  });
});

describe("import, idempotency and reconciliation (R3, R4)", () => {
  test("dry run writes no archive, state or index", async () => {
    const receipt = await withService((service) =>
      service.import(
        { sourceId: "codex-main", dryRun: true },
        { allowPaths: false }
      )
    );
    expect(receipt.dryRun).toBe(true);
    expect(receipt.counts.imported).toBe(4);
    expect(await listFiles(archiveRoot)).toEqual([]);
    expect(await searchArchive("SQLite")).toEqual([]);
  });

  test("rerunning an unchanged source is idempotent", async () => {
    const first = await withService((service) =>
      service.import({ sourceId: "codex-main" }, { allowPaths: false })
    );
    expect(first.counts).toMatchObject({
      imported: 4,
      updated: 0,
      incomplete: 1,
    });
    expect(first.status).toBe("partial");
    expect(first.lexical.status).toBe("ready");
    const before = await readAll(join(archiveRoot, "work"));
    const second = await withService((service) =>
      service.import({ sourceId: "codex-main" }, { allowPaths: false })
    );
    expect(second.counts.imported).toBe(0);
    expect(second.counts.updated).toBe(0);
    expect(await readAll(join(archiveRoot, "work"))).toBe(before);
    expect(await searchArchive("SQLite")).toHaveLength(1);
  });

  test("appends reconcile with stable turn IDs", async () => {
    await withService((service) =>
      service.import({ sourceId: "codex-main" }, { allowPaths: false })
    );
    const archived = await readAll(join(archiveRoot, "work"));
    const originalIds = [...archived.matchAll(/"id":"([a-f0-9]{32})"/g)].map(
      (match) => match[1] ?? ""
    );
    await appendFile(
      join(codexRoot, CODEX_MAIN),
      `${JSON.stringify({
        timestamp: "2026-09-20T10:10:00.000Z",
        ordinal: 12,
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: {
            type: "UserMessage",
            id: "item-user-3",
            content: [
              {
                type: "text",
                text: "Appended alpha note about queue retention.",
              },
            ],
          },
        },
      })}\n`
    );
    const receipt = await withService((service) =>
      service.import({ sourceId: "codex-main" }, { allowPaths: false })
    );
    expect(receipt.counts.updated).toBe(1);
    const after = await readAll(join(archiveRoot, "work"));
    for (const id of originalIds) expect(after).toContain(id);
    expect(await searchArchive("retention")).toHaveLength(1);
  });

  test("a truncated tail never advances the checkpoint until it completes", async () => {
    await withService((service) =>
      service.import({ sourceId: "codex-main" }, { allowPaths: false })
    );
    let status = await withService((service) => service.status());
    expect(status.sources[0]?.units.incomplete).toBe(1);
    expect(status.sources[0]?.units.pending).toBe(1);
    await appendFile(join(codexRoot, CODEX_TRUNCATED), 'te."}]}}}\n');
    const receipt = await withService((service) =>
      service.import({ sourceId: "codex-main" }, { allowPaths: false })
    );
    expect(receipt.counts.incomplete).toBe(0);
    status = await withService((service) => service.status());
    expect(status.sources[0]?.units).toMatchObject({
      complete: 4,
      incomplete: 0,
      pending: 0,
    });
  });

  test("--limit counts only changed work and defers the rest", async () => {
    const receipt = await withService((service) =>
      service.import(
        { sourceId: "codex-main", limit: 2 },
        { allowPaths: false }
      )
    );
    expect(receipt.deferredUnits).toBe(2);
    expect(receipt.status).toBe("partial");
    const next = await withService((service) =>
      service.import(
        { sourceId: "codex-main", limit: 2 },
        { allowPaths: false }
      )
    );
    expect(next.deferredUnits).toBe(0);
  });

  test("concurrent imports serialize on the archive lock", async () => {
    await mkdir(join(archiveRoot, ".gno-sessions"), { recursive: true });
    const held = await acquireWriteLock(importLockPath(archiveRoot), 1_000);
    expect(held).not.toBeNull();
    try {
      await withService((service) =>
        expectSessionsError(
          service.import({ sourceId: "codex-main" }, { allowPaths: false }),
          "SESSIONS_BUSY"
        )
      );
    } finally {
      await held?.release();
    }
  });

  test("a deleted source keeps its archive; prune previews before deleting", async () => {
    await withService((service) =>
      service.import({ sourceId: "codex-main" }, { allowPaths: false })
    );
    await rename(join(codexRoot, CODEX_MAIN), join(root, "moved-away.jsonl"));
    const receipt = await withService((service) =>
      service.import({ sourceId: "codex-main" }, { allowPaths: false })
    );
    expect(receipt.counts.failed).toBe(0);
    expect(await searchArchive("SQLite")).toHaveLength(1);
    const status = await withService((service) => service.status());
    expect(status.sources[0]?.sourceUnavailable).toBe(1);
    const preview = await withService((service) =>
      service.prune({ sourceId: "codex-main", apply: false })
    );
    expect(preview.applied).toBe(false);
    expect(preview.archiveFiles).toBe(1);
    expect(await searchArchive("SQLite")).toHaveLength(1);
    const applied = await withService((service) =>
      service.prune({ sourceId: "codex-main", apply: true })
    );
    expect(applied.applied).toBe(true);
    expect(await searchArchive("SQLite")).toEqual([]);
  });

  test("no fixture secret reaches archive, state, receipt or index", async () => {
    const receipt = await withService((service) =>
      service.import({ sourceId: "codex-main" }, { allowPaths: false })
    );
    expect(receipt.turns.redactions).toBeGreaterThan(0);
    const persisted = `${await readAll(archiveRoot)}\n${JSON.stringify(receipt)}`;
    for (const secret of FIXTURE_SECRETS) {
      expect(persisted).not.toContain(secret);
      expect(await searchArchive(secret.replaceAll("-", " "))).toEqual([]);
    }
    expect(persisted).toContain("[REDACTED:api-key]");
    expect(persisted).not.toContain(codexRoot);
  });

  test("a redaction rule added later rescans archives whose source is gone", async () => {
    await withService((service) =>
      service.import({ sourceId: "codex-main" }, { allowPaths: false })
    );
    await rename(join(codexRoot, CODEX_MAIN), join(root, "gone.jsonl"));
    const statePath = join(archiveRoot, ".gno-sessions", "state.json");
    const state = await Bun.file(statePath).json();
    for (const unit of Object.values(
      state.sources["codex-main"].units
    ) as Array<{ redaction: number }>) {
      unit.redaction = 0;
    }
    await Bun.write(statePath, JSON.stringify(state));
    const config = await loadArchiveConfig();
    config.sessions!.redaction = { literals: ["alpha queue"] };
    await saveConfigToPath(config, configPath);
    await withService((service) =>
      service.import({ sourceId: "codex-main" }, { allowPaths: false })
    );
    expect(await readAll(join(archiveRoot, "work"))).not.toContain(
      "alpha queue"
    );
    expect(await searchArchive("alpha queue SQLite")).toEqual([]);
  });

  test("a thread spanning mapped working directories is quarantined", async () => {
    const mapped = join(root, "mapped.yml");
    await initSessionArchive({
      configPath: mapped,
      indexName: "mapped",
      archiveRoot: join(root, "mapped-archive"),
      collection: "public",
    });
    await addSessionSource({
      configPath: mapped,
      id: "codex-mapped",
      harness: "codex",
      path: codexRoot,
      collection: "public",
      projects: [{ prefix: "/work/alpha", collection: "private" }],
    });
    await appendFile(
      join(codexRoot, CODEX_MAIN),
      `${JSON.stringify({ timestamp: "2026-09-20T10:20:00.000Z", ordinal: 20, type: "turn_context", payload: { cwd: "/work/other" } })}\n${JSON.stringify({ timestamp: "2026-09-20T10:21:00.000Z", ordinal: 21, type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", id: "item-x", content: [{ type: "text", text: "cross-project note" }] } } })}\n`
    );
    const loaded = await loadConfig(mapped);
    if (!loaded.ok) throw new Error(loaded.error.message);
    const receipt = await new SessionsService({
      config: loaded.value,
      configPath: mapped,
      indexName: "mapped",
    }).import(
      { sourceId: "codex-mapped", dryRun: true },
      { allowPaths: false }
    );
    expect(receipt.counts.skippedPolicy).toBe(1);
    const unit = receipt.units.find((item) => item.locator === CODEX_MAIN);
    expect(unit?.outcome).toBe("skipped_policy");
    expect(unit?.warnings?.join(" ")).toContain("mixed_domain");
  });
});

describe("archive isolation (R8)", () => {
  test("the archive config refuses any other index", async () => {
    await expectSessionsError(
      assertSessionBinding({
        config: await loadArchiveConfig(),
        configPath,
        indexName: "default",
        dbPath: getIndexDbPath("default"),
      }),
      "SESSIONS_BINDING_MISMATCH"
    );
  });

  test("the archive index refuses a curated config, including cross-index get", async () => {
    await withService((service) =>
      service.import({ sourceId: "codex-main" }, { allowPaths: false })
    );
    const curated = join(root, "curated.yml");
    await Bun.write(curated, 'version: "1.0"\ncollections: []\n');
    const curatedConfig = (await loadConfig(curated)) as {
      ok: true;
      value: Config;
    };
    await expectSessionsError(
      assertSessionBinding({
        config: curatedConfig.value,
        configPath: curated,
        indexName: INDEX,
        dbPath: getIndexDbPath(INDEX),
      }),
      "SESSIONS_BINDING_MISMATCH"
    );
    const opened = await initStore({ configPath, indexName: INDEX });
    if (!opened.ok) throw new Error(opened.error);
    try {
      let message = "";
      try {
        await openScopedIndexStore({
          activeStore: opened.store,
          activeIndexName: "default",
          requestedIndexName: INDEX,
          config: curatedConfig.value,
          configPath: curated,
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/session archive/);
    } finally {
      await opened.store.close();
    }
  });

  test("archive collections are not memory-managed and live under the archive root", async () => {
    const config = await loadArchiveConfig();
    for (const collection of config.collections) {
      expect(collection.memoryManaged).toBeUndefined();
      expect(collection.path.startsWith(archiveRoot)).toBe(true);
      expect(collection.recordAdapters?.jsonl?.fieldMapping?.author).toBe(
        "/author"
      );
    }
  });
});
