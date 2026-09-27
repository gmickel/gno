/**
 * `gno vec sync`, `gno vec rebuild` and the doctor fingerprint check read the
 * activated vector partition that `gno embed` writes since 2.7 (they read only
 * the legacy `content_vectors` table, which such an index leaves empty).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no directory creation or OS/path equivalents.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getIndexDbPath } from "../../src/app/constants";
import { doctor } from "../../src/cli/commands/doctor";
import { vecRebuild, vecSync } from "../../src/cli/commands/vec";
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

const DEFAULT_CONFIG = {
  version: "1.0" as const,
  ftsTokenizer: DEFAULT_FTS_TOKENIZER,
  collections: [],
  contexts: [],
};
const MODEL = getActivePreset(DEFAULT_CONFIG).embed;
const envKeys = ["GNO_CONFIG_DIR", "GNO_DATA_DIR", "GNO_CACHE_DIR"] as const;
let testDir: string;

async function quietCli(...args: string[]): Promise<number> {
  const out = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    return await runCli(["node", "gno", ...args]);
  } finally {
    process.stdout.write = out;
  }
}

/** Run `fn` on the raw index database with sqlite-vec loaded. */
async function withIndex<T>(
  fn: (
    db: ReturnType<SqliteAdapter["getRawDb"]>,
    partitionId: string
  ) => T | Promise<T>
): Promise<T> {
  const store = new SqliteAdapter();
  const opened = await store.open(getIndexDbPath(), DEFAULT_FTS_TOKENIZER);
  if (!opened.ok) throw new Error(opened.error.message);
  try {
    const db = store.getRawDb();
    expect(await loadSqliteVec(db)).toBe(true);
    const partition = storedVectorPartition(db, MODEL);
    if (!partition) throw new Error("no active partition");
    return await fn(db, partition.partitionId);
  } finally {
    await store.close();
  }
}

const count = (db: ReturnType<SqliteAdapter["getRawDb"]>, sql: string) =>
  db.query<{ n: number }, []>(sql).get()?.n ?? -1;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "gno-vec-partition-"));
  const notesDir = join(testDir, "notes");
  await mkdir(notesDir, { recursive: true });
  for (const [relPath, body] of Object.entries(SIMILARITY_DOCS)) {
    await writeFile(join(notesDir, relPath), body);
  }
  process.env.GNO_CONFIG_DIR = join(testDir, "config");
  process.env.GNO_DATA_DIR = join(testDir, "data");
  process.env.GNO_CACHE_DIR = join(testDir, "cache");
  expect(await quietCli("init", notesDir, "--name", "notes")).toBe(0);
  expect(await quietCli("update")).toBe(0);
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

test("vec sync restores the active partition's index", async () => {
  const variants = await withIndex((db, pid) => {
    expect(count(db, "SELECT COUNT(*) AS n FROM content_vectors")).toBe(0);
    db.run(
      `DELETE FROM vec_v1_${pid} WHERE variant_id = (SELECT MIN(variant_id) FROM vector_variants WHERE partition_id = '${pid}')`
    );
    return count(
      db,
      `SELECT COUNT(*) AS n FROM vector_variants WHERE partition_id = '${pid}'`
    );
  });
  expect(variants).toBeGreaterThan(1);

  expect(await vecSync()).toEqual({
    success: true,
    added: 1,
    removed: 0,
    model: MODEL,
  });
  expect(await vecSync()).toEqual({
    success: true,
    added: 0,
    removed: 0,
    model: MODEL,
  });
  await withIndex((db, pid) => {
    expect(count(db, `SELECT COUNT(*) AS n FROM vec_v1_${pid}`)).toBe(variants);
  });
});

test("vec rebuild repopulates the active partition's index", async () => {
  const variants = await withIndex((db, pid) => {
    db.run(`DELETE FROM vec_v1_${pid}`);
    return count(
      db,
      `SELECT COUNT(*) AS n FROM vector_variants WHERE partition_id = '${pid}'`
    );
  });
  expect(await vecRebuild()).toEqual({
    success: true,
    count: variants,
    model: MODEL,
  });
  await withIndex((db, pid) => {
    expect(count(db, `SELECT COUNT(*) AS n FROM vec_v1_${pid}`)).toBe(variants);
  });
});

test("doctor counts the active partition in the fingerprint groups", async () => {
  const owners = await withIndex((db, pid) =>
    count(
      db,
      `SELECT COUNT(*) AS n FROM vector_owners WHERE partition_id = '${pid}'`
    )
  );
  const result = await doctor();
  const check = result.checks.find(
    ({ name }) => name === "embedding-fingerprint"
  );
  const health = check?.embeddingFingerprint;
  expect(health?.groups).toEqual([
    {
      model: MODEL,
      fingerprint: health?.currentFingerprint ?? "",
      count: owners,
      current: true,
      legacy: false,
    },
  ]);
  expect(health?.mixedGroups).toBe(1);
  expect(health?.legacyChunks).toBe(0);
});
