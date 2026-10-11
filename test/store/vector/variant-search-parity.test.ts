import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no directory-creation or OS/path equivalents.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { VectorSearchOptions } from "../../../src/store/vector/types";

import { TYPED_METADATA_INGEST_VERSION } from "../../../src/core/typed-metadata";
import { formatDocForEmbedding } from "../../../src/pipeline/contextual";
import { SqliteAdapter } from "../../../src/store/sqlite/adapter";
import { buildEligibleDocumentQuery } from "../../../src/store/sqlite/eligibility";
import { syncPartitionIndex } from "../../../src/store/vector/partition-index";
import {
  createVectorIndexPort,
  encodeEmbedding,
} from "../../../src/store/vector/sqlite-vec";
import { searchVectorVariants } from "../../../src/store/vector/variant-search";
import {
  createVectorVariantStore,
  embeddingInputHash,
  type VectorVariantStore,
} from "../../../src/store/vector/variants";
import { safeRm } from "../../helpers/cleanup";

const DIMENSIONS = 8;
const identity = {
  model: "parity-model",
  modelFingerprint: "parity-weights",
  contextSize: 512,
  truncationPolicy: "tail-v1",
  dimensions: DIMENSIONS,
};

/** Deterministic PRNG so every run sees the same corpus and queries. */
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

function vector(random: () => number): Float32Array {
  return Float32Array.from({ length: DIMENSIONS }, () => random() * 2 - 1);
}

/**
 * The pre-2.11 implementation, kept verbatim as the parity oracle: prove
 * every eligible owner's input hash, then rank the proven owners.
 */
function referenceSearch(
  db: Database,
  partitionId: string,
  embedding: Float32Array,
  k: number,
  options: VectorSearchOptions
) {
  const tableName = `vec_v1_${partitionId}`;
  const eligible = buildEligibleDocumentQuery(
    { ...options.eligibility, semanticMetadata: true },
    db
  );
  const conditions = ["o.partition_id = ?"];
  const params: (string | number)[] = [partitionId];
  if (options.eligibility?.language) {
    conditions.push("c.language = ?");
    params.push(options.eligibility.language);
  }
  const bindings = db
    .query<
      {
        document_id: number;
        seq: number;
        text: string;
        title: string | null;
        input_hash: string;
      },
      (string | number)[]
    >(`
    SELECT o.document_id, o.seq, c.text, d.title, v.input_hash
    FROM vector_owners o
    JOIN (${eligible.sql}) e ON e.id = o.document_id AND e.mirror_hash = o.mirror_hash
    JOIN documents d ON d.id = o.document_id
    JOIN content_chunks c ON c.mirror_hash = o.mirror_hash AND c.seq = o.seq
    JOIN vector_variants v ON v.variant_id = o.variant_id AND v.partition_id = o.partition_id
    WHERE ${conditions.join(" AND ")}
  `)
    .all(...eligible.params, ...params);
  const proven = bindings
    .filter(
      (row) =>
        row.input_hash ===
        embeddingInputHash(
          formatDocForEmbedding(
            row.text,
            row.title ?? undefined,
            identity.model
          )
        )
    )
    .map((row) => `${row.document_id}:${row.seq}`);
  return db
    .query<
      {
        mirrorHash: string;
        seq: number;
        distance: number;
        documentIds: string;
      },
      (Uint8Array | string | number)[]
    >(`
    SELECT o.mirror_hash AS mirrorHash, o.seq, vec_distance_cosine(v.embedding, ?) AS distance,
      json_group_array(o.document_id) AS documentIds
    FROM vector_owners o
    JOIN (${eligible.sql}) e ON e.id = o.document_id AND e.mirror_hash = o.mirror_hash
    JOIN documents d ON d.id = o.document_id
    JOIN content_chunks c ON c.mirror_hash = o.mirror_hash AND c.seq = o.seq
    JOIN vector_variants v ON v.variant_id = o.variant_id AND v.partition_id = o.partition_id
    JOIN ${tableName} x ON x.variant_id = v.variant_id AND x.embedding = v.embedding
    WHERE ${conditions.join(" AND ")}
      AND (o.document_id || ':' || o.seq) IN (SELECT value FROM json_each(?))
    GROUP BY v.variant_id, o.mirror_hash, o.seq
    ORDER BY distance, o.mirror_hash, o.seq, v.variant_id LIMIT ?
  `)
    .all(
      encodeEmbedding(embedding),
      ...eligible.params,
      ...params,
      JSON.stringify(proven),
      k
    )
    .map((row) => ({
      mirrorHash: row.mirrorHash,
      seq: row.seq,
      distance: row.distance,
      documentIds: JSON.parse(row.documentIds) as number[],
    }));
}

