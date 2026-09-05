import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";

import { rrfFuse, toRankedInput } from "../../src/pipeline/fusion";
import { DEFAULT_PIPELINE_CONFIG } from "../../src/pipeline/types";
import { migration } from "../../src/store/migrations/028-vector-variants";
import { createVectorIndexPort } from "../../src/store/vector/sqlite-vec";
import { createVectorVariantStore } from "../../src/store/vector/variants";

const identity = {
  model: "owner-test",
  modelFingerprint: "actual-weights",
  contextSize: 512,
  truncationPolicy: "tail-v1",
  dimensions: 2,
};
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
async function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE documents(id INTEGER PRIMARY KEY, mirror_hash TEXT, title TEXT, active INTEGER, collection TEXT);
    CREATE TABLE content_chunks(mirror_hash TEXT, seq INTEGER, text TEXT, language TEXT, PRIMARY KEY(mirror_hash,seq));
    CREATE TABLE content_vectors(mirror_hash TEXT, seq INTEGER, model TEXT, embed_fingerprint TEXT, embedding BLOB, embedded_at TEXT, PRIMARY KEY(mirror_hash,seq,model));
    CREATE TABLE doc_tags(document_id INTEGER, tag TEXT);
    INSERT INTO documents VALUES (1,'body','Alpha',1,'notes'),(2,'body','Beta',1,'notes'),(3,'body','Alpha',1,'other');
    INSERT INTO content_chunks VALUES ('body',0,'Shared body','en');
    INSERT INTO doc_tags VALUES (2,'beta');`);
  migration.up(db, "unicode61");
  const created = await createVectorIndexPort(db, {
    model: identity.model,
    dimensions: 2,
  });
  if (!created.ok) throw new Error(created.error.message);
  const index = created.value;
  await index.upsertVectors([
    {
      mirrorHash: "body",
      seq: 0,
      model: identity.model,
      embedFingerprint: "legacy",
      embedding: new Float32Array([1, 0]),
    },
  ]);
  const variants = await createVectorVariantStore(db, identity);
  const fill = () =>
    variants.write(
      variants
        .pending()
        .map((owner) => ({
          owner,
          embedding: new Float32Array(
            owner.formattedInput.includes("Beta") ? [0, 1] : [1, 0]
          ),
        }))
    );
  const search = (options = {}) =>
    index.searchNearest(new Float32Array([1, 0]), 1, {
      embeddingIdentity: identity,
      ...options,
    });
  return { db, index, variants, fill, search };
}

test("Alpha/Beta owners and filters precede K; deletion matches clean current rebuild", async () => {
  const f = await fixture();
  f.fill();
  f.variants.activate(f.variants.epoch());
  expect(await f.search()).toMatchObject({
    ok: true,
    value: [{ mirrorHash: "body", seq: 0, distance: 0, documentIds: [1, 3] }],
  });
  expect(await f.search({ eligibility: { tagsAll: ["beta"] } })).toMatchObject({
    ok: true,
    value: [{ documentIds: [2], distance: 1 }],
  });
  expect(
    await f.search({ eligibility: { collection: "notes" } })
  ).toMatchObject({ ok: true, value: [{ documentIds: [1] }] });
  expect(await f.search({ allowedMirrorHashes: [] })).toEqual({
    ok: true,
    value: [],
  });
  f.db.run("UPDATE documents SET active = 0 WHERE id = 1");
  expect(f.variants.isActive()).toBe(false);
  expect(await f.search()).toMatchObject({
    ok: true,
    value: [{ documentIds: [3] }],
  });
  const clean = await fixture();
  clean.db.run("UPDATE documents SET active = 0 WHERE id = 1");
  clean.fill();
  clean.variants.activate(clean.variants.epoch());
  expect(await f.search()).toEqual(await clean.search());
});

test("shadow retains legacy; promotion never falls back on identity loss, partition change or index loss", async () => {
  const f = await fixture();
  expect(await f.search()).toMatchObject({
    ok: true,
    value: [{ mirrorHash: "body" }],
  });
  f.variants.write([
    { owner: f.variants.pending()[0]!, embedding: new Float32Array([1, 0]) },
  ]);
  expect(await f.search()).toMatchObject({
    ok: true,
    value: [{ mirrorHash: "body" }],
  });
  f.fill();
  f.variants.activate(f.variants.epoch());
  expect((await f.index.searchNearest(new Float32Array([1, 0]), 1)).ok).toBe(
    false
  );
  expect(
    (await f.search({ embeddingIdentity: { ...identity, contextSize: 1024 } }))
      .ok
  ).toBe(false);
  f.db.run("UPDATE documents SET title = 'Gamma' WHERE id IN (1,3)");
  expect(await f.search()).toMatchObject({
    ok: true,
    value: [{ documentIds: [2] }],
  });
  f.db.exec(`DROP TABLE ${f.variants.tableName}`);
  expect((await f.search()).ok).toBe(false);
  const reopened = await createVectorVariantStore(f.db, identity);
  expect(reopened.hasActivated()).toBe(true);
  expect((await f.search()).ok).toBe(false);
});

test("variant ranks remain separate per owner through RRF", () => {
  const fused = rrfFuse(
    [
      toRankedInput("vector", [
        { mirrorHash: "body", seq: 0, documentIds: [1, 3] },
        { mirrorHash: "body", seq: 0, documentIds: [2] },
      ]),
    ],
    DEFAULT_PIPELINE_CONFIG.rrf
  );
  expect(fused.map((c) => [c.documentId, c.vecRank])).toEqual([
    [1, 1],
    [3, 1],
    [2, 2],
  ]);
  expect(fused[0]!.fusionScore).toBe(fused[1]!.fusionScore);
  expect(fused[0]!.fusionScore).toBeGreaterThan(fused[2]!.fusionScore);
});
