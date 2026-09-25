import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
// Bun has no temporary-directory creation API.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../../src/config/types";
import type { EmbeddingPort } from "../../../src/llm/types";

import { formatVectorPartitionLines } from "../../../src/core/vector-partition-status";
import {
  embedBacklog,
  prepareEmbeddingBacklog,
} from "../../../src/embed/backlog";
import { searchHybrid } from "../../../src/pipeline/hybrid";
import { migrations, runMigrations } from "../../../src/store/migrations";
import { SqliteAdapter } from "../../../src/store/sqlite/adapter";
import {
  embeddingPartitionIdentity,
  identityPartitionId,
  resolveRuntimePartition,
} from "../../../src/store/vector/runtime-compat";
import { createVectorIndexPort } from "../../../src/store/vector/sqlite-vec";
import { createVectorStatsPort } from "../../../src/store/vector/stats";
import {
  dropVectorPartition,
  listVectorPartitions,
  vectorRuntimeStatus,
} from "../../../src/store/vector/status";
import {
  resolveVectorSearchIdentity,
  VECTOR_RUNTIME_INCOMPATIBLE,
  vectorSearchUnavailableMessage,
} from "../../../src/store/vector/variant-search";
import { createVectorVariantStore } from "../../../src/store/vector/variants";
import { safeRm } from "../../helpers/cleanup";

const MODEL = "runtime-compat-model";
const DIMS = 4;
const stores: SqliteAdapter[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0)) await safeRm(directory);
});

function vectorFor(text: string, skew: number): number[] {
  const hash = new Bun.CryptoHasher("sha256").update(text).digest();
  const vector = Array.from({ length: DIMS }, (_, i) => hash[i]! / 255 + 0.1);
  // An incompatible runtime rotates the space: same input, different vector.
  if (skew) vector.reverse();
  return vector;
}

/** Deterministic port; `skew` simulates a runtime that is not measurably equal. */
function port(runtime: string, skew = 0, contextSize = 512) {
  const calls: string[] = [];
  const embedPort: EmbeddingPort = {
    modelUri: MODEL,
    init: async () => ({ ok: true, value: undefined }),
    dimensions: () => DIMS,
    getIdentity: () => ({
      contextSize,
      truncationPolicy: "truncate-tail-v1",
      modelFingerprint: "weights-v1",
      runtimeFingerprint: runtime,
      runtimeLabel: `${runtime} label`,
    }),
    embed: async (text) => {
      calls.push(text);
      return { ok: true, value: vectorFor(text, skew) };
    },
    embedBatch: async (texts) => {
      calls.push(...texts);
      return { ok: true, value: texts.map((text) => vectorFor(text, skew)) };
    },
    dispose: async () => {},
  };
  return { embedPort, calls };
}

async function addDocs(store: SqliteAdapter, from: number, to: number) {
  for (let i = from; i < to; i++) {
    const mirrorHash = `mirror-${i}`;
    const doc = await store.upsertDocument({
      collection: "notes",
      relPath: `note-${i}.md`,
      title: `Note ${i}`,
      mirrorHash,
      sourceHash: `source-${i}`,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: 20,
      sourceMtime: "2026-09-25T00:00:00Z",
    });
    if (!doc.ok) throw new Error(doc.error.message);
    await store.upsertContent(mirrorHash, `Body ${i}`);
    await store.upsertChunks(mirrorHash, [
      { seq: 0, pos: 0, text: `Chunk text ${i}`, startLine: 1, endLine: 1 },
    ]);
    const fts = await store.rebuildFtsForHash(mirrorHash);
    if (!fts.ok) throw new Error(fts.error.message);
  }
}

