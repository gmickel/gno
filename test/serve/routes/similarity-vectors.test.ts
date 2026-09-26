/**
 * REST similar and graph routes read the activated vector partition that
 * `gno embed` writes (fn-136 regression: both read the empty legacy
 * `content_vectors` table).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no directory creation or OS/path equivalents.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerContext } from "../../../src/serve/context";

import { handleGraph } from "../../../src/serve/routes/graph";
import { handleDocSimilar } from "../../../src/serve/routes/links";
import { SqliteAdapter } from "../../../src/store/sqlite/adapter";
import { createVectorIndexPort } from "../../../src/store/vector/sqlite-vec";
import { safeRm } from "../../helpers/cleanup";
import {
  ALPHA_BETA_SCORE,
  embedStoredSimilarityVectors,
  seedSimilarityDocuments,
} from "../../helpers/stored-similarity-fixture";

const MODEL = "hf:synthetic/similarity-embed.gguf";

let dir: string;
let store: SqliteAdapter;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gno-rest-similarity-"));
  store = new SqliteAdapter();
  const opened = await store.open(join(dir, "index.sqlite"), "unicode61");
  if (!opened.ok) throw new Error(opened.error.message);
  const synced = await store.syncCollections([
    { name: "notes", path: dir, pattern: "**/*.md", include: [], exclude: [] },
  ]);
  if (!synced.ok) throw new Error(synced.error.message);
  await seedSimilarityDocuments(store, "notes");
  await embedStoredSimilarityVectors(store.getRawDb(), MODEL);
});

afterEach(async () => {
  await store.close();
  await safeRm(dir);
});

async function docidOf(relPath: string): Promise<string> {
  const doc = await store.getDocument("notes", relPath);
  if (!(doc.ok && doc.value)) throw new Error(`missing ${relPath}`);
  return doc.value.docid;
}

test("GET /api/doc/:id/similar returns neighbours from the partition", async () => {
  const vectorIndex = await createVectorIndexPort(store.getRawDb(), {
    model: MODEL,
    dimensions: 3,
  });
  if (!vectorIndex.ok) throw new Error(vectorIndex.error.message);
  const ctx = { store, vectorIndex: vectorIndex.value } as ServerContext;
  const alpha = await docidOf("alpha.md");

  const res = await handleDocSimilar(
    ctx,
    alpha,
    new URL(`http://localhost/api/doc/${encodeURIComponent(alpha)}/similar`)
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    similar: Array<{ uri: string; score: number }>;
  };
  // The unembedded twins share beta's content but never take its hit.
  expect(body.similar.map((item) => item.uri)).toEqual(["gno://notes/beta.md"]);
  expect(body.similar[0]?.score).toBeCloseTo(ALPHA_BETA_SCORE, 5);
});

test("GET /api/graph?includeSimilar=true emits similarity edges", async () => {
  const res = await handleGraph(
    store,
    new URL(
      "http://localhost/api/graph?includeSimilar=true&linkedOnly=false&threshold=0.5"
    ),
    MODEL
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    links: Array<{
      source: string;
      target: string;
      type: string;
      weight: number;
    }>;
    meta: { similarAvailable: boolean; warnings: string[] };
  };
  expect(body.meta.similarAvailable).toBe(true);
  expect(body.meta.warnings).toEqual([]);
  const pair = [await docidOf("alpha.md"), await docidOf("beta.md")].sort();
  const similar = body.links.filter((link) => link.type === "similar");
  expect(similar.map((link) => [link.source, link.target].sort())).toEqual([
    pair,
  ]);
  expect(similar[0]?.weight).toBeCloseTo(ALPHA_BETA_SCORE, 5);
});
