/** Offline deterministic eligibility gate. Synthetic fixed vectors, never native model quality. */
import { Database } from "bun:sqlite";
// Bun has no temporary-directory creation/path/recursive-directory-removal APIs.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  MetadataPredicate,
  TypedMetadata,
} from "../../src/core/typed-metadata";
import type { StoreResult } from "../../src/store/types";

import {
  matchesMetadataPredicate,
  normalizeMetadataPredicate,
} from "../../src/core/typed-metadata";
import { extractTypedMetadata } from "../../src/ingestion/typed-metadata";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { buildEligibleDocumentQuery } from "../../src/store/sqlite/eligibility";
import { createVectorIndexPort } from "../../src/store/vector/sqlite-vec";

function unwrap<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
const hash = (text: string) =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");
const fixturePath = new URL(
  "../fixtures/typed-metadata/cases.json",
  import.meta.url
);
const fixtureText = await Bun.file(fixturePath).text();
const manifest = await Bun.file(
  new URL("../fixtures/typed-metadata/manifest.json", import.meta.url)
).json();
if (hash(fixtureText) !== manifest.sha256)
  throw new Error("Fixture pin mismatch");
const fixture = JSON.parse(fixtureText) as {
  sizes: number[];
  repetitions: number;
  limit: number;
  query: string;
  embedding: number[];
  thresholds: Record<string, number>;
  predicates: MetadataPredicate[];
};
const predicates = fixture.predicates.map(normalizeMetadataPredicate);
const negativeControl = Bun.argv.includes("--negative-control");
const outputFlag = Bun.argv.indexOf("--output");
if (outputFlag < 0 || !Bun.argv[outputFlag + 1])
  throw new Error("Use --output <new-report.json> [--negative-control]");
const outputPath = Bun.argv[outputFlag + 1]!;
if (await Bun.file(outputPath).exists())
  throw new Error("Refusing to overwrite report");
