import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
// Bun has no directory-creation or OS/path equivalents.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AcceptanceManifest } from "../../evals/acceptance/manifest";
import type { AcceptanceRecord } from "../../evals/acceptance/records";
import type { Config } from "../../src/config/types";
import type { EmbeddingPort } from "../../src/llm/types";
import type { SearchOptions } from "../../src/pipeline/types";
import type { ChunkRow } from "../../src/store/types";
import type { VectorIndexPort } from "../../src/store/vector/types";

import { compareAcceptance } from "../../evals/acceptance/compare";
import { acceptanceManifestFingerprint } from "../../evals/acceptance/manifest";
import { hydrationLongDocument } from "../../evals/fixtures/acceptance/hydration-long-doc/fixture";
import pin from "../../evals/fixtures/acceptance/hydration-long-doc/manifest.json";
import { searchBm25 } from "../../src/pipeline/search";
import { searchVectorWithEmbedding } from "../../src/pipeline/vsearch";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { ok } from "../../src/store/types";
import { safeRm } from "../helpers/cleanup";

const adapter = new SqliteAdapter();
const fixture = hydrationLongDocument();
const hash = fixture.chunks[0]!.mirrorHash;
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "targeted-chunks-"));
  expect(
    (await adapter.open(join(directory, "index.sqlite"), "unicode61")).ok
  ).toBe(true);
  expect(
    (
      await adapter.syncCollections([
        {
          name: "notes",
          path: directory,
          pattern: "**/*",
          include: [],
          exclude: [],
        },
      ])
    ).ok
  ).toBe(true);
  expect((await adapter.upsertContent(hash, fixture.content)).ok).toBe(true);
  expect(
    (
      await adapter.upsertChunks(
        hash,
        fixture.chunks.map((chunk) => ({
          ...chunk,
          language: chunk.language ?? undefined,
          tokenCount: chunk.tokenCount ?? undefined,
        }))
      )
    ).ok
  ).toBe(true);
  expect(
    (
      await adapter.upsertDocument({
        collection: "notes",
        relPath: "long.md",
        sourceHash: "synthetic",
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: fixture.content.length,
        sourceMtime: "2026-09-05T00:00:00.000Z",
        mirrorHash: hash,
        title: "Long document",
      })
    ).ok
  ).toBe(true);
  expect((await adapter.rebuildFtsForHash(hash)).ok).toBe(true);
});

afterAll(async () => {
  await adapter.close();
  if (directory) await safeRm(directory);
});

function manifest(role: "baseline" | "candidate"): AcceptanceManifest {
  return {
    schemaVersion: "gno-acceptance-v1",
    role,
    identity: {
      commit: "0".repeat(40),
      indexId: "synthetic-targeted-chunks",
      indexSha256: pin.sha256,
      bunVersion: Bun.version,
      nativeDependencies: {},
      platform: process.platform,
      architecture: process.arch,
    },
    fixtureVersion: pin.version,
    fixtures: [
      { path: "hydration-long-doc/generated.json", sha256: pin.sha256 },
    ],
    models: [],
    cases: [
      {
        caseId: "long-doc",
        fixtureSha256: pin.sha256,
        surface: "sdk",
        preset: "unit",
        configuration: {},
      },
    ],
    intendedDeltas: [],
  };
}

function record(
  role: "baseline" | "candidate",
  output: unknown
): AcceptanceRecord {
  return {
    schemaVersion: "gno-acceptance-v1",
    manifestSha256: acceptanceManifestFingerprint(manifest(role)),
    caseId: "long-doc",
    deterministic: {
      scope: { completeOutput: JSON.parse(JSON.stringify(output)) },
      results: [],
      citations: [],
      modelInputs: [],
      semanticState: {
        status: "ok",
        vectorsUsed: false,
        vectorStatus: "not-requested",
        error: null,
        fallbacks: [],
        verification: null,
      },
    },
    generatedAnswer: null,
    transport: {},
  };
}