async function fixture(docs = 12) {
  const directory = await mkdtemp(join(tmpdir(), "gno-runtime-compat-"));
  directories.push(directory);
  const store = new SqliteAdapter();
  const opened = await store.open(join(directory, "index.sqlite"), "unicode61");
  if (!opened.ok) throw new Error(opened.error.message);
  stores.push(store);
  await store.syncCollections([
    {
      name: "notes",
      path: "/synthetic/notes",
      pattern: "**/*.md",
      include: [],
      exclude: [],
    },
  ]);
  await addDocs(store, 0, docs);
  const db = store.getRawDb();
  const index = await createVectorIndexPort(db, {
    model: MODEL,
    dimensions: DIMS,
  });
  if (!index.ok) throw new Error(index.error.message);
  const embed = async (
    embedPort: EmbeddingPort,
    allowNewPartition?: boolean
  ) => {
    const deps = {
      embedPort,
      statsPort: createVectorStatsPort(db),
      vectorIndex: index.value,
      modelUri: MODEL,
      allowNewPartition,
    };
    const prepared = await prepareEmbeddingBacklog(deps);
    if (!prepared.ok) return prepared;
    return embedBacklog(prepared.value);
  };
  const status = async () => {
    const result = await store.getStatus({ embedModel: MODEL });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
  return { store, db, index: index.value, embed, status };
}

const partitionIds = (db: ReturnType<SqliteAdapter["getRawDb"]>) =>
  db
    .query<{ partition_id: string }, []>(
      "SELECT partition_id FROM vector_partitions ORDER BY partition_id"
    )
    .all()
    .map((row) => row.partition_id);

test("runtime-only change resumes the backlog in the same partition", async () => {
  const f = await fixture();
  const a = port("runtime-a");
  expect((await f.embed(a.embedPort)).ok).toBe(true);
  const [partition] = partitionIds(f.db);
  expect(partition).toBe(
    identityPartitionId(embeddingPartitionIdentity(a.embedPort)!)
  );

  await addDocs(f.store, 12, 14);
  const b = port("runtime-b");
  const result = await f.embed(b.embedPort);
  expect(result.ok && result.value.embedded).toBe(2);
  expect(partitionIds(f.db)).toEqual([partition!]);
  // Only the 8-chunk sample plus the 2 new chunks were embedded under B.
  expect(b.calls).toHaveLength(10);
  expect(
    f.db
      .query("SELECT verdict FROM vector_runtime_verdicts WHERE runtime = ?")
      .get("runtime-b")
  ).toEqual({ verdict: "compatible" });
  expect((await f.status()).embeddingBacklog).toBe(0);
});

test("a verdict write failure re-measures next time and never forks", async () => {
  const f = await fixture();
  expect((await f.embed(port("runtime-a").embedPort)).ok).toBe(true);
  f.db
    .exec(`CREATE TRIGGER fail_verdicts BEFORE INSERT ON vector_runtime_verdicts
    BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
  const b = port("runtime-b");
  for (let run = 1; run <= 2; run++) {
    expect((await f.embed(b.embedPort)).ok).toBe(true);
    expect(b.calls).toHaveLength(8 * run);
  }
  expect(partitionIds(f.db)).toHaveLength(1);
});

test("an incompatible runtime is refused without explicit confirmation and queries go lexical", async () => {
  const f = await fixture();
  expect((await f.embed(port("runtime-a").embedPort)).ok).toBe(true);
  const c = port("runtime-c", 1);

  const refused = await f.embed(c.embedPort);
  expect(refused.ok).toBe(false);
  if (!refused.ok) {
    expect(refused.error.code).toBe("VECTOR_PARTITION_FORK");
    expect(refused.error.message).toContain("all 12 chunks");
    expect(refused.error.message).toContain("--new-partition");
  }
  expect(partitionIds(f.db)).toHaveLength(1);

  const search = await resolveVectorSearchIdentity(c.embedPort, f.index);
  expect(search.identity).toBeUndefined();
  expect(search.unavailable?.reason).toContain("does not reproduce");
  // vsearch cannot fall back, so it points at what does work.
  const vsearchMessage = vectorSearchUnavailableMessage(search.unavailable!);
  expect(vsearchMessage).toStartWith(
    "Vector search unavailable for this runtime"
  );
  expect(vsearchMessage).toContain("`gno query` or `gno search`");
  expect(vsearchMessage).toContain("--new-partition");
  expect(vsearchMessage).not.toContain("lexical retrieval only");
  expect(VECTOR_RUNTIME_INCOMPATIBLE).toBe("vector_runtime_incompatible");

  const forked = await f.embed(c.embedPort, true);
  expect(forked.ok && forked.value.embedded).toBe(12);
  expect(partitionIds(f.db)).toHaveLength(2);
  const [primary] = partitionIds(f.db).filter(
    (id) => id === identityPartitionId(embeddingPartitionIdentity(c.embedPort)!)
  );
  expect(
    listVectorPartitions(f.db, MODEL).find((p) => p.id === primary)
      ?.incompatibleRuntimes
  ).toEqual(["runtime-c label"]);
  // The confirmed partition now belongs to runtime C and is used by its queries.
  expect(
    (await resolveVectorSearchIdentity(c.embedPort, f.index)).identity?.fork
  ).toBe("runtime-c");

  // The fork names its reader.
  expect(
    listVectorPartitions(f.db, MODEL).find((p) => p.id !== primary)
      ?.compatibleRuntimes
  ).toEqual(["runtime-c label"]);

  // A Bun-only upgrade of C measures and reuses its fork instead of forking again.
  const upgraded = await f.embed(port("runtime-c-next-bun", 1).embedPort);
  expect(upgraded.ok && upgraded.value.embedded).toBe(0);
  expect(partitionIds(f.db)).toHaveLength(2);
});

test("a changed vector-defining identity needs confirmation before a new partition", async () => {
  const f = await fixture();
  expect((await f.embed(port("runtime-a").embedPort)).ok).toBe(true);
  const wider = port("runtime-a", 0, 1024);
  const refused = await f.embed(wider.embedPort);
  expect(!refused.ok && refused.error.message).toContain(
    "embedding identity changed"
  );
  // No compatibility sample ran, so the estimate is timed on current chunks.
  expect(!refused.ok && refused.error.message).toMatch(
    /estimated about \d+ s at the measured \d+ ms per chunk/
  );
  expect(partitionIds(f.db)).toHaveLength(1);
  const built = await f.embed(wider.embedPort, true);
  expect(built.ok && built.value.embedded).toBe(12);
});

/** Status must name exactly the partition this runtime's queries read. */
async function expectStatusMatchesRetrieval(
  f: Awaited<ReturnType<typeof fixture>>,
  embedPort: EmbeddingPort
) {
  const search = await resolveVectorSearchIdentity(embedPort, f.index);
  const runtime = vectorRuntimeStatus(f.db, MODEL);
  const partitions = listVectorPartitions(f.db, MODEL);
  const retrieval = partitions.filter((p) => p.retrieval).map((p) => p.id);
  if (search.identity) {
    expect(runtime).toMatchObject({ state: "vectors" });
    expect(retrieval).toEqual([identityPartitionId(search.identity)]);
    expect(runtime.partition).toBe(retrieval[0]!);
  } else {
    expect(runtime).toMatchObject({
      state: "unavailable",
      reason: search.unavailable!.reason,
    });
    expect(retrieval).toEqual([]);
  }
  return partitions;
}

test("status and drop follow the calling runtime's retrieval selection", async () => {
  const f = await fixture();
  const a = port("runtime-a");
  const c = port("runtime-c", 1);
  const wider = port("runtime-a", 0, 1024);
  expect((await f.embed(a.embedPort)).ok).toBe(true);
  await expectStatusMatchesRetrieval(f, a.embedPort);
  await expectStatusMatchesRetrieval(f, c.embedPort);
  expect((await f.embed(c.embedPort, true)).ok).toBe(true);
  expect((await f.embed(wider.embedPort, true)).ok).toBe(true);
  for (const embedPort of [c.embedPort, wider.embedPort, a.embedPort])
    await expectStatusMatchesRetrieval(f, embedPort);

  // An abandoned incomplete shadow (the incident case) next to them.
  const shadow = await createVectorVariantStore(f.db, {
    ...embeddingPartitionIdentity(a.embedPort)!,
    fork: "abandoned-runtime",
  });
  shadow.write(
    shadow.pending({ limit: 2 }).map((owner) => ({
      owner,
      embedding: new Float32Array(vectorFor(owner.formattedInput, 1)),
    }))
  );

  // As runtime A: the drop hint and the drop rule agree for every partition;
  // active partitions other runtimes read are never offered or dropped.
  const partitions = await expectStatusMatchesRetrieval(f, a.embedPort);
  expect(
    partitions.map((p) => [p.state, p.retrieval, p.droppable]).sort()
  ).toEqual([
    ["active", false, false],
    ["active", false, false],
    ["active", true, false],
    ["shadow", false, true],
  ]);
  const lines = formatVectorPartitionLines(partitions);
  for (const partition of partitions) {
    expect(
      lines.join("\n").includes(`gno vec drop ${partition.id.slice(0, 12)}`)
    ).toBe(partition.droppable);
    expect((await dropVectorPartition(f.db, partition.id)).ok).toBe(
      partition.droppable
    );
  }
  for (const embedPort of [a.embedPort, c.embedPort, wider.embedPort])
    await expectStatusMatchesRetrieval(f, embedPort);
});

test("a new reference runtime never reuses stale vectors of another runtime", async () => {
  const f = await fixture(1);
  expect((await f.embed(port("runtime-a").embedPort)).ok).toBe(true);
  f.db.run("UPDATE documents SET title = 'Renamed'");
  // No current owner can be sampled, so incompatible B becomes the reference.
  const b = port("runtime-b", 1);
  expect((await f.embed(b.embedPort)).ok).toBe(true);
  f.db.run("UPDATE documents SET title = 'Note 0'");
  const restored = await f.embed(b.embedPort);
  expect(restored.ok && restored.value.embedded).toBe(1);
  const row = f.db
    .query<{ input: string; embedding: Uint8Array }, []>(`
      SELECT c.text AS input, v.embedding FROM vector_owners o
      JOIN vector_variants v ON v.variant_id = o.variant_id
      JOIN content_chunks c ON c.mirror_hash = o.mirror_hash AND c.seq = o.seq
    `)
    .all();
  expect(row).toHaveLength(1);
  const stored = Array.from(new Float32Array(row[0]!.embedding.slice().buffer));
  // The restored input is embedded by B, not bound to A's old vector.
  expect(stored).toEqual(
    Array.from(new Float32Array(vectorFor(b.calls.at(-1)!, 1)))
  );
});

test("hybrid query from an incompatible runtime is lexical-only with a notice", async () => {
  const f = await fixture();
  expect((await f.embed(port("runtime-a").embedPort)).ok).toBe(true);
  const result = await searchHybrid(
    {
      store: f.store,
      config: {} as Config,
      vectorIndex: f.index,
      embedPort: port("runtime-c", 1).embedPort,
      expandPort: null,
      rerankPort: null,
    },
    "Body",
    { limit: 3, noExpand: true, noRerank: true }
  );
  if (!result.ok) throw new Error(result.error.message);
  expect(result.value.meta.mode).toBe("bm25_only");
  expect(result.value.results.length).toBeGreaterThan(0);
  expect(result.value.meta.warnings).toEqual([
    {
      code: VECTOR_RUNTIME_INCOMPATIBLE,
      message: expect.stringContaining("lexical retrieval only"),
    },
  ]);
});

test("an empty partition is unverified, not compatible", async () => {
  const f = await fixture();
  const a = port("runtime-a");
  const primary = embeddingPartitionIdentity(a.embedPort)!;
  await createVectorVariantStore(f.db, primary);
  const resolved = await resolveRuntimePartition(f.db, a.embedPort, primary);
  expect(resolved.verdict).toBe("unverified");
  expect(resolved.blocked).toBeUndefined();
  expect(
    f.db.query("SELECT count(*) AS n FROM vector_runtime_verdicts").get()
  ).toEqual({ n: 0 });
});

test("status reports the retrieval partition with a shadow present; dropping it restores status exactly", async () => {
  const f = await fixture();
  expect((await f.embed(port("runtime-a").embedPort)).ok).toBe(true);
  const before = await f.status();
  expect(before.vectorPartitions).toHaveLength(1);

  // An abandoned, incomplete shadow partition from another runtime.
  const shadow = await createVectorVariantStore(
    f.db,
    {
      ...embeddingPartitionIdentity(port("runtime-z").embedPort)!,
      fork: "runtime-z",
    },
    "CPU, Bun 1.3.14"
  );
  shadow.write(
    shadow.pending({ limit: 3 }).map((owner) => ({
      owner,
      embedding: new Float32Array(vectorFor(owner.formattedInput, 1)),
    }))
  );
  shadow.selectForEmbedding();

  const during = await f.status();
  expect(during.embeddingBacklog).toBe(before.embeddingBacklog);
  expect(during.collections).toEqual(before.collections);
  expect(
    during.vectorPartitions?.map(
      ({ state, retrieval, owners, provenance }) => ({
        state,
        retrieval,
        owners,
        provenance,
      })
    )
  ).toEqual(
    expect.arrayContaining([
      {
        state: "active",
        retrieval: true,
        owners: 12,
        provenance: "runtime-a label",
      },
      {
        state: "shadow",
        retrieval: false,
        owners: 3,
        provenance: "CPU, Bun 1.3.14",
      },
    ])
  );

  const retrieval = during.vectorPartitions!.find((p) => p.retrieval)!;
  expect(await dropVectorPartition(f.db, retrieval.id)).toEqual({
    ok: false,
    error: expect.stringContaining("Refusing to drop"),
  });
  expect(
    (await dropVectorPartition(f.db, shadow.partitionId.slice(0, 12))).ok
  ).toBe(true);
  expect(await f.status()).toEqual(before);
});

/** Pre-fn-184 partitions were keyed on weights plus runtime. */
async function legacyPartition(
  f: Awaited<ReturnType<typeof fixture>>,
  runtime: string,
  owners: number,
  activate: boolean
) {
  const store = await createVectorVariantStore(f.db, {
    ...embeddingPartitionIdentity(port(runtime).embedPort)!,
    modelFingerprint: `legacy-weights+${runtime}`,
  });
  store.write(
    store.pending({ limit: owners }).map((owner) => ({
      owner,
      embedding: new Float32Array(vectorFor(owner.formattedInput, 0)),
    }))
  );
  // Activated by pre-fn-184 code, which never superseded sibling partitions.
  if (activate) {
    store.syncIndex();
    f.db.run(
      "UPDATE vector_partitions SET state = 'active', activated_epoch = (SELECT epoch FROM vector_variant_epoch) WHERE partition_id = ?",
      [store.partitionId]
    );
  }
  f.db.run("UPDATE vector_partitions SET legacy = 1 WHERE partition_id = ?", [
    store.partitionId,
  ]);
  return store.partitionId;
}

test("migration re-keys the most complete compatible partition, survives a crash and is idempotent", async () => {
  const f = await fixture();
  const complete = await legacyPartition(f, "gpu-bun-a", 12, true);
  const partial = await legacyPartition(f, "cpu-bun-b", 5, false);
  const variantsBefore = f.db
    .query(
      "SELECT variant_id, input_hash, embedding FROM vector_variants WHERE partition_id = ? ORDER BY variant_id"
    )
    .all(complete);
  const runtime = port("cpu-bun-c");
  const primary = embeddingPartitionIdentity(runtime.embedPort)!;
  const newId = identityPartitionId(primary);

  f.db.exec(`CREATE TRIGGER crash BEFORE DELETE ON vector_partitions
    BEGIN SELECT RAISE(ABORT, 'simulated crash'); END`);
  await expect(
    resolveRuntimePartition(f.db, runtime.embedPort, primary)
  ).rejects.toThrow("simulated crash");
  expect(partitionIds(f.db)).toEqual([complete, partial].sort());
  expect(
    f.db
      .query("SELECT 1 FROM sqlite_master WHERE name = ?")
      .get(`vec_v1_${newId}`)
  ).toBeNull();
  f.db.exec("DROP TRIGGER crash");

  const resolved = await resolveRuntimePartition(
    f.db,
    runtime.embedPort,
    primary
  );
  expect(resolved.blocked).toBeUndefined();
  expect(resolved.verdict).toBe("compatible");
  expect(partitionIds(f.db)).toEqual([newId, partial].sort());
  expect(
    f.db
      .query(
        "SELECT variant_id, input_hash, embedding FROM vector_variants WHERE partition_id = ? ORDER BY variant_id"
      )
      .all(newId)
  ).toEqual(variantsBefore);
  expect(
    f.db
      .query(
        "SELECT state, legacy FROM vector_partitions WHERE partition_id = ?"
      )
      .all(partial)
  ).toEqual([{ state: "shadow", legacy: 1 }]);
  const callsAfterMigration = runtime.calls.length;

  expect(
    (await resolveRuntimePartition(f.db, runtime.embedPort, primary)).identity
  ).toEqual(primary);
  expect(runtime.calls).toHaveLength(callsAfterMigration);
  expect(partitionIds(f.db)).toEqual([newId, partial].sort());

  // No re-embedding: the backlog is empty and search reads the re-keyed vectors.
  const embedded = await f.embed(runtime.embedPort);
  expect(embedded.ok && embedded.value.embedded).toBe(0);
  expect(
    (await resolveVectorSearchIdentity(runtime.embedPort, f.index)).identity
  ).toEqual(primary);
});

test("before its re-key, an active legacy partition gets no drop hint and drop refuses it", async () => {
  const f = await fixture();
  const active = await legacyPartition(f, "gpu-bun-a", 12, true);
  const shadow = await legacyPartition(f, "cpu-bun-b", 4, false);
  // Upgraded index, no query or embed yet: nothing has been re-keyed.
  const status = await f.status();
  expect(status.vectorRuntime?.state).toBe("unresolved");
  const lines = formatVectorPartitionLines(
    status.vectorPartitions,
    status.vectorRuntime
  ).join("\n");
  expect(lines).not.toContain(`gno vec drop ${active.slice(0, 12)}`);
  expect(lines).toContain(`gno vec drop ${shadow.slice(0, 12)}`);
  const refused = await dropVectorPartition(f.db, active);
  expect(!refused.ok && refused.error).toContain("Refusing to drop active");
  expect(partitionIds(f.db)).toContain(active);
  expect((await dropVectorPartition(f.db, shadow)).ok).toBe(true);
});

test("migration prefers current coverage over an earlier activation", async () => {
  const f = await fixture();
  const shrunk = await legacyPartition(f, "gpu-bun-a", 12, true);
  f.db.run(
    "DELETE FROM vector_owners WHERE partition_id = ? AND document_id > 2",
    [shrunk]
  );
  const complete = await legacyPartition(f, "cpu-bun-b", 12, false);
  const runtime = port("cpu-bun-c");
  const primary = embeddingPartitionIdentity(runtime.embedPort)!;
  expect(
    (await resolveRuntimePartition(f.db, runtime.embedPort, primary)).verdict
  ).toBe("compatible");
  expect(partitionIds(f.db)).toEqual(
    [identityPartitionId(primary), shrunk].sort()
  );
  expect(partitionIds(f.db)).not.toContain(complete);
});

test("an ambiguous migration keeps every partition and reports it", async () => {
  const f = await fixture();
  const first = await legacyPartition(f, "bun-a", 12, true);
  const second = await legacyPartition(f, "bun-b", 12, true);
  const runtime = port("bun-c");
  const primary = embeddingPartitionIdentity(runtime.embedPort)!;

  const resolved = await resolveRuntimePartition(
    f.db,
    runtime.embedPort,
    primary
  );
  expect(resolved.blocked?.reason).toContain("ambiguous migration");
  expect(partitionIds(f.db)).toEqual([first, second].sort());
  const refused = await f.embed(runtime.embedPort);
  expect(!refused.ok && refused.error.code).toBe("VECTOR_PARTITION_FORK");
  // Recovery without deleting active vectors: both stay protected until a
  // confirmed runtime-independent partition activates and supersedes them.
  for (const id of [first, second])
    expect((await dropVectorPartition(f.db, id)).ok).toBe(false);
  const rebuilt = await f.embed(runtime.embedPort, true);
  expect(rebuilt.ok && rebuilt.value.embedded).toBe(12);
  const partitions = listVectorPartitions(f.db, MODEL);
  expect(
    partitions.filter((p) => p.legacy).map((p) => [p.state, p.droppable])
  ).toEqual([
    ["shadow", true],
    ["shadow", true],
  ]);
  for (const id of [first, second])
    expect((await dropVectorPartition(f.db, id)).ok).toBe(true);
  expect(partitionIds(f.db)).toEqual([identityPartitionId(primary)]);
});

test("an index already at schema 31 gains the runtime caller table", () => {
  const db = new Database(":memory:");
  try {
    expect(runMigrations(db, migrations.slice(0, 31), "unicode61").ok).toBe(
      true
    );
    const upgraded = runMigrations(db, migrations, "unicode61");
    expect(upgraded.ok && upgraded.value.applied).toEqual([32]);
    expect(vectorRuntimeStatus(db, MODEL)).toEqual({
      label: null,
      state: "unresolved",
      partition: null,
    });
  } finally {
    db.close();
  }
});