const failures: string[] = [];
const measurements: unknown[] = [];
function same(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(label);
}
function metadata(index: number, count: number): TypedMetadata {
  return {
    approved: index === count - 1,
    score: index % 3 === 0 ? String(index % 100) : index % 100,
    labels: index % 5 === 0 ? ["release", "public"] : ["private"],
  };
}
function timing(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50Ms: sorted[Math.floor(sorted.length / 2)],
    maxMs: sorted.at(-1),
    samplesMs: samples,
  };
}
for (const count of fixture.sizes) {
  const directory = await mkdtemp(join(tmpdir(), "gno-metadata-eval-"));
  const adapter = new SqliteAdapter();
  let db: Database | undefined;
  try {
    const path = join(directory, "index.sqlite");
    unwrap(await adapter.open(path, "unicode61"));
    unwrap(
      await adapter.syncCollections(
        ["notes", "outside"].map((name) => ({
          name,
          path: directory,
          pattern: "**/*",
          include: [],
          exclude: [],
        }))
      )
    );
    db = new Database(path);
    const vectorIndex = unwrap(
      await createVectorIndexPort(db, {
        model: "metadata-fixed-v1",
        dimensions: 2,
      })
    );
    if (!vectorIndex.searchAvailable)
      throw new Error("Real sqlite-vec is required for this gate");
    const rows: {
      id: number;
      hash: string;
      metadata: TypedMetadata;
      collection: string;
    }[] = [];
    const extractionStarted = performance.now();
    const extractionRssBefore = process.memoryUsage.rss();
    for (let index = 0; index < count; index++) {
      const expected = metadata(index, count);
      const extracted = extractTypedMetadata(
        `---\ngno:\n  metadata: ${JSON.stringify(expected)}\n---\nneedle`
      );
      same(extracted.typedMetadata, expected, `extraction:${count}:${index}`);
    }
    const extraction = {
      elapsedMs: performance.now() - extractionStarted,
      rssBeforeBytes: extractionRssBefore,
      rssAfterBytes: process.memoryUsage.rss(),
    };
    const setupStarted = performance.now();
    for (let index = 0; index < count; index++) {
      const text = `needle evidence ${String(index).padStart(6, "0")}`;
      const mirrorHash = hash(text);
      const fields = metadata(index, count);
      const collection = index % 10 === 0 ? "outside" : "notes";
      const inserted = unwrap(
        await adapter.upsertDocument({
          collection,
          relPath: `${index}.md`,
          sourceHash: mirrorHash,
          sourceMime: "text/markdown",
          sourceExt: ".md",
          sourceSize: text.length,
          sourceMtime: "2026-09-01T00:00:00Z",
          mirrorHash,
          ingestVersion: 7,
          typedMetadata: fields,
        })
      );
      unwrap(await adapter.upsertContent(mirrorHash, text));
      unwrap(
        await adapter.upsertChunks(mirrorHash, [
          { seq: 0, pos: 0, text, startLine: 1, endLine: 1, language: "en" },
        ])
      );
      unwrap(await adapter.rebuildFtsForHash(mirrorHash));
      unwrap(
        await vectorIndex.upsertVectors([
          {
            mirrorHash,
            seq: 0,
            model: vectorIndex.model,
            embedFingerprint: "fixed-v1",
            embedding: new Float32Array([1 - index / count, index / count]),
          },
        ])
      );
      rows.push({
        id: inserted.id,
        hash: mirrorHash,
        metadata: fields,
        collection,
      });
    }
    const setupMs = performance.now() - setupStarted;
    // Membership oracle is deliberately exhaustive only inside this bounded offline eval.
    for (const predicate of predicates) {
      const eligible = buildEligibleDocumentQuery(
        { collection: "notes", filter: predicate },
        db
      );
      const actual = db
        .query<{ id: number }, (string | number)[]>(eligible.sql)
        .all(...eligible.params)
        .map((row) => row.id)
        .sort((a, b) => a - b);
      const expected = rows
        .filter(
          (row) =>
            row.collection === "notes" &&
            matchesMetadataPredicate(row.metadata, predicate)
        )
        .map((row) => row.id);
      same(
        actual,
        expected,
        `membership:${count}:${JSON.stringify(predicate)}`
      );
    }
    const selective = predicates[0]!;
    const queryVector = new Float32Array(fixture.embedding);
    const expectedHash = rows.at(-1)!.hash;
    const beforeFts = unwrap(
      await adapter.searchFts(fixture.query, {
        limit: fixture.limit,
        collection: "notes",
      })
    );
    const beforeVec = unwrap(
      await vectorIndex.searchNearest(queryVector, fixture.limit, {
        eligibility: { collection: "notes" },
      })
    );
    const times = {
      lexical: { filtered: [] as number[], unfiltered: [] as number[] },
      vector: { filtered: [] as number[], unfiltered: [] as number[] },
    };
    const queryRssBefore = process.memoryUsage.rss();
    for (let repeat = 0; repeat < fixture.repetitions; repeat++) {
      for (const filtered of [false, true]) {
        const eligibility = {
          collection: "notes",
          ...(filtered ? { filter: selective } : {}),
        };
        let start = performance.now();
        const lexical = unwrap(
          await adapter.searchFts(fixture.query, {
            limit: fixture.limit,
            ...eligibility,
          })
        );
        times.lexical[filtered ? "filtered" : "unfiltered"].push(
          performance.now() - start
        );
        start = performance.now();
        const vector = unwrap(
          await vectorIndex.searchNearest(queryVector, fixture.limit, {
            eligibility,
          })
        );
        times.vector[filtered ? "filtered" : "unfiltered"].push(
          performance.now() - start
        );
        if (filtered) {
          same(
            lexical.map((hit) => hit.mirrorHash),
            [expectedHash],
            `lexical-topK:${count}:${repeat}`
          );
          same(
            vector.map((hit) => hit.mirrorHash),
            [expectedHash],
            `vector-topK:${count}:${repeat}`
          );
        } else {
          same(lexical, beforeFts, `lexical-unfiltered:${count}:${repeat}`);
          same(vector, beforeVec, `vector-unfiltered:${count}:${repeat}`);
        }
      }
    }
    if (negativeControl)
      same(
        beforeVec.map((hit) => hit.mirrorHash),
        [expectedHash],
        `negative-control-unfiltered-is-not-selective:${count}`
      );
    const queryPlan = buildEligibleDocumentQuery(
      { collection: "notes", filter: selective },
      db
    );
    measurements.push({
      count,
      extraction,
      setupMs,
      queryRssBeforeBytes: queryRssBefore,
      queryRssAfterBytes: process.memoryUsage.rss(),
      lexical: {
        filtered: timing(times.lexical.filtered),
        unfiltered: timing(times.lexical.unfiltered),
      },
      vector: {
        filtered: timing(times.vector.filtered),
        unfiltered: timing(times.vector.unfiltered),
      },
      eligibilityPlan: db
        .query(`EXPLAIN QUERY PLAN ${queryPlan.sql}`)
        .all(...queryPlan.params),
    });
  } finally {
    db?.close();
    await adapter.close();
    await rm(directory, { recursive: true, force: true });
  }
}
await Bun.write(
  outputPath,
  JSON.stringify(
    {
      kind: "deterministic-fixed-vector",
      nativeModelQuality: "not-evaluated",
      passed: failures.length === 0,
      negativeControl,
      fixtureSha256: manifest.sha256,
      harnessSha256: hash(await Bun.file(import.meta.path).text()),
      runtime: {
        bun: Bun.version,
        platform: process.platform,
        arch: process.arch,
      },
      thresholds: fixture.thresholds,
      failures,
      measurements,
      notes: [
        "Latency is descriptive, not a percentile SLO; seven samples share one process.",
        "RSS snapshots are process-wide and are not peak or attributable allocation measurements.",
        "Corpus ingestion/setup time is separate from extraction and retrieval.",
      ],
    },
    null,
    2
  )
);
process.exitCode = failures.length ? 1 : 0;
