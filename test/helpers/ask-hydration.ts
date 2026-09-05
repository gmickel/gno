// Bun has no directory creation/removal, temporary-directory or path API.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AcceptanceManifest } from "../../evals/acceptance/manifest";
import type {
  AcceptanceRecord,
  DeterministicRecord,
} from "../../evals/acceptance/records";
import type { GenerationPort, RerankPort } from "../../src/llm/types";

import { acceptanceManifestFingerprint } from "../../evals/acceptance/manifest";
import { hydrationLongDocument } from "../../evals/fixtures/acceptance/hydration-long-doc/fixture";
import pin from "../../evals/fixtures/acceptance/hydration-long-doc/manifest.json";
import { buildVerifiedAsk } from "../../src/app/verified-ask";
import { createDefaultConfig } from "../../src/config";
import { sha256Text } from "../../src/core/context-capsule-validation";
import {
  generateGroundedAnswer,
  processAnswerResult,
} from "../../src/pipeline/answer";
import { searchHybrid } from "../../src/pipeline/hybrid";
import { RequestHydration } from "../../src/pipeline/hydration";
import {
  CITATION_TRACE_METADATA,
  SEARCH_RESULT_PLANNER_METADATA,
} from "../../src/pipeline/types";
import { SqliteAdapter } from "../../src/store";
import { safeRm } from "./cleanup";

export const askCases = [
  "raw",
  "verified",
  "unsupported",
  "missing",
  "corrupt",
  "edited",
] as const;
export type AskCase = (typeof askCases)[number];
// Canonical LF derivative; the original CRLF fixture pin is never changed.
const original = hydrationLongDocument();
export const fixture = {
  content: original.content.replaceAll("\r\n", "\n"),
  chunks: original.chunks.map((chunk) => ({
    ...chunk,
    text: chunk.text.replaceAll("\r\n", "\n"),
  })),
};
export const fixtureHash = sha256Text(JSON.stringify(fixture));
export const mirrorHash = sha256Text(fixture.content);
export const options = {
  noExpand: true,
  graph: false,
  intent: "needle evidence",
  limit: 5,
};

export function askManifest(
  role: "baseline" | "candidate"
): AcceptanceManifest {
  return {
    schemaVersion: "gno-acceptance-v1",
    role,
    identity: {
      commit: "d608b2c2461b024ebd90188824d1dd06b04848ab",
      indexId: "ask-hydration-unit",
      indexSha256: fixtureHash,
      bunVersion: Bun.version,
      nativeDependencies: {},
      platform: process.platform,
      architecture: process.arch,
    },
    fixtureVersion: pin.version,
    fixtures: [
      { path: "hydration-long-doc/generated.json", sha256: pin.sha256 },
      { path: "ask-canonical-lf/generated.json", sha256: fixtureHash },
    ],
    models: [],
    cases: askCases.map((caseId) => ({
      caseId,
      fixtureSha256: fixtureHash,
      surface: "sdk",
      preset: "unit",
      configuration: options,
    })),
    intendedDeltas: [],
  };
}

