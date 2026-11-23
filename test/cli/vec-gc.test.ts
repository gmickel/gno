/**
 * `gno vec gc` on a real index (gno#361): `gno update` deactivating a removed
 * file leaves its variant collectible; `--dry-run` reports it without writing
 * (no migrations, no lease); a real run removes it with its vec0 row and owner
 * binding and keeps shared content.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no directory creation or OS/path equivalents.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getIndexDbPath } from "../../src/app/constants";
import { vecGc } from "../../src/cli/commands/vec";
import { runCli } from "../../src/cli/run";
import { DEFAULT_FTS_TOKENIZER } from "../../src/config/types";
import { getActivePreset } from "../../src/llm/registry";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { storedVectorPartition } from "../../src/store/vector/status";
import { loadSqliteVec } from "../../src/store/vector/variants";
import { safeRm } from "../helpers/cleanup";
import {
  embedStoredSimilarityVectors,
  SIMILARITY_DOCS,
} from "../helpers/stored-similarity-fixture";

const MODEL = getActivePreset({
  version: "1.0" as const,
  ftsTokenizer: DEFAULT_FTS_TOKENIZER,
  collections: [],
  contexts: [],
}).embed;
const envKeys = ["GNO_CONFIG_DIR", "GNO_DATA_DIR", "GNO_CACHE_DIR"] as const;
let testDir: string;
let notesDir: string;

async function cli(...args: string[]): Promise<{ code: number; out: string }> {
  const write = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = (chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  };
  try {
    return { code: await runCli(["node", "gno", ...args]), out };
  } finally {
    process.stdout.write = write;
  }
}

async function withIndex<T>(
  fn: (db: ReturnType<SqliteAdapter["getRawDb"]>, partitionId: string) => T
): Promise<T> {
  const store = new SqliteAdapter();
  const opened = await store.open(getIndexDbPath(), DEFAULT_FTS_TOKENIZER);
  if (!opened.ok) throw new Error(opened.error.message);
  try {
    const db = store.getRawDb();
    expect(await loadSqliteVec(db)).toBe(true);
    const partition = storedVectorPartition(db, MODEL);
    if (!partition) throw new Error("no active partition");
    return fn(db, partition.partitionId);
  } finally {
    await store.close();
  }
}

const count = (db: ReturnType<SqliteAdapter["getRawDb"]>, sql: string) =>
  db.query<{ n: number }, []>(sql).get()?.n ?? -1;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "gno-vec-gc-"));
  notesDir = join(testDir, "notes");
  await mkdir(notesDir, { recursive: true });
  for (const [relPath, body] of Object.entries(SIMILARITY_DOCS))
    await writeFile(join(notesDir, relPath), body);
  process.env.GNO_CONFIG_DIR = join(testDir, "config");
  process.env.GNO_DATA_DIR = join(testDir, "data");
  process.env.GNO_CACHE_DIR = join(testDir, "cache");
  expect((await cli("init", notesDir, "--name", "notes")).code).toBe(0);
  expect((await cli("update")).code).toBe(0);
  const store = new SqliteAdapter();
  const opened = await store.open(getIndexDbPath(), DEFAULT_FTS_TOKENIZER);
  if (!opened.ok) throw new Error(opened.error.message);
  try {
    await embedStoredSimilarityVectors(store.getRawDb(), MODEL);
  } finally {
    await store.close();
  }
}, 30_000);

afterAll(async () => {
  await safeRm(testDir);
  for (const key of envKeys) Reflect.deleteProperty(process.env, key);
});

test("vec gc removes exactly what update left unowned; --dry-run writes nothing", async () => {
  const before = await withIndex((db, pid) => ({
    variants: count(
      db,
      `SELECT count(*) AS n FROM vector_variants WHERE partition_id = '${pid}'`
    ),
    mirrored: count(db, `SELECT count(*) AS n FROM vec_v1_${pid}`),
  }));
  // Nothing to collect yet.
  const idle = await cli("vec", "gc", "--dry-run", "--json");
  expect(idle.code).toBe(0);
  expect(JSON.parse(idle.out)).toMatchObject({ dryRun: true, variants: 0 });

  // Removing gamma (unique content) leaves its variant without a live use.
  await rm(join(notesDir, "gamma.md"));
  expect((await cli("update")).code).toBe(0);

  const dbPath = getIndexDbPath();
  const bytes = await Bun.file(dbPath).bytes();
  const dry = await cli("vec", "gc", "--dry-run", "--json");
  expect(dry.code).toBe(0);
  const dryReport = JSON.parse(dry.out);
  expect(dryReport).toMatchObject({
    dryRun: true,
    variants: 1,
    bytes: 12,
    legacyContentVectors: 0,
  });
  expect(dryReport.databaseBytes).toBe(Bun.file(dbPath).size);
  expect(await Bun.file(dbPath).bytes()).toEqual(bytes);

  const text = await cli("vec", "gc", "--dry-run");
  expect(text.out).toContain("Dry run: 1 unused vector variants");
  expect(text.out).toContain("Deleting rows does not shrink the file");

  const real = await vecGc();
  expect(real).toMatchObject({ success: true, dryRun: false, variants: 1 });
  await withIndex((db, pid) => {
    expect(
      count(
        db,
        `SELECT count(*) AS n FROM vector_variants WHERE partition_id = '${pid}'`
      )
    ).toBe(before.variants - 1);
    expect(count(db, `SELECT count(*) AS n FROM vec_v1_${pid}`)).toBe(
      before.mirrored - 1
    );
    expect(
      count(
        db,
        "SELECT count(*) AS n FROM vector_owners o JOIN documents d ON d.id = o.document_id WHERE d.rel_path = 'gamma.md'"
      )
    ).toBe(0);
    expect(count(db, "SELECT count(*) AS n FROM vector_gc_candidates")).toBe(0);
  });
  const again = await cli("vec", "gc", "--json");
  expect(JSON.parse(again.out)).toMatchObject({ dryRun: false, variants: 0 });
});

test("vec gc --dry-run on an index name with no database reports nothing and creates nothing", async () => {
  const path = getIndexDbPath("unused");
  const dry = await cli(
    "--index",
    "unused",
    "vec",
    "gc",
    "--dry-run",
    "--json"
  );
  expect(dry.code).toBe(0);
  expect(JSON.parse(dry.out)).toMatchObject({
    dryRun: true,
    partitions: [],
    variants: 0,
  });
  expect(await Bun.file(path).exists()).toBe(false);
});