const adapter = new SqliteAdapter();
let directory: string;
let db: Database;
let store: VectorVariantStore;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "variant-parity-"));
  const path = join(directory, "index.sqlite");
  expect((await adapter.open(path, "unicode61")).ok).toBe(true);
  expect(
    (
      await adapter.syncCollections(
        ["alpha", "beta"].map((name) => ({
          name,
          path: join(directory, name),
          pattern: "**/*",
          include: [],
          exclude: [],
        }))
      )
    ).ok
  ).toBe(true);
  const random = prng(216);
  for (let index = 0; index < 160; index++) {
    // Every seventh document shares one body, so owners share variants and
    // a title difference splits one mirror into several variants.
    const mirrorHash = `parity-${index % 7 === 0 ? 0 : index}`;
    const chunkCount = index % 7 === 0 ? 2 : 1 + (index % 3);
    const texts = Array.from(
      { length: chunkCount },
      (_, seq) => `body ${mirrorHash} chunk ${seq}`
    );
    const inserted = await adapter.upsertDocument({
      collection: index % 2 ? "alpha" : "beta",
      relPath: `doc-${index}.md`,
      sourceHash: `source-${index}`,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: 10,
      sourceMtime: "2026-09-01T00:00:00.000Z",
      title: index % 11 === 0 ? `skip ${index}` : `Title ${index % 5}`,
      mirrorHash,
      typedMetadata: { tier: index % 3 },
      ingestVersion: TYPED_METADATA_INGEST_VERSION,
    });
    if (!inserted.ok) throw new Error(inserted.error.message);
    expect((await adapter.upsertContent(mirrorHash, texts.join("\n"))).ok).toBe(
      true
    );
    expect(
      (
        await adapter.upsertChunks(
          mirrorHash,
          texts.map((text, seq) => ({
            seq,
            pos: seq,
            text,
            startLine: seq + 1,
            endLine: seq + 1,
            language: seq === 1 ? "de" : "en",
          }))
        )
      ).ok
    ).toBe(true);
  }
  db = new Database(path);
  const created = await createVectorIndexPort(db, {
    model: identity.model,
    dimensions: DIMENSIONS,
  });
  if (!created.ok) throw new Error(created.error.message);
  store = await createVectorVariantStore(db, identity);
  store.write(
    store
      .pending({ limit: 10_000 })
      .map((owner) => ({ owner, embedding: vector(random) }))
  );
  store.activate(store.epoch());
  // Rebinding a shared-body owner moves it to the end of its variant's owner
  // rows, so owner order is not simply ascending document ids.
  store.release(8);
  store.write(store.pending().map((owner) => ({ owner })));
  store.activate(store.epoch());
  // Retitled owners keep stale vectors; both implementations must skip them.
  db.run(
    "UPDATE documents SET title = 'Retitled' WHERE id IN (SELECT id FROM documents ORDER BY id LIMIT 12 OFFSET 30)"
  );
});

afterAll(async () => {
  db.close();
  await adapter.close();
  await safeRm(directory);
});

const cases: [string, VectorSearchOptions][] = [
  ["unscoped", {}],
  ["collection", { eligibility: { collection: "alpha" } }],
  [
    "metadata",
    { eligibility: { filter: { op: "eq", key: "tier", value: 1 } } },
  ],
  ["exclusion", { eligibility: { exclude: ["skip"] } }],
  ["language", { eligibility: { language: "de" } }],
];

test.each(cases)(
  "matches the filter-then-rank reference (%s)",
  (_label, options) => {
    const random = prng(7);
    for (let round = 0; round < 12; round++) {
      const query = vector(random);
      for (const k of [1, 5, 20, 500]) {
        const actual = searchVectorVariants(
          db,
          identity.model,
          DIMENSIONS,
          query,
          k,
          { ...options, partitionId: store.partitionId }
        );
        const expected = referenceSearch(
          db,
          store.partitionId,
          query,
          k,
          options
        );
        expect(expected.length).toBeGreaterThan(0);
        expect(actual).toEqual(expected);
      }
    }
  }
);

test("a disagreeing vec0 mirror never changes results and vec sync repairs it", () => {
  const query = vector(prng(99));
  const options = { partitionId: store.partitionId };
  const before = searchVectorVariants(
    db,
    identity.model,
    DIMENSIONS,
    query,
    20,
    options
  );
  db.run(
    `DELETE FROM ${store.tableName} WHERE variant_id IN (SELECT variant_id FROM ${store.tableName} LIMIT 3)`
  );
  expect(
    searchVectorVariants(db, identity.model, DIMENSIONS, query, 20, options)
  ).toEqual(before);
  expect(
    syncPartitionIndex(db, {
      partitionId: store.partitionId,
      dimensions: DIMENSIONS,
    })
  ).toEqual({ added: 3, removed: 0 });
});

test("a write from another connection invalidates cached input proofs", () => {
  const query = vector(prng(5));
  const options = { partitionId: store.partitionId };
  const search = () =>
    searchVectorVariants(db, identity.model, DIMENSIONS, query, 500, options);
  const owner = search()![0]!.documentIds![0]!;
  const other = new Database(db.filename);
  try {
    other.run("UPDATE documents SET title = 'Moved on' WHERE id = ?", [owner]);
  } finally {
    other.close();
  }
  expect(search()!.flatMap((row) => row.documentIds)).not.toContain(owner);
  expect(search()).toEqual(
    referenceSearch(db, store.partitionId, query, 500, {})
  );
});
