import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
// node:os provides the temporary root
import { tmpdir } from "node:os";
// node:path has no Bun path utilities
import { join } from "node:path";

import type { Collection, Config } from "../../src/config/types";

import {
  cleanup,
  formatDroppingCollections,
} from "../../src/cli/commands/cleanup";
import { formatStatus, status } from "../../src/cli/commands/status";
import { runCli } from "../../src/cli/run";
import { createDefaultConfig, saveConfigToPath } from "../../src/config";
import { applyConfigChange } from "../../src/core/config-mutation";
import { createGnoClient } from "../../src/sdk";
import { adoptServedConfig } from "../../src/sessions/config-refresh";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

let root = "";
let dbPath = "";
const savedEnv = {
  config: process.env.GNO_CONFIG_DIR,
  data: process.env.GNO_DATA_DIR,
  cache: process.env.GNO_CACHE_DIR,
};

function collection(name: string): Collection {
  return {
    name,
    path: join(root, name),
    pattern: "**/*.md",
    include: [],
    exclude: [],
  };
}

function configWith(...names: string[]): Config {
  const config = createDefaultConfig();
  config.collections = names.map(collection);
  return config;
}

async function indexedDocuments(name: string): Promise<number> {
  const store = new SqliteAdapter();
  const opened = await store.open(dbPath, createDefaultConfig().ftsTokenizer);
  if (!opened.ok) throw new Error(opened.error.message);
  try {
    const stale = await store.listStaleCollections([]);
    if (!stale.ok) throw new Error(stale.error.message);
    return stale.value.find((c) => c.name === name)?.documents ?? 0;
  } finally {
    await store.close();
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gno-sync-safety-"));
  dbPath = join(root, "data", "index-default.sqlite");
  for (const name of ["notes", "sandbox"]) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, `${name}.md`), `# ${name}\n\nalpha\n`);
  }
  process.env.GNO_CONFIG_DIR = join(root, "config");
  process.env.GNO_DATA_DIR = join(root, "data");
  process.env.GNO_CACHE_DIR = join(root, "cache");
  const client = await createGnoClient({
    config: configWith("notes"),
    dbPath,
  });
  try {
    await client.update();
  } finally {
    await client.close();
  }
});

afterEach(async () => {
  for (const [key, value] of [
    ["GNO_CONFIG_DIR", savedEnv.config],
    ["GNO_DATA_DIR", savedEnv.data],
    ["GNO_CACHE_DIR", savedEnv.cache],
  ] as const) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  await safeRm(root);
});

test("a client with another config cannot delete or see indexed collections", async () => {
  expect(await indexedDocuments("notes")).toBe(1);

  let caught: unknown;
  try {
    await createGnoClient({ config: configWith("sandbox"), dbPath });
  } catch (error) {
    caught = error;
  }
  expect(String((caught as Error)?.message)).toContain(
    "This index holds collections the config does not list: notes (1 document)"
  );

  expect(await indexedDocuments("notes")).toBe(1);
  expect(await indexedDocuments("sandbox")).toBe(0);
  const owner = await createGnoClient({ config: configWith("notes"), dbPath });
  try {
    const found = await owner.search("alpha");
    expect(found.results.map((r) => r.uri)).toEqual(["gno://notes/notes.md"]);
  } finally {
    await owner.close();
  }
});

test("a CLI search with another --config leaves the index intact", async () => {
  const otherConfig = join(root, "other", "index.yml");
  await saveConfigToPath(configWith("sandbox"), otherConfig);
  const stderr: string[] = [];
  const originalError = console.error;
  const originalWrite = process.stderr.write.bind(process.stderr);
  console.error = (...args: unknown[]) => stderr.push(args.join(" "));
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  let code: number;
  try {
    code = await runCli([
      "node",
      "gno",
      "--config",
      otherConfig,
      "search",
      "alpha",
    ]);
  } finally {
    console.error = originalError;
    process.stderr.write = originalWrite;
  }
  expect(code).not.toBe(0);
  expect(stderr.join("")).toContain("notes (1 document)");
  expect(await indexedDocuments("notes")).toBe(1);
});

test("status names indexed collections the config omits", async () => {
  const otherConfig = join(root, "other", "index.yml");
  await saveConfigToPath(configWith("sandbox"), otherConfig);
  const result = await status({ configPath: otherConfig });
  expect(result.success && result.staleCollections).toEqual([
    { name: "notes", documents: 1 },
  ]);
  expect(formatStatus(result, {})).toContain(
    'Collections not in this config; add them back, or run "gno cleanup" to delete their index data:\n  notes: 1 document'
  );
  expect(
    JSON.parse(formatStatus(result, { json: true })).staleCollections
  ).toEqual([{ name: "notes", documents: 1 }]);
});

