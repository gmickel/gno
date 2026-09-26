/**
 * `gno similar` and `gno graph --include-similar` read the activated vector
 * partition that `gno embed` writes (fn-136 regression: both read the empty
 * legacy `content_vectors` table, and graph probed sqlite-vec on a connection
 * that never loaded it).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no directory creation or OS/path equivalents.
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getIndexDbPath } from "../../../src/app/constants";
import { runCli } from "../../../src/cli/run";
import { DEFAULT_FTS_TOKENIZER } from "../../../src/config/types";
import { getActivePreset } from "../../../src/llm/registry";
import { SqliteAdapter } from "../../../src/store/sqlite/adapter";
import { safeRm } from "../../helpers/cleanup";
import {
  ALPHA_BETA_SCORE,
  embedStoredSimilarityVectors,
  SIMILARITY_DOCS,
} from "../../helpers/stored-similarity-fixture";

let testDir: string;
/** `gno init` writes no model settings, so the default preset is active. */
const DEFAULT_CONFIG = {
  version: "1.0" as const,
  ftsTokenizer: DEFAULT_FTS_TOKENIZER,
  collections: [],
  contexts: [],
};
const envKeys = ["GNO_CONFIG_DIR", "GNO_DATA_DIR", "GNO_CACHE_DIR"] as const;

async function cli(
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const out = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  const log = console.log.bind(console);
  const error = console.error.bind(console);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  console.log = (...parts: unknown[]) => {
    stdout += `${parts.join(" ")}\n`;
  };
  console.error = (...parts: unknown[]) => {
    stderr += `${parts.join(" ")}\n`;
  };
  try {
    const code = await runCli(["node", "gno", ...args]);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = errWrite;
    console.log = log;
    console.error = error;
  }
}

beforeAll(async () => {
  testDir = join(tmpdir(), `gno-similar-vectors-${crypto.randomUUID()}`);
  const notesDir = join(testDir, "notes");
  await mkdir(notesDir, { recursive: true });
  for (const [relPath, body] of Object.entries(SIMILARITY_DOCS)) {
    await writeFile(join(notesDir, relPath), body);
  }
  process.env.GNO_CONFIG_DIR = join(testDir, "config");
  process.env.GNO_DATA_DIR = join(testDir, "data");
  process.env.GNO_CACHE_DIR = join(testDir, "cache");
  expect((await cli("init", notesDir, "--name", "notes")).code).toBe(0);
  expect((await cli("update")).code).toBe(0);

  const store = new SqliteAdapter();
  const opened = await store.open(getIndexDbPath(), DEFAULT_FTS_TOKENIZER);
  if (!opened.ok) throw new Error(opened.error.message);
  try {
    await embedStoredSimilarityVectors(
      store.getRawDb(),
      getActivePreset(DEFAULT_CONFIG).embed
    );
  } finally {
    await store.close();
  }
}, 30_000);

afterAll(async () => {
  await safeRm(testDir);
  for (const key of envKeys) Reflect.deleteProperty(process.env, key);
});

test("gno similar returns neighbours from the activated partition", async () => {
  const { code, stdout, stderr } = await cli(
    "similar",
    "gno://notes/alpha.md",
    "--threshold",
    "0.5",
    "--json"
  );
  expect(stderr).toBe("");
  expect(code).toBe(0);
  const data = JSON.parse(stdout) as {
    similar: Array<{ uri: string; score: number }>;
  };
  // The unembedded twins share beta's content but never take its hit.
  expect(data.similar.map((item) => item.uri)).toEqual(["gno://notes/beta.md"]);
  expect(data.similar[0]?.score).toBeCloseTo(ALPHA_BETA_SCORE, 5);
});

test("gno graph --include-similar emits similarity edges", async () => {
  const { code, stdout } = await cli(
    "graph",
    "--include-similar",
    "--include-isolated",
    "--threshold",
    "0.5",
    "--json"
  );
  expect(code).toBe(0);
  const data = JSON.parse(stdout) as {
    nodes: Array<{ id: string; uri: string }>;
    links: Array<{
      source: string;
      target: string;
      type: string;
      weight: number;
    }>;
    meta: {
      includedSimilar: boolean;
      similarAvailable: boolean;
      warnings: string[];
    };
  };
  expect(data.meta).toMatchObject({
    includedSimilar: true,
    similarAvailable: true,
    warnings: [],
  });
  const uriById = new Map(data.nodes.map((node) => [node.id, node.uri]));
  const similar = data.links
    .filter((link) => link.type === "similar")
    .map((link) => ({
      pair: [uriById.get(link.source) ?? "", uriById.get(link.target) ?? ""]
        .sort((a, b) => a.localeCompare(b))
        .join(" "),
      weight: link.weight,
    }));
  expect(similar.map((edge) => edge.pair)).toEqual([
    "gno://notes/alpha.md gno://notes/beta.md",
  ]);
  expect(similar[0]?.weight).toBeCloseTo(ALPHA_BETA_SCORE, 5);
});
