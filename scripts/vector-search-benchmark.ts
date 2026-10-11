/**
 * Vector search latency benchmark (opt-in; not part of `bun test`).
 *
 * Times the vector leg of one search (the exact, eligibility-first scan over
 * an activated partition) for unscoped, collection-scoped and
 * metadata-filtered searches. No models run: query vectors are seeded.
 *
 * Usage:
 *   bun run bench:vector-search                          # synthetic, 20k chunks x 768d
 *   bun run bench:vector-search -- --chunks 100000 --dims 1024
 *   bun run bench:vector-search -- --index <copy-of-index.sqlite>
 *
 * --index reads an existing index read-only. Point it at a copy, never at a
 * live index another process is writing.
 */

import { Database } from "bun:sqlite";
// node:fs/promises for mkdtemp (filesystem structure op)
import { mkdtemp } from "node:fs/promises";
// node:os provides the temporary root
import { tmpdir } from "node:os";
// node:path has no Bun path utilities
import { join } from "node:path";

import type { VectorSearchOptions } from "../src/store/vector/types";

import { TYPED_METADATA_INGEST_VERSION } from "../src/core/typed-metadata";
import { SqliteAdapter } from "../src/store/sqlite/adapter";
import { searchVectorVariants } from "../src/store/vector/variant-search";
import {
  createVectorVariantStore,
  loadSqliteVec,
} from "../src/store/vector/variants";
import { safeRm } from "../test/helpers/cleanup";

const QUERIES = 20;
const CHUNKS_PER_DOC = 4;

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

/** Deterministic PRNG so runs are comparable. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Partition {
  partitionId: string;
  model: string;
  dimensions: number;
}

function activePartition(db: Database): Partition {
  const row = db
    .query<{ partitionId: string; model: string; dimensions: number }, []>(
      "SELECT partition_id AS partitionId, model, dimensions FROM vector_partitions WHERE state = 'active' AND activated_epoch IS NOT NULL ORDER BY partition_id LIMIT 1"
    )
    .get();
  if (!row) throw new Error("No activated vector partition in this index");
  return row;
}

function report(
  db: Database,
  partition: Partition,
  cases: [string, VectorSearchOptions][]
) {
  const random = prng(42);
  const chunks = db
    .query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM vector_owners WHERE partition_id = ?"
    )
    .get(partition.partitionId)!.n;
  console.log(
    `partition ${partition.partitionId.slice(0, 12)} model=${partition.model} dims=${partition.dimensions} owners=${chunks}`
  );
  console.log(
    "case".padEnd(28),
    "p50 ms".padStart(8),
    "max ms".padStart(8),
    "results".padStart(8)
  );
  for (const [label, options] of cases) {
    const times: number[] = [];
    let results = 0;
    for (let index = 0; index < QUERIES; index++) {
      const query = Float32Array.from(
        { length: partition.dimensions },
        () => random() * 2 - 1
      );
      const started = performance.now();
      const rows = searchVectorVariants(
        db,
        partition.model,
        partition.dimensions,
        query,
        20,
        { ...options, partitionId: partition.partitionId }
      );
      times.push(performance.now() - started);
      results = rows?.length ?? 0;
    }
    times.sort((a, b) => a - b);
    console.log(
      label.padEnd(28),
      times[Math.floor(QUERIES / 2)]!.toFixed(1).padStart(8),
      times.at(-1)!.toFixed(1).padStart(8),
      String(results).padStart(8)
    );
  }
}

async function benchIndexCopy(path: string): Promise<void> {
  const db = new Database(path, { readonly: true });
  try {
    if (!(await loadSqliteVec(db))) throw new Error("sqlite-vec unavailable");
    const collection = db
      .query<{ collection: string }, []>(
        "SELECT collection FROM documents WHERE active = 1 GROUP BY collection ORDER BY count(*) DESC LIMIT 1"
      )
      .get()?.collection;
    const tag = db
      .query<{ tag: string }, []>(
        "SELECT tag FROM doc_tags GROUP BY tag ORDER BY count(*) DESC LIMIT 1"
      )
      .get()?.tag;
    report(db, activePartition(db), [
      ["unscoped", {}],
      ...(collection
        ? [
            [`collection ${collection}`, { eligibility: { collection } }] as [
              string,
              VectorSearchOptions,
            ],
          ]
        : []),
      ...(tag
        ? [
            [`tag ${tag}`, { eligibility: { tagsAny: [tag] } }] as [
              string,
              VectorSearchOptions,
            ],
          ]
        : []),
    ]);
  } finally {
    db.close();
  }
}

async function benchSynthetic(
  chunks: number,
  dimensions: number
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "gno-vector-bench-"));
  const adapter = new SqliteAdapter();
  try {
    const path = join(root, "index.sqlite");
    const opened = await adapter.open(path, "unicode61");
    if (!opened.ok) throw new Error(opened.error.message);
    const synced = await adapter.syncCollections(
      ["large", "small"].map((name) => ({
        name,
        path: join(root, name),
        pattern: "**/*",
        include: [],
        exclude: [],
      }))
    );
    if (!synced.ok) throw new Error(synced.error.message);
    const documents = Math.ceil(chunks / CHUNKS_PER_DOC);
    const started = performance.now();
    for (let index = 0; index < documents; index++) {
      const mirrorHash = `bench-${index}`;
      const texts = Array.from(
        { length: CHUNKS_PER_DOC },
        (_, seq) => `synthetic body ${index} chunk ${seq}`
      );
      const inserted = await adapter.upsertDocument({
        collection: index % 10 === 0 ? "small" : "large",
        relPath: `doc-${index}.md`,
        sourceHash: `source-${index}`,
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: 100,
        sourceMtime: "2026-01-01T00:00:00.000Z",
        title: `Document ${index}`,
        mirrorHash,
        typedMetadata: { tier: index % 20 },
        ingestVersion: TYPED_METADATA_INGEST_VERSION,
      });
      if (!inserted.ok) throw new Error(inserted.error.message);
      await adapter.upsertContent(mirrorHash, texts.join("\n"));
      await adapter.upsertChunks(
        mirrorHash,
        texts.map((text, seq) => ({
          seq,
          pos: seq,
          text,
          startLine: seq + 1,
          endLine: seq + 1,
        }))
      );
    }
    const db = adapter.getRawDb();
    const store = await createVectorVariantStore(db, {
      model: "bench-model",
      modelFingerprint: "bench-weights",
      contextSize: 512,
      truncationPolicy: "tail-v1",
      dimensions,
    });
    const random = prng(7);
    for (;;) {
      const pending = store.pending({ limit: 2000 });
      if (pending.length === 0) break;
      store.write(
        pending.map((owner) => ({
          owner,
          embedding: Float32Array.from(
            { length: dimensions },
            () => random() * 2 - 1
          ),
        }))
      );
    }
    store.activate(store.epoch());
    console.log(
      `built ${documents} documents / ${documents * CHUNKS_PER_DOC} chunks in ${((performance.now() - started) / 1000).toFixed(1)} s`
    );
    report(
      db,
      { partitionId: store.partitionId, model: "bench-model", dimensions },
      [
        ["unscoped", {}],
        ["collection small (10%)", { eligibility: { collection: "small" } }],
        [
          "metadata tier=3 (5%)",
          { eligibility: { filter: { op: "eq", key: "tier", value: 3 } } },
        ],
      ]
    );
  } finally {
    await adapter.close();
    await safeRm(root);
  }
}

const index = flag("--index", "");
await (index
  ? benchIndexCopy(index)
  : benchSynthetic(
      Number(flag("--chunks", "20000")),
      Number(flag("--dims", "768"))
    ));