async function capture(
  targeted: boolean,
  vector: boolean,
  options: SearchOptions = {}
) {
  const counts = { calls: 0, rows: 0, characters: 0 };
  const measure = (rows: Map<string, ChunkRow[]>) => {
    counts.calls++;
    for (const chunks of rows.values())
      for (const chunk of chunks) {
        counts.rows++;
        counts.characters += chunk.text.length;
      }
  };
  const store = new Proxy(adapter, {
    get(target, property) {
      if (property === "getChunksBySequenceBatch")
        return targeted
          ? async (keys: { mirrorHash: string; seq: number }[]) => {
              const result = await target.getChunksBySequenceBatch(keys);
              if (result.ok) measure(result.value);
              return result;
            }
          : undefined;
      if (property === "getChunksBatch")
        return async (hashes: string[]) => {
          const result = await target.getChunksBatch(hashes);
          if (result.ok) measure(result.value);
          return result;
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const vectorIndex = {
    searchAvailable: true,
    searchNearest: async () =>
      ok([{ mirrorHash: hash, seq: 777, distance: 0.1 }]),
  } as unknown as VectorIndexPort;
  const output = vector
    ? await searchVectorWithEmbedding(
        {
          store,
          vectorIndex,
          embedPort: {} as EmbeddingPort,
          config: {} as Config,
        },
        "needle",
        new Float32Array([1]),
        { limit: 1, ...options }
      )
    : await searchBm25(store, "needle", { limit: 1, ...options });
  expect(output.ok).toBe(true);
  return { output, counts };
}

test("frozen 1000-chunk fixture: exact paired lexical/vector output with only the selected row hydrated", async () => {
  expect(
    new Bun.CryptoHasher("sha256").update(JSON.stringify(fixture)).digest("hex")
  ).toBe(pin.sha256);
  for (const vector of [false, true]) {
    const baseline = await capture(false, vector);
    const candidate = await capture(true, vector);
    expect(
      compareAcceptance(
        manifest("baseline"),
        manifest("candidate"),
        [record("baseline", baseline.output)],
        [record("candidate", candidate.output)]
      ).passed
    ).toBe(true);
    expect(candidate.output).toEqual(baseline.output);
    expect(baseline.counts).toEqual({
      calls: 1,
      rows: 1000,
      characters: fixture.chunks.reduce(
        (sum, chunk) => sum + chunk.text.length,
        0
      ),
    });
    expect(candidate.counts).toEqual({
      calls: 1,
      rows: 1,
      characters: fixture.chunks[vector ? 777 : 0]!.text.length,
    });
  }
});

test("intent and document-wide exclusions retain whole-document selection; full output retains content", async () => {
  for (const vector of [false, true])
    for (const options of [
      { intent: "needle evidence" },
      { exclude: ["absent-phrase"] },
      { exclude: ["needle evidence"] },
      { full: true },
    ]) {
      const baseline = await capture(false, vector, options);
      const candidate = await capture(true, vector, options);
      expect(candidate.output).toEqual(baseline.output);
      expect(candidate.counts.rows).toBe(
        options.full
          ? 1
          : !vector && options.exclude?.[0] === "needle evidence"
            ? 0
            : 1000
      );
      if (options.exclude?.[0] === "needle evidence" && candidate.output.ok)
        expect(candidate.output.value.results).toHaveLength(0);
    }
});

test("exact batch deduplicates, omits missing pairs, sorts across SQL batches, and avoids per-row reads", async () => {
  const queries = spyOn(adapter.getRawDb(), "query");
  const perRow = spyOn(adapter, "getChunks");
  const whole = spyOn(adapter, "getChunksBatch");
  try {
    expect(await adapter.getChunksBySequenceBatch([])).toEqual(ok(new Map()));
    expect(queries).not.toHaveBeenCalled();
    const keys = [...fixture.chunks]
      .reverse()
      .map(({ mirrorHash, seq }) => ({ mirrorHash, seq }));
    const actual = await adapter.getChunksBySequenceBatch([
      ...keys,
      keys[0]!,
      { mirrorHash: hash, seq: 1001 },
      { mirrorHash: "absent", seq: 0 },
      { mirrorHash: "", seq: 0 },
    ]);
    expect(queries).toHaveBeenCalledTimes(3);
    const all = await adapter.getChunksBatch([hash]);
    expect(actual).toEqual(all);
    expect(perRow).not.toHaveBeenCalled();
    expect(whole).toHaveBeenCalledTimes(1);
    expect(
      await adapter.getChunksBySequenceBatch([{ mirrorHash: hash, seq: 1001 }])
    ).toEqual(ok(new Map()));
  } finally {
    queries.mockRestore();
    perRow.mockRestore();
    whole.mockRestore();
  }
});
