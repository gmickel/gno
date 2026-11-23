/**
 * Vector garbage collection benchmark (opt-in; not part of `bun test`).
 *
 * Builds a synthetic index with real migrations, embeds every chunk with
 * seeded vectors (no models run), then times:
 *   - the automatic end-of-embed-pass check when nothing is queued, and
 *     when many candidates are queued but none is past the grace period,
 *   - deactivating documents (sync's path, which feeds the candidate queue),
 *   - one automatic pass (default count and time budget) over N queued
 *     variants, and the passes needed to drain them,
 *   - an explicit `gno vec gc` traversal (dry run and real) of the index.
 *
 * Usage:
 *   bun run bench:vector-gc                                  # 20k chunks x 384d, collect 2k docs
 *   bun run bench:vector-gc -- --chunks 100000 --dims 768 --collect 5000
 */

// node:fs/promises for mkdtemp (filesystem structure op)
import { mkdtemp } from "node:fs/promises";
// node:os provides the temporary root
import { tmpdir } from "node:os";
// node:path has no Bun path utilities
import { join } from "node:path";

import { SqliteAdapter } from "../src/store/sqlite/adapter";
import {
  AUTO_VECTOR_GC_GRACE_SECONDS,
  collectQueuedGarbage,
  hasQueuedGarbage,
  runVectorGc,
} from "../src/store/vector/garbage";
import { createVectorVariantStore } from "../src/store/vector/variants";
import { safeRm } from "../test/helpers/cleanup";

const CHUNKS_PER_DOC = 4;
const PROBES = 2000;

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

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

const ms = (start: number): string => (performance.now() - start).toFixed(1);