test("cleanup is the explicit removal and names what it deletes first", async () => {
  const otherConfig = join(root, "other", "index.yml");
  await saveConfigToPath(configWith("sandbox"), otherConfig);
  let announced: unknown;
  const result = await cleanup({
    configPath: otherConfig,
    onDropping: (collections) => {
      announced = collections;
    },
  });
  expect(announced).toEqual([{ name: "notes", documents: 1 }]);
  expect(result.success && result.droppedCollections).toEqual([
    { name: "notes", documents: 1 },
  ]);
  expect(formatDroppingCollections([{ name: "notes", documents: 1 }])).toBe(
    "Deleting collections not in this config:\n  notes: 1 document"
  );
  expect(await indexedDocuments("notes")).toBe(0);
});

test("cleanup --json reports the deleted collections", async () => {
  const otherConfig = join(root, "other", "index.yml");
  await saveConfigToPath(configWith("sandbox"), otherConfig);
  const out: string[] = [];
  const err: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  let code: number;
  try {
    code = await runCli([
      "node",
      "gno",
      "--config",
      otherConfig,
      "cleanup",
      "--json",
    ]);
  } finally {
    process.stdout.write = write;
    process.stderr.write = writeErr;
  }
  expect(code).toBe(0);
  expect(JSON.parse(err.join(""))).toEqual({
    deleting: [{ name: "notes", documents: 1 }],
  });
  expect(JSON.parse(out.join("")).droppedCollections).toEqual([
    { name: "notes", documents: 1 },
  ]);
});

test("collection remove deletes its collection despite an unrelated stale one", async () => {
  const store = new SqliteAdapter();
  const opened = await store.open(dbPath, createDefaultConfig().ftsTokenizer);
  if (!opened.ok) throw new Error(opened.error.message);
  try {
    // "notes" is indexed but missing from the config being mutated.
    const configPath = join(root, "mutated", "index.yml");
    await saveConfigToPath(configWith("sandbox"), configPath);
    expect(
      (
        await store.syncCollections([collection("sandbox")], {
          keepStale: true,
        })
      ).ok
    ).toBe(true);
    const removed = await applyConfigChange(
      { store, configPath },
      (config) => ({
        ok: true as const,
        config: { ...config, collections: [] },
      })
    );
    expect(removed.ok).toBe(true);
    const left = await store.listStaleCollections([]);
    expect(left.ok && left.value.map(({ name }) => name)).toEqual(["notes"]);
  } finally {
    await store.close();
  }
  expect(await indexedDocuments("notes")).toBe(1);
});

test("a served config edit that drops a collection never deletes it", async () => {
  const store = new SqliteAdapter();
  const opened = await store.open(dbPath, createDefaultConfig().ftsTokenizer);
  if (!opened.ok) throw new Error(opened.error.message);
  const served = configWith("notes");
  try {
    let caught: unknown;
    try {
      await adoptServedConfig(
        {
          store,
          config: served,
          setConfig: () => undefined,
        } as unknown as Parameters<typeof adoptServedConfig>[0],
        configWith("sandbox")
      );
    } catch (error) {
      caught = error;
    }
    expect(String((caught as Error)?.message)).toContain("notes (1 document)");
  } finally {
    await store.close();
  }
  expect(await indexedDocuments("notes")).toBe(1);
});

test("explicit sync removals delete; unlisted collections are kept", async () => {
  const store = new SqliteAdapter();
  const opened = await store.open(dbPath, createDefaultConfig().ftsTokenizer);
  if (!opened.ok) throw new Error(opened.error.message);
  try {
    // An unlisted collection without documents is kept and never blocks.
    expect(
      (
        await store.syncCollections([
          collection("notes"),
          collection("sandbox"),
        ])
      ).ok
    ).toBe(true);
    expect((await store.syncCollections([collection("notes")])).ok).toBe(true);
    const unlisted = await store.listStaleCollections(["notes"]);
    expect(unlisted.ok && unlisted.value).toEqual([
      { name: "sandbox", documents: 0 },
    ]);

    const kept = await store.syncCollections([], { keepStale: true });
    expect(kept.ok).toBe(true);
    const refused = await store.syncCollections([]);
    expect(refused.ok ? null : refused.error.code).toBe("STALE_COLLECTIONS");

    expect((await store.syncCollections([], { remove: ["notes"] })).ok).toBe(
      true
    );
    const rest = await store.listStaleCollections([]);
    expect(rest.ok && rest.value.map(({ name }) => name)).toEqual(["sandbox"]);
  } finally {
    await store.close();
  }
  expect(await indexedDocuments("notes")).toBe(0);
});

test("an open client stops reading once another client indexes a collection it omits", async () => {
  const owner = await createGnoClient({ config: configWith("notes"), dbPath });
  try {
    expect((await owner.search("alpha")).results).toHaveLength(1);
    const wider = await createGnoClient({
      config: configWith("notes", "sandbox"),
      dbPath,
    });
    try {
      await wider.update();
    } finally {
      await wider.close();
    }
    let caught: unknown;
    try {
      await owner.search("alpha");
    } catch (error) {
      caught = error;
    }
    expect(String((caught as Error)?.message)).toContain(
      "sandbox (1 document)"
    );
  } finally {
    await owner.close();
  }
});
