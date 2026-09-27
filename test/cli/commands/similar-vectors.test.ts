/**
 * `gno similar` and `gno graph --include-similar` read the activated vector
 * partition that `gno embed` writes (fn-136 regression: both read the empty
 * legacy `content_vectors` table, and graph probed sqlite-vec on a connection
 * that never loaded it).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no directory creation or OS/path equivalents.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "../../../src/mcp/server";
import type { ServerContext } from "../../../src/serve/context";

import { getIndexDbPath } from "../../../src/app/constants";
import { runCli } from "../../../src/cli/run";
import { DEFAULT_FTS_TOKENIZER } from "../../../src/config/types";
import { getActivePreset } from "../../../src/llm/registry";
import { handleSimilar } from "../../../src/mcp/tools/links";
import { handleDocSimilar } from "../../../src/serve/routes/links";
import { SqliteAdapter } from "../../../src/store/sqlite/adapter";
import { createVectorIndexPort } from "../../../src/store/vector/sqlite-vec";
import { safeRm } from "../../helpers/cleanup";
import {
  ALPHA_BETA_SCORE,
  embedStoredSimilarityVectors,
  SIMILARITY_DOCS,
  SIMILARITY_VECTORS,
} from "../../helpers/stored-similarity-fixture";

let testDir: string;
const MULTI_DOC = "# Multi\n\nMulti notes.\n";
/** First chunk leans to beta; the mean of both chunks leans to gamma. */
const MULTI_VECTORS = [
  [0, 1, 0],
  [0, 0, 1],
];
/** cos([0,1,0], beta): the first-chunk rule's score for multi -> beta. */
const MULTI_BETA_SCORE = 0.1 / Math.hypot(0.9, 0.1);
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
  testDir = await mkdtemp(join(tmpdir(), "gno-similar-vectors-"));
  const notesDir = join(testDir, "notes");
  await mkdir(notesDir, { recursive: true });
  for (const [relPath, body] of Object.entries(SIMILARITY_DOCS)) {
    await writeFile(join(notesDir, relPath), body);
  }
  await writeFile(join(notesDir, "multi.md"), MULTI_DOC);
  process.env.GNO_CONFIG_DIR = join(testDir, "config");
  process.env.GNO_DATA_DIR = join(testDir, "data");
  process.env.GNO_CACHE_DIR = join(testDir, "cache");
  expect((await cli("init", notesDir, "--name", "notes")).code).toBe(0);
  expect((await cli("update")).code).toBe(0);

  const store = new SqliteAdapter();
  const opened = await store.open(getIndexDbPath(), DEFAULT_FTS_TOKENIZER);
  if (!opened.ok) throw new Error(opened.error.message);
  try {
    // multi.md gets a second chunk: its first chunk and the mean of its
    // chunks point different ways, so the source-vector rule shows in scores.
    const multi = await store.getDocument("notes", "multi.md");
    const mirror = multi.ok ? multi.value?.mirrorHash : undefined;
    if (!mirror) throw new Error("multi.md not indexed");
    const chunks = await store.upsertChunks(mirror, [
      { seq: 0, pos: 0, text: MULTI_DOC, startLine: 1, endLine: 3 },
      {
        seq: 1,
        pos: MULTI_DOC.length,
        text: "More.",
        startLine: 4,
        endLine: 4,
      },
    ]);
    if (!chunks.ok) throw new Error(chunks.error.message);
    await embedStoredSimilarityVectors(
      store.getRawDb(),
      getActivePreset(DEFAULT_CONFIG).embed,
      { ...SIMILARITY_VECTORS, "multi.md": MULTI_VECTORS }
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

test("gno similar scores the first chunk alike on CLI, MCP and REST", async () => {
  const cliRun = await cli(
    "similar",
    "gno://notes/multi.md",
    "--threshold",
    "0",
    "--json"
  );
  expect(cliRun.code).toBe(0);
  const cliScores = (
    JSON.parse(cliRun.stdout) as {
      similar: Array<{ uri: string; score: number }>;
    }
  ).similar;

  const model = getActivePreset(DEFAULT_CONFIG).embed;
  const store = new SqliteAdapter();
  const opened = await store.open(getIndexDbPath(), DEFAULT_FTS_TOKENIZER);
  if (!opened.ok) throw new Error(opened.error.message);
  try {
    const mcp = await handleSimilar(
      { ref: "gno://notes/multi.md", threshold: 0 },
      {
        store,
        config: DEFAULT_CONFIG,
        collections: [],
        toolMutex: { acquire: async () => () => {} },
        isShuttingDown: () => false,
      } as unknown as ToolContext
    );
    expect(mcp.isError).toBeFalsy();
    const mcpScores = (
      mcp.structuredContent as {
        similar: Array<{ uri: string; score: number }>;
      }
    ).similar;

    const vectorIndex = await createVectorIndexPort(store.getRawDb(), {
      model,
      dimensions: 3,
    });
    if (!vectorIndex.ok) throw new Error(vectorIndex.error.message);
    const multi = await store.getDocument("notes", "multi.md");
    const docid = multi.ok ? (multi.value?.docid ?? "") : "";
    const rest = await handleDocSimilar(
      { store, vectorIndex: vectorIndex.value } as ServerContext,
      docid,
      new URL(
        `http://localhost/api/doc/${encodeURIComponent(docid)}/similar?threshold=0`
      )
    );
    expect(rest.status).toBe(200);
    const restScores = (
      (await rest.json()) as {
        similar: Array<{ uri: string; score: number }>;
      }
    ).similar;

    for (const scores of [cliScores, mcpScores, restScores]) {
      expect(scores[0]?.uri).toBe("gno://notes/beta.md");
      expect(scores[0]?.score).toBeCloseTo(MULTI_BETA_SCORE, 5);
    }
  } finally {
    await store.close();
  }
});
