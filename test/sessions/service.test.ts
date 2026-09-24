import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises for temp fixtures (no Bun equivalent for cp/mkdir/readdir)
import {
  appendFile,
  chmod,
  cp,
  mkdir,
  readdir,
  realpath,
  rename,
  symlink,
} from "node:fs/promises";
// node:path has no Bun path utilities
import { join } from "node:path";

import type { Config } from "../../src/config/types";

import { getIndexDbPath } from "../../src/app/constants";
import { initStore } from "../../src/cli/commands/shared";
import { loadConfig, saveConfigToPath } from "../../src/config";
import { acquireWriteLock } from "../../src/core/file-lock";
import { searchBm25 } from "../../src/pipeline/search";
import { assertSessionBinding } from "../../src/sessions/binding";
import { SessionsService } from "../../src/sessions/service";
import {
  addSessionSource,
  initSessionArchive,
  removeSessionSource,
} from "../../src/sessions/setup";
import { enumerateUnits, type ReadDirectory } from "../../src/sessions/sources";
import { importLockPath } from "../../src/sessions/state";
import { type SessionHarness, SessionsError } from "../../src/sessions/types";
import { openScopedIndexStore } from "../../src/store/sqlite/scoped-index";
import { safeRm } from "../helpers/cleanup";
import {
  FIXTURES,
  FIXTURE_SECRETS,
  buildSqliteFixtures,
  snapshotSessionEnv,
  tempDir,
} from "./helpers";

const INDEX = "sessions";
const CODEX_MAIN =
  "rollout-2026-09-20T10-00-00-0000c0de-0000-7000-8000-000000000001.jsonl";
const CODEX_TRUNCATED =
  "rollout-2026-09-22T12-00-00-0000c0de-0000-7000-8000-000000000004.jsonl";

let root: string;
let configPath: string;
let archiveRoot: string;
let codexRoot: string;
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
  run: (service: SessionsService, config: Config) => Promise<T>,
  readDirectory?: ReadDirectory
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
        readDirectory,
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

/** A service whose index sync always fails (the store itself works). */
async function withFailingSync<T>(
  run: (service: SessionsService) => Promise<T>
): Promise<T> {
  return withService(async (_service, config) => {
    const opened = await initStore({
      configPath,
      indexName: INDEX,
      allowEmptyCollections: true,
    });
    if (!opened.ok) throw new Error(opened.error);
    try {
      return await run(
        new SessionsService({
          config,
          configPath,
          indexName: INDEX,
          store: opened.store,
          syncService: {
            syncPaths: () => Promise.reject(new Error(`EIO ${archiveRoot}`)),
            syncCollection: () => Promise.reject(new Error("unused")),
          },
        })
      );
    } finally {
      await opened.store.close();
    }
  });
}

async function setLiterals(literals: string[]): Promise<void> {
  const config = await loadArchiveConfig();
  config.sessions!.redaction = { literals };
  await saveConfigToPath(config, configPath);
}