async function main(): Promise<void> {
  const chunks = Number(flag("--chunks", "20000"));
  const dimensions = Number(flag("--dims", "384"));
  const collectDocs = Number(flag("--collect", "2000"));
  const root = await mkdtemp(join(tmpdir(), "gno-vector-gc-bench-"));
  const adapter = new SqliteAdapter();
  try {
    const opened = await adapter.open(join(root, "index.sqlite"), "unicode61");
    if (!opened.ok) throw new Error(opened.error.message);
    const synced = await adapter.syncCollections([
      {
        name: "notes",
        path: join(root, "notes"),
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ]);
    if (!synced.ok) throw new Error(synced.error.message);
    const documents = Math.ceil(chunks / CHUNKS_PER_DOC);
    let started = performance.now();
    for (let index = 0; index < documents; index++) {
      const mirrorHash = `bench-${index}`;
      const texts = Array.from(
        { length: CHUNKS_PER_DOC },
        (_, seq) => `synthetic body ${index} chunk ${seq}`
      );
      const inserted = await adapter.upsertDocument({
        collection: "notes",
        relPath: `doc-${index}.md`,
        sourceHash: `source-${index}`,
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: 100,
        sourceMtime: "2026-01-01T00:00:00.000Z",
        title: `Document ${index}`,
        mirrorHash,
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
    const partition = { partitionId: store.partitionId, model: "bench-model" };
    console.log(
      `built ${documents} documents / ${documents * CHUNKS_PER_DOC} chunks x ${dimensions}d in ${(
        (performance.now() - started) /
        1000
      ).toFixed(1)} s`
    );

    // 1. Nothing queued: the end-of-pass probe.
    const probes: number[] = [];
    for (let i = 0; i < PROBES; i++) {
      const t = performance.now();
      hasQueuedGarbage(db, partition.partitionId);
      probes.push(performance.now() - t);
    }
    probes.sort((a, b) => a - b);
    started = performance.now();
    const empty = collectQueuedGarbage(db, partition, { vecLoaded: true });
    console.log(
      `nothing queued: probe p50 ${(probes[PROBES / 2]! * 1000).toFixed(1)} us, p99 ${(probes[Math.floor(PROBES * 0.99)]! * 1000).toFixed(1)} us; collect call ${ms(started)} ms (examined ${empty.examined})`
    );
    started = performance.now();
    const fullDry = runVectorGc(db, { dryRun: true, vecLoaded: true });
    console.log(
      `for comparison, full traversal dry run with nothing to collect: ${ms(started)} ms over ${fullDry.partitions[0]?.examined ?? 0} variants`
    );

    // 2. Deactivate documents through the store (sync's markInactive path).
    const paths = Array.from(
      { length: Math.min(collectDocs, documents) },
      (_, i) => `doc-${i}.md`
    );
    started = performance.now();
    const marked = await adapter.markInactive("notes", paths);
    if (!marked.ok) throw new Error(marked.error.message);
    const queued = db
      .query<{ n: number }, []>(
        "SELECT count(*) AS n FROM vector_gc_candidates"
      )
      .get()!.n;
    console.log(
      `markInactive ${marked.value} documents: ${ms(started)} ms (queued ${queued} candidates)`
    );

    // 3. Everything queued, nothing past the grace yet: the common state
    // after a sync. The end-of-pass check must stay one lookup.
    const dueAt = Math.floor(Date.now() / 1000) - AUTO_VECTOR_GC_GRACE_SECONDS;
    const pending: number[] = [];
    for (let i = 0; i < PROBES; i++) {
      const t = performance.now();
      hasQueuedGarbage(db, partition.partitionId, dueAt);
      pending.push(performance.now() - t);
    }
    pending.sort((a, b) => a - b);
    console.log(
      `${queued} queued, none past the grace: probe p50 ${(pending[PROBES / 2]! * 1000).toFixed(1)} us, p99 ${(pending[Math.floor(PROBES * 0.99)]! * 1000).toFixed(1)} us`
    );

    // 4. One automatic pass with the default budget once the grace has
    // passed (simulated by ageing the queue), then drain.
    db.run("UPDATE vector_gc_candidates SET queued_at = queued_at - ?", [
      AUTO_VECTOR_GC_GRACE_SECONDS + 1,
    ]);
    started = performance.now();
    const first = collectQueuedGarbage(db, partition, { vecLoaded: true });
    console.log(
      `automatic pass (default budget): ${ms(started)} ms, removed ${first.variants} variants (${(first.bytes / 1024 / 1024).toFixed(1)} MiB), remaining=${first.remaining}`
    );
    let passes = 1;
    let removed = first.variants;
    started = performance.now();
    while (hasQueuedGarbage(db, partition.partitionId)) {
      removed += collectQueuedGarbage(db, partition, {
        vecLoaded: true,
      }).variants;
      passes += 1;
    }
    console.log(
      `drained ${removed} variants in ${passes} passes (${ms(started)} ms after the first)`
    );
    console.log(`mirror after collection: ${store.mirrorState()}`);

    // 5. Explicit traversal after deactivating another slice (no grace).
    const more = Array.from(
      { length: Math.min(collectDocs, documents - paths.length) },
      (_, i) => `doc-${paths.length + i}.md`
    );
    if (more.length > 0) {
      const again = await adapter.markInactive("notes", more);
      if (!again.ok) throw new Error(again.error.message);
    }
    started = performance.now();
    const dry = runVectorGc(db, { dryRun: true, vecLoaded: true });
    console.log(
      `vec gc --dry-run: ${ms(started)} ms, ${dry.variants} collectible of ${dry.partitions[0]?.examined ?? 0}`
    );
    started = performance.now();
    const real = runVectorGc(db, { dryRun: false, vecLoaded: true });
    console.log(
      `vec gc: ${ms(started)} ms, removed ${real.variants} (${(real.bytes / 1024 / 1024).toFixed(1)} MiB); file ${(real.databaseBytes / 1024 / 1024).toFixed(1)} MiB, free ${(real.freeBytes / 1024 / 1024).toFixed(1)} MiB`
    );
  } finally {
    await adapter.close();
    await safeRm(root);
  }
}

await main();