export async function askStore() {
  const store = new SqliteAdapter();
  const root = await mkdtemp(join(tmpdir(), "gno-ask-hydration-"));
  const opened = await store.open(
    join(root, "index-default.sqlite"),
    "unicode61"
  );
  if (!opened.ok) throw new Error(opened.error.message);
  const config = {
    ...createDefaultConfig(),
    collections: [
      {
        name: "notes",
        path: "/synthetic",
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ],
  };
  await store.syncCollections(config.collections);
  for (const relPath of ["a.md", "b.md"]) {
    await store.upsertDocument({
      collection: "notes",
      relPath,
      sourceHash: sha256Text(relPath),
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: fixture.content.length,
      sourceMtime: "2026-09-05T00:00:00.000Z",
      mirrorHash,
      title: "Duplicate title",
      languageHint: "en",
    });
  }
  await store.upsertContent(mirrorHash, fixture.content);
  let pos = 0;
  await store.upsertChunks(
    mirrorHash,
    fixture.chunks.map((chunk) => {
      const row = {
        ...chunk,
        mirrorHash,
        pos,
        language: chunk.language ?? undefined,
        tokenCount: chunk.tokenCount ?? undefined,
      };
      pos += chunk.text.length + 1;
      return row;
    })
  );
  await store.rebuildFtsForHash(mirrorHash);
  const counts = { reads: 0, rows: 0, bytes: 0 };
  const chunks = store.getChunksBatch.bind(store);
  const contents = store.getContentBatch.bind(store);
  const content = store.getContent.bind(store);
  store.getChunksBatch = async (hashes) => {
    const result = await chunks(hashes);
    counts.reads++;
    if (result.ok)
      for (const rows of result.value.values())
        for (const row of rows) {
          counts.rows++;
          counts.bytes += Buffer.byteLength(row.text);
        }
    return result;
  };
  store.getContentBatch = async (hashes) => {
    const result = await contents(hashes);
    counts.reads++;
    if (result.ok)
      for (const text of result.value.values()) {
        counts.rows++;
        counts.bytes += Buffer.byteLength(text);
      }
    return result;
  };
  store.getContent = async (hash) => {
    const result = await content(hash);
    counts.reads++;
    if (result.ok && result.value !== null) {
      counts.rows++;
      counts.bytes += Buffer.byteLength(result.value);
    }
    return result;
  };
  return {
    store,
    config,
    counts,
    dbPath: join(root, "index-default.sqlite"),
    close: async () => {
      await store.close();
      await safeRm(root);
    },
  };
}

export function askGeneration(
  inputs: DeterministicRecord["modelInputs"],
  unsupported = false
): GenerationPort {
  return {
    modelUri: "file:/synthetic-ask.gguf",
    structuredOutput: "json_schema",
    generate: async (prompt, params) => {
      inputs.push({
        role: "generation",
        modelId: "synthetic-ask",
        input: JSON.parse(JSON.stringify({ prompt, params })),
      });
      if (!params?.jsonSchema)
        return {
          ok: true,
          value: "The document contains needle evidence [1].",
        };
      const schema = params.jsonSchema as {
        properties: {
          judgments: {
            items: {
              properties: {
                claimId: { enum: string[] };
                evidenceIds: { items: { enum: string[] } };
              };
            };
          };
        };
      };
      const properties = schema.properties.judgments.items.properties;
      return {
        ok: true,
        value: JSON.stringify({
          judgments: [
            {
              claimId: properties.claimId.enum[0],
              verdict: unsupported ? "unsupported" : "supported",
              confidence: 1,
              evidenceIds: unsupported
                ? []
                : [properties.evidenceIds.items.enum[0]],
              rationaleCode: unsupported
                ? "insufficient_evidence"
                : "semantic_entailment",
            },
          ],
          unresolvedClaimIds: [],
        }),
      };
    },
    dispose: async () => {},
  };
}

export async function captureAsk(caseId: AskCase, cached: boolean) {
  const { store, config, counts, close } = await askStore();
  const hydration = new RequestHydration(store);
  const modelInputs: DeterministicRecord["modelInputs"] = [];
  const genPort = askGeneration(modelInputs, caseId === "unsupported");
  const rerankPort: RerankPort = {
    modelUri: "file:/synthetic-rerank.gguf",
    rerank: async (query, documents) => {
      modelInputs.push({
        role: "reranking",
        modelId: "synthetic-rerank",
        input: JSON.parse(JSON.stringify({ query, documents })),
      });
      // Mutation during a downstream wait after retrieval has hydrated content.
      if (caseId === "edited")
        store
          .getRawDb()
          .run("UPDATE documents SET source_hash = ? WHERE rel_path = 'a.md'", [
            sha256Text("edited"),
          ]);
      if (caseId === "missing")
        store
          .getRawDb()
          .run("DELETE FROM content WHERE mirror_hash = ?", [mirrorHash]);
      if (caseId === "corrupt")
        store
          .getRawDb()
          .run(
            "UPDATE content SET markdown = 'corrupt' WHERE mirror_hash = ?",
            [mirrorHash]
          );
      return {
        ok: true,
        value: documents.map((_, index) => ({
          index,
          score: 0.8,
          rank: index + 1,
        })),
      };
    },
    dispose: async () => {},
  };
  const deps = {
    store,
    config,
    indexName: "default",
    vectorIndex: null,
    embedPort: null,
    expandPort: null,
    rerankPort,
    genPort,
    ...(cached ? { hydration } : {}),
  };
  let output: unknown;
  let error: string | null = null;
  try {
    if (caseId === "raw") {
      const search = await searchHybrid(deps, "needle evidence", options);
      if (!search.ok) throw new Error(search.error.message);
      const answer = await generateGroundedAnswer(
        deps,
        "needle evidence",
        search.value.results,
        512
      );
      output = {
        search: {
          ...search.value,
          results: search.value.results.map((result) => ({
            ...result,
            planner: result[SEARCH_RESULT_PLANNER_METADATA],
          })),
        },
        answer: answer && {
          ...processAnswerResult(answer),
          citations: answer.citations.map((citation) => ({
            ...citation,
            trace: citation[CITATION_TRACE_METADATA],
          })),
        },
      };
    } else {
      const answer = await buildVerifiedAsk("needle evidence", options, deps);
      const { durationMs: _duration, ...semantic } =
        answer.verification!.semantic;
      output = {
        ...answer,
        citations: answer.citations?.map((citation) => ({
          ...citation,
          trace: citation[CITATION_TRACE_METADATA],
        })),
        verification: { ...answer.verification, semantic },
      };
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    output = { error };
  } finally {
    hydration.release();
    await close();
  }
  const record: AcceptanceRecord = {
    schemaVersion: "gno-acceptance-v1",
    manifestSha256: acceptanceManifestFingerprint(
      askManifest(cached ? "candidate" : "baseline")
    ),
    caseId,
    deterministic: {
      scope: { completeOutput: JSON.parse(JSON.stringify(output)) },
      results: [],
      citations: [],
      modelInputs,
      semanticState: {
        status: error ? "error" : "ok",
        vectorsUsed: false,
        vectorStatus: "not-requested",
        error,
        fallbacks: [],
        verification: null,
      },
    },
    generatedAnswer: null,
    transport: {},
  };
  return { record, counts };
}