const importMain = () =>
  withService((service) =>
    service.import({ sourceId: "codex-main" }, { allowPaths: false })
  );

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
  restoreEnv();
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

  test("a path import detects each directory layout by structure", async () => {
    const sqlite = await buildSqliteFixtures(join(root, "sqlite"));
    const cases: Array<[string, SessionHarness]> = [
      [join(FIXTURES, "claude-code/projects"), "claude-code"],
      [sqlite.hermesRoot, "hermes"],
      [sqlite.openclawRoot, "openclaw"],
    ];
    for (const [path, harness] of cases) {
      const receipt = await withService((service) =>
        service.import(
          { paths: [path], collection: "work", dryRun: true },
          { allowPaths: true }
        )
      );
      expect(receipt.units.length).toBeGreaterThan(0);
      expect(new Set(receipt.units.map((unit) => unit.harness))).toEqual(
        new Set([harness])
      );
    }
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

  test("a redaction literal added later rewrites every archive, with or without its source", async () => {
    await withService((service) =>
      service.import({ sourceId: "codex-main" }, { allowPaths: false })
    );
    expect(await readAll(join(archiveRoot, "work"))).toContain(
      "beta checklist"
    );
    await rename(join(codexRoot, CODEX_MAIN), join(root, "gone.jsonl"));
    const config = await loadArchiveConfig();
    config.sessions!.redaction = {
      literals: [
        "alpha queue",
        "beta checklist",
        "0000c0de-0000-7000-8000-000000000001",
      ],
    };
    await saveConfigToPath(config, configPath);
    await withService((service) =>
      service.import({ sourceId: "codex-main" }, { allowPaths: false })
    );
    const archived = await readAll(join(archiveRoot, "work"));
    // The source of the "alpha queue" thread is gone: rescanned in place,
    // including titles, categories and provenance fields.
    expect(archived).not.toContain("alpha queue");
    expect(archived).not.toContain("0000c0de-0000-7000-8000-000000000001");
    // The "beta checklist" source still exists: re-rendered.
    expect(archived).not.toContain("beta checklist");
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

  test("a failed index sync records no completion and the next run heals it", async () => {
    const failing = await withService(async (_service, config) => {
      const opened = await initStore({
        configPath,
        indexName: INDEX,
        allowEmptyCollections: true,
      });
      if (!opened.ok) throw new Error(opened.error);
      try {
        return await new SessionsService({
          config,
          configPath,
          indexName: INDEX,
          store: opened.store,
          syncService: {
            syncPaths: () => Promise.reject(new Error(`EIO ${archiveRoot}`)),
            syncCollection: () => Promise.reject(new Error("unused")),
          },
        }).import({ sourceId: "codex-main" }, { allowPaths: false });
      } finally {
        await opened.store.close();
      }
    });
    expect(failing.lexical.status).toBe("failed");
    expect(failing.status).toBe("partial");
    expect(JSON.stringify(failing)).not.toContain(archiveRoot);
    const healed = await withService((service) =>
      service.import({ sourceId: "codex-main" }, { allowPaths: false })
    );
    expect(healed.status).not.toBe("nothing_to_do");
    expect(healed.lexical.status).toBe("ready");
    expect(await searchArchive("SQLite")).toHaveLength(1);
  });

  test("moving a unit within its root or re-registering the source keeps its archive", async () => {
    await withService((service) =>
      service.import({ sourceId: "codex-main" }, { allowPaths: false })
    );
    await mkdir(join(codexRoot, "moved"), { recursive: true });
    await rename(
      join(codexRoot, CODEX_MAIN),
      join(codexRoot, "moved", CODEX_MAIN)
    );
    const afterMove = await withService((service) =>
      service.import({ sourceId: "codex-main" }, { allowPaths: false })
    );
    expect(afterMove.counts.imported).toBe(0);
    const relocated = join(root, "relocated");
    await cp(codexRoot, relocated, { recursive: true });
    await removeSessionSource({ configPath, id: "codex-main" });
    await addSessionSource({
      configPath,
      id: "codex-main",
      harness: "codex",
      path: relocated,
      collection: "work",
    });
    const afterRelocation = await withService((service) =>
      service.import({ sourceId: "codex-main" }, { allowPaths: false })
    );
    expect(afterRelocation.counts.imported).toBe(0);
    const preview = await withService((service) =>
      service.prune({ sourceId: "codex-main", apply: true })
    );
    expect(preview.archiveFiles).toBe(0);
    expect(await searchArchive("SQLite")).toHaveLength(1);
  });

  test("prune never unlinks a file that a present unit still references", async () => {
    await withService((service) =>
      service.import({ sourceId: "codex-main" }, { allowPaths: false })
    );
    const statePath = join(archiveRoot, ".gno-sessions", "state.json");
    const state = await Bun.file(statePath).json();
    const units = state.sources["codex-main"].units as Record<
      string,
      {
        locator: string;
        threads: Array<{ collection: string; relPath: string }>;
      }
    >;
    const live = Object.values(units).find(
      (unit) => unit.locator === CODEX_MAIN
    )!;
    units.stale = { ...live, locator: "gone.jsonl" };
    await Bun.write(statePath, JSON.stringify(state));
    const applied = await withService((service) =>
      service.prune({ sourceId: "codex-main", apply: true })
    );
    expect(applied.units.map((unit) => unit.locator)).toEqual(["gone.jsonl"]);
    expect(await searchArchive("SQLite")).toHaveLength(1);
  });

  test("two units with the same locator fail instead of sharing archive files", async () => {
    await mkdir(join(codexRoot, "copy"), { recursive: true });
    await cp(join(codexRoot, CODEX_MAIN), join(codexRoot, "copy", CODEX_MAIN));
    const receipt = await withService((service) =>
      service.import(
        { sourceId: "codex-main", dryRun: true },
        { allowPaths: false }
      )
    );
    expect(
      receipt.units.filter((unit) => unit.reason === "unit_conflict")
    ).toHaveLength(1);
  });

  test("a mapping added to resolve a quarantine imports the thread on the next run", async () => {
    await appendFile(
      join(codexRoot, CODEX_MAIN),
      `${JSON.stringify({ timestamp: "2026-09-20T10:20:00.000Z", ordinal: 20, type: "turn_context", payload: { cwd: "/work/other" } })}\n${JSON.stringify({ timestamp: "2026-09-20T10:21:00.000Z", ordinal: 21, type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", id: "item-x", content: [{ type: "text", text: "cross-project note" }] } } })}\n`
    );
    await removeSessionSource({ configPath, id: "codex-main" });
    await addSessionSource({
      configPath,
      id: "codex-main",
      harness: "codex",
      path: codexRoot,
      collection: "work",
      projects: [{ prefix: "/work/alpha", collection: "private" }],
    });
    const quarantined = await withService((service) =>
      service.import({ sourceId: "codex-main" }, { allowPaths: false })
    );
    expect(quarantined.counts.skippedPolicy).toBe(1);
    await removeSessionSource({ configPath, id: "codex-main" });
    await addSessionSource({
      configPath,
      id: "codex-main",
      harness: "codex",
      path: codexRoot,
      collection: "work",
      projects: [
        { prefix: "/work/alpha", collection: "private" },
        { prefix: "/work/other", collection: "private" },
      ],
    });
    const resolved = await withService((service) =>
      service.import({ sourceId: "codex-main" }, { allowPaths: false })
    );
    expect(resolved.counts.skippedPolicy).toBe(0);
    expect(resolved.counts.imported).toBe(1);
    expect(await searchArchive("cross-project")).toHaveLength(1);
  });

  test("an unparseable archive without a source is withheld, not stamped as rescanned", async () => {
    await withService((service) =>
      service.import({ sourceId: "codex-main" }, { allowPaths: false })
    );
    await rename(join(codexRoot, CODEX_MAIN), join(root, "gone.jsonl"));
    const statePath = join(archiveRoot, ".gno-sessions", "state.json");
    const state = await Bun.file(statePath).json();
    const unit = (
      Object.values(state.sources["codex-main"].units) as Array<{
        locator: string;
        redaction: string;
        threads: Array<{ collection: string; relPath: string }>;
      }>
    ).find((item) => item.locator === CODEX_MAIN)!;
    const archived = join(archiveRoot, "work", unit.threads[0]!.relPath);
    await Bun.write(archived, "{not an archive line\n");
    const config = await loadArchiveConfig();
    config.sessions!.redaction = { literals: ["alpha queue"] };
    await saveConfigToPath(config, configPath);
    const receipt = await withService((service) =>
      service.import({ sourceId: "codex-main" }, { allowPaths: false })
    );
    expect(receipt.warnings.join(" ")).toContain("withheld");
    expect(await Bun.file(archived).exists()).toBe(false);
    const after = await Bun.file(statePath).json();
    const stamped = (
      Object.values(after.sources["codex-main"].units) as Array<{
        locator: string;
        redaction: string;
      }>
    ).find((item) => item.locator === CODEX_MAIN)!;
    expect(stamped.redaction).toBe(unit.redaction);
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

  test("init binds the index before any import and refuses an index in use", async () => {
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
    const notes = join(root, "notes");
    await mkdir(notes, { recursive: true });
    const used = await initStore({
      configPath: curated,
      indexName: "used",
      allowEmptyCollections: true,
    });
    if (!used.ok) throw new Error(used.error);
    await used.store.syncCollections([
      { name: "notes", path: notes, pattern: "**/*", include: [], exclude: [] },
    ]);
    await used.store.close();
    await expectSessionsError(
      initSessionArchive({
        configPath: join(root, "second.yml"),
        indexName: "used",
        archiveRoot: join(root, "second-archive"),
        collection: "work",
      }),
      "SESSIONS_BINDING_MISMATCH"
    );
    expect(await Bun.file(join(root, "second.yml")).exists()).toBe(false);
  });

  test("init refuses an archive inside a folder the default config indexes", async () => {
    const notes = join(root, "notes-vault");
    await mkdir(notes, { recursive: true });
    await Bun.write(
      join(process.env.GNO_CONFIG_DIR!, "index.yml"),
      `version: "1.0"\ncollections:\n  - name: notes\n    path: ${notes}\n`
    );
    await expectSessionsError(
      initSessionArchive({
        configPath: join(root, "inside.yml"),
        indexName: "inside",
        archiveRoot: join(notes, "sessions"),
        collection: "work",
      }),
      "SESSIONS_UNSAFE_PATH"
    );
  });

  test("a config reached through a symlinked directory binds consistently", async () => {
    // macOS temp dirs live behind /var -> /private/var; model that here.
    const real = join(root, "real-dir");
    const alias = join(root, "alias-dir");
    await mkdir(real, { recursive: true });
    await symlink(real, alias, "dir");
    const aliasConfig = join(alias, "archive.yml");
    await initSessionArchive({
      configPath: aliasConfig,
      indexName: "aliased",
      archiveRoot: join(root, "aliased-archive"),
      collection: "work",
    });
    for (const path of [aliasConfig, join(real, "archive.yml")]) {
      const opened = await initStore({
        configPath: path,
        indexName: "aliased",
        allowEmptyCollections: true,
      });
      if (!opened.ok) throw new Error(opened.error);
      await opened.store.close();
    }
  });

  test("archive collections are not memory-managed and live under the archive root", async () => {
    const config = await loadArchiveConfig();
    // The archive root is stored canonically (temp dirs may be symlinked).
    const canonicalRoot = await realpath(archiveRoot);
    for (const collection of config.collections) {
      expect(collection.memoryManaged).toBeUndefined();
      expect(collection.path.startsWith(canonicalRoot)).toBe(true);
      expect(collection.recordAdapters?.jsonl?.fieldMapping?.author).toBe(
        "/author"
      );
    }
  });
});

describe("review round 1 regressions", () => {
  test("receipts and checkpoint state apply configured literals to locators", async () => {
    await setLiterals(["0000c0de-0000-7000-8000-000000000001"]);
    const receipt = await importMain();
    const state = await Bun.file(
      join(archiveRoot, ".gno-sessions", "state.json")
    ).text();
    expect(JSON.stringify(receipt)).not.toContain(
      "0000c0de-0000-7000-8000-000000000001"
    );
    expect(state).not.toContain("0000c0de-0000-7000-8000-000000000001");
  });

  test("a rescan whose index sync failed is resynced by the next run", async () => {
    await importMain();
    await rename(join(codexRoot, CODEX_MAIN), join(root, "gone.jsonl"));
    await setLiterals(["alpha queue"]);
    const failed = await withFailingSync((service) =>
      service.import({ sourceId: "codex-main" }, { allowPaths: false })
    );
    expect(failed.lexical.status).toBe("failed");
    expect(await searchArchive("alpha queue SQLite")).toHaveLength(1);
    await importMain();
    expect(await searchArchive("alpha queue SQLite")).toEqual([]);
  });

  test("a deleted source root still gets archive-only redaction maintenance", async () => {
    await importMain();
    await rename(codexRoot, join(root, "codex-gone"));
    await setLiterals(["alpha queue"]);
    await expectSessionsError(importMain(), "SESSIONS_SOURCE_UNAVAILABLE");
    expect(await readAll(join(archiveRoot, "work"))).not.toContain(
      "alpha queue"
    );
    expect(await searchArchive("alpha queue SQLite")).toEqual([]);
  });

  test("malformed records keep a unit incomplete so it is retried", async () => {
    await appendFile(join(codexRoot, CODEX_MAIN), "{not json\n");
    const receipt = await importMain();
    const unit = receipt.units.find((item) => item.locator === CODEX_MAIN);
    expect(unit).toMatchObject({
      outcome: "incomplete",
      reason: "malformed_records",
    });
    const status = await withService((service) => service.status());
    expect(status.sources[0]?.units.pending).toBeGreaterThanOrEqual(2);
  });

  test("a thread at the turn limit is skipped instead of archived truncated", async () => {
    const lines = [
      JSON.stringify({
        timestamp: "2026-09-23T10:00:00.000Z",
        ordinal: 0,
        type: "session_meta",
        payload: {
          id: "0000c0de-0000-7000-8000-00000000ffff",
          cwd: "/work/long",
          cli_version: "0.156.1",
          source: "cli",
        },
      }),
    ];
    for (let index = 1; index <= 20_001; index += 1) {
      lines.push(
        JSON.stringify({
          timestamp: "2026-09-23T10:00:01.000Z",
          ordinal: index,
          type: "event_msg",
          payload: {
            type: "item_completed",
            item: {
              type: index % 2 ? "UserMessage" : "AgentMessage",
              id: `t${index}`,
              content: [{ type: "text", text: `placeholder ${index}` }],
            },
          },
        })
      );
    }
    await Bun.write(
      join(codexRoot, "rollout-2026-09-23T10-00-00-long.jsonl"),
      `${lines.join("\n")}\n`
    );
    const receipt = await withService((service) =>
      service.import(
        { sourceId: "codex-main", dryRun: true },
        { allowPaths: false }
      )
    );
    const unit = receipt.units.find((item) => item.locator.includes("-long"));
    expect(unit?.outcome).toBe("skipped_policy");
    expect(unit?.warnings?.join(" ")).toContain("turn limit");
  });

  test("prune plans under the lock and keeps state when its index sync fails", async () => {
    await importMain();
    await rename(join(codexRoot, CODEX_MAIN), join(root, "gone.jsonl"));
    await mkdir(join(archiveRoot, ".gno-sessions"), { recursive: true });
    const held = await acquireWriteLock(importLockPath(archiveRoot), 1_000);
    try {
      await withService((service) =>
        expectSessionsError(
          service.prune({ sourceId: "codex-main", apply: true }),
          "SESSIONS_BUSY"
        )
      );
    } finally {
      await held?.release();
    }
    const failed = await withFailingSync((service) =>
      service.prune({ sourceId: "codex-main", apply: true })
    );
    expect(failed.applied).toBe(false);
    expect(failed.error).toBeDefined();
    expect(await searchArchive("SQLite")).toHaveLength(1);
    const applied = await withService((service) =>
      service.prune({ sourceId: "codex-main", apply: true })
    );
    expect(applied.applied).toBe(true);
    expect(await searchArchive("SQLite")).toEqual([]);
  });

  test("a thread quarantined after an earlier import is withdrawn from retrieval", async () => {
    await importMain();
    expect(await searchArchive("SQLite")).toHaveLength(1);
    await appendFile(
      join(codexRoot, CODEX_MAIN),
      `${JSON.stringify({ timestamp: "2026-09-20T10:20:00.000Z", ordinal: 20, type: "turn_context", payload: { cwd: "/work/other" } })}\n${JSON.stringify({ timestamp: "2026-09-20T10:21:00.000Z", ordinal: 21, type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", id: "item-x", content: [{ type: "text", text: "cross-project note" }] } } })}\n`
    );
    await removeSessionSource({ configPath, id: "codex-main" });
    await addSessionSource({
      configPath,
      id: "codex-main",
      harness: "codex",
      path: codexRoot,
      collection: "work",
      projects: [{ prefix: "/work/other", collection: "private" }],
    });
    const receipt = await importMain();
    expect(receipt.counts.skippedPolicy).toBe(1);
    expect(await searchArchive("SQLite")).toEqual([]);
  });

  test("retained locators of a deleted unit follow a later redaction literal", async () => {
    await importMain();
    await rename(join(codexRoot, CODEX_MAIN), join(root, "gone.jsonl"));
    await setLiterals(["0000c0de-0000-7000-8000-000000000001"]);
    const receipt = await importMain();
    const state = await Bun.file(
      join(archiveRoot, ".gno-sessions", "state.json")
    ).text();
    const preview = await withService((service) =>
      service.prune({ sourceId: "codex-main", apply: false })
    );
    for (const surface of [
      JSON.stringify(receipt),
      state,
      JSON.stringify(preview),
    ]) {
      expect(surface).not.toContain("0000c0de-0000-7000-8000-000000000001");
    }
  });

  test("a quarantine removal whose index sync failed is retried", async () => {
    await importMain();
    await appendFile(
      join(codexRoot, CODEX_MAIN),
      `${JSON.stringify({ timestamp: "2026-09-20T10:20:00.000Z", ordinal: 20, type: "turn_context", payload: { cwd: "/work/other" } })}\n${JSON.stringify({ timestamp: "2026-09-20T10:21:00.000Z", ordinal: 21, type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", id: "item-x", content: [{ type: "text", text: "cross-project note" }] } } })}\n`
    );
    await removeSessionSource({ configPath, id: "codex-main" });
    await addSessionSource({
      configPath,
      id: "codex-main",
      harness: "codex",
      path: codexRoot,
      collection: "work",
      projects: [{ prefix: "/work/other", collection: "private" }],
    });
    const failed = await withFailingSync((service) =>
      service.import({ sourceId: "codex-main" }, { allowPaths: false })
    );
    expect(failed.lexical.status).toBe("failed");
    expect(await searchArchive("SQLite")).toHaveLength(1);
    await importMain();
    expect(await searchArchive("SQLite")).toEqual([]);
  });

  test("status counts only present units; a rerun reports unchanged threads", async () => {
    await importMain();
    const rerun = await importMain();
    // The truncated-tail fixture unit is retried, so the run stays partial.
    expect(rerun.status).toBe("partial");
    expect(rerun.counts.imported + rerun.counts.updated).toBe(0);
    expect(rerun.counts.unchanged).toBe(4);
    await rename(join(codexRoot, CODEX_MAIN), join(root, "gone.jsonl"));
    const status = await withService((service) => service.status());
    const units = status.sources[0]!.units;
    expect(units.total).toBe(3);
    expect(
      units.complete + units.incomplete + units.failed
    ).toBeLessThanOrEqual(units.total);
    expect(status.sources[0]!.sourceUnavailable).toBe(1);
  });
});

// chmod cannot make a directory unreadable on Windows, and root ignores
// permissions; the injected-listing test below covers the same path there.
const permissionsEnforced =
  process.platform !== "win32" && process.getuid?.() !== 0;

/** A directory listing that fails for `target` the way the OS would. */
function failingListing(target: string, code: "EACCES" | "ENOENT") {
  return ((dir: string, options: Parameters<ReadDirectory>[1]) =>
    dir === target
      ? Promise.reject(
          Object.assign(new Error(`${code}: scandir '${dir}'`), { code })
        )
      : readdir(dir, options as { withFileTypes: true })) as ReadDirectory;
}

describe("unreadable sources never read as up to date", () => {
  test.skipIf(!permissionsEnforced)(
    "an unreadable source root fails, keeps its archive and is not available",
    async () => {
      await importMain();
      await chmod(codexRoot, 0o000);
      try {
        await expectSessionsError(importMain(), "SESSIONS_SOURCE_UNAVAILABLE");
        const status = await withService((service) => service.status());
        expect(status.sources[0]?.available).toBe(false);
        await expectSessionsError(
          withService((service) =>
            service.prune({ sourceId: "codex-main", apply: true })
          ),
          "SESSIONS_SOURCE_UNAVAILABLE"
        );
      } finally {
        await chmod(codexRoot, 0o755);
      }
      expect(await searchArchive("SQLite")).toHaveLength(1);
    }
  );

  test.skipIf(!permissionsEnforced)(
    "an unreadable subdirectory makes the import partial and is read once readable",
    async () => {
      const nested = join(codexRoot, "2026", "09", "20");
      await mkdir(nested, { recursive: true });
      await rename(join(codexRoot, CODEX_MAIN), join(nested, CODEX_MAIN));
      await chmod(nested, 0o000);
      try {
        const receipt = await importMain();
        expect(receipt.status).toBe("partial");
        expect(receipt.counts.failed).toBe(1);
        expect(receipt.units).toContainEqual(
          expect.objectContaining({
            locator: ".",
            outcome: "failed",
            reason: "permission_denied",
          })
        );
        expect(await searchArchive("SQLite")).toEqual([]);
        expect((await importMain()).counts.failed).toBe(1);
        await expectSessionsError(
          withService((service) =>
            service.prune({ sourceId: "codex-main", apply: true })
          ),
          "SESSIONS_SOURCE_UNAVAILABLE"
        );
      } finally {
        await chmod(nested, 0o755);
      }
      const healed = await importMain();
      expect(healed.counts.failed).toBe(0);
      expect(healed.counts.imported).toBeGreaterThan(0);
      expect(await searchArchive("SQLite")).toHaveLength(1);
    }
  );

  test.skipIf(!permissionsEnforced)(
    "an unreadable unit file fails by locator instead of being skipped",
    async () => {
      await importMain();
      const file = join(codexRoot, CODEX_MAIN);
      await chmod(file, 0o000);
      try {
        const receipt = await importMain();
        expect(receipt.counts.failed).toBe(1);
        expect(receipt.units).toContainEqual(
          expect.objectContaining({
            locator: CODEX_MAIN,
            outcome: "failed",
            reason: "permission_denied",
          })
        );
      } finally {
        await chmod(file, 0o644);
      }
    }
  );

  test("enumeration reports an unlistable subdirectory and throws for the root", async () => {
    const nested = join(codexRoot, "2026");
    await mkdir(nested, { recursive: true });
    const partial = await enumerateUnits({
      harness: "codex",
      root: codexRoot,
      excluded: [],
      readDirectory: failingListing(nested, "EACCES"),
    });
    expect(partial.units).toHaveLength(4);
    expect(partial.unreadable).toEqual([
      { locator: null, reason: "permission_denied" },
    ]);
    await expect(
      enumerateUnits({
        harness: "codex",
        root: codexRoot,
        excluded: [],
        readDirectory: failingListing(codexRoot, "EACCES"),
      })
    ).rejects.toThrow("EACCES");
  });

  for (const code of ["EACCES", "ENOENT"] as const) {
    test(`a root listing that fails with ${code} after preflight maintains the archive, then fails`, async () => {
      await importMain();
      await setLiterals(["alpha queue"]);
      await expectSessionsError(
        withService(
          (service) =>
            service.import({ sourceId: "codex-main" }, { allowPaths: false }),
          failingListing(codexRoot, code)
        ),
        "SESSIONS_SOURCE_UNAVAILABLE"
      );
      expect(await readAll(join(archiveRoot, "work"))).not.toContain(
        "alpha queue"
      );
      expect(await searchArchive("alpha queue SQLite")).toEqual([]);
    });
  }

  test.skipIf(!permissionsEnforced)(
    "prune refuses a source whose parent directory cannot be read",
    async () => {
      await importMain();
      const parent = join(root, "sources");
      await chmod(parent, 0o000);
      try {
        await expectSessionsError(
          withService((service) =>
            service.prune({ sourceId: "codex-main", apply: true })
          ),
          "SESSIONS_SOURCE_UNAVAILABLE"
        );
      } finally {
        await chmod(parent, 0o755);
      }
      expect(await searchArchive("SQLite")).toHaveLength(1);
    }
  );
});
