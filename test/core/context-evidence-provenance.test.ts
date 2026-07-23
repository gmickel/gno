import { expect, test } from "bun:test";

import type { ContextRetrievalCandidate } from "../../src/core/context-compiler";
import type { ContextEvidenceCompilerDeps } from "../../src/core/context-evidence";
import type { SearchResult } from "../../src/pipeline/types";
import type { ChunkRow, DocumentRow } from "../../src/store/types";

import { deriveDocid } from "../../src/app/constants";
import { sha256Text } from "../../src/core/context-capsule-validation";
import { materializeContextEvidenceCandidates } from "../../src/core/context-evidence";
import { CONTEXT_EVIDENCE_METADATA_MAX_LENGTH } from "../../src/core/context-evidence-metadata";
import { SEARCH_RESULT_PLANNER_METADATA } from "../../src/pipeline/types";
import { ok } from "../../src/store/types";

type EvidenceStore = ContextEvidenceCompilerDeps<unknown>["store"];

test("strict materialization rejects URI and hidden planner identity drift", async () => {
  const heading = "H".repeat(CONTEXT_EVIDENCE_METADATA_MAX_LENGTH + 1);
  const content = `# ${heading}\nExact evidence`;
  const mirrorHash = sha256Text(content);
  const sourceHash = sha256Text("source");
  const document: DocumentRow = {
    id: 1,
    collection: "notes",
    relPath: "evidence.md",
    sourceHash,
    sourceMime: "text/markdown",
    sourceExt: ".md",
    sourceSize: content.length,
    sourceMtime: "2026-07-22T10:00:00.000Z",
    docid: deriveDocid(sourceHash),
    uri: "gno://notes/evidence.md",
    title: "T".repeat(CONTEXT_EVIDENCE_METADATA_MAX_LENGTH + 1),
    mirrorHash,
    converterId: "markdown",
    converterVersion: "1",
    languageHint: "en",
    active: true,
    ingestVersion: 1,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastErrorAt: null,
    createdAt: "2026-07-22T10:00:00.000Z",
    updatedAt: "2026-07-22T10:00:00.000Z",
  };
  const chunk: ChunkRow = {
    mirrorHash,
    seq: 4,
    pos: content.indexOf("Exact evidence"),
    text: "Exact evidence",
    startLine: 2,
    endLine: 2,
    language: "en",
    tokenCount: null,
    createdAt: "2026-07-22T10:00:00.000Z",
  };
  const store: EvidenceStore = {
    getContexts: async () => ok([]),
    getCollections: async () => ok([]),
    getActivationIndexSnapshot: async () =>
      ok({
        identity: {
          indexName: "default",
          schemaVersion: 13,
          ftsTokenizer: "unicode61",
          ftsStateHash: sha256Text("fts"),
          activeDocumentCount: 1,
          ftsSynchronized: true,
        },
        documents: [],
      }),
    getDocumentsByDocids: async () => ok([document]),
    getContentBatch: async () => ok(new Map([[mirrorHash, content]])),
    getChunksBatch: async () => ok(new Map([[mirrorHash, [chunk]]])),
  };
  const baseResult = {
    docid: document.docid,
    score: 1,
    uri: document.uri,
    snippet: chunk.text,
    snippetRange: { startLine: chunk.startLine, endLine: chunk.endLine },
    source: {
      relPath: document.relPath,
      mime: document.sourceMime,
      ext: document.sourceExt,
      sourceHash: document.sourceHash,
    },
    conversion: { mirrorHash },
    [SEARCH_RESULT_PLANNER_METADATA]: {
      retrievalRank: 1,
      mirrorHash,
      seq: chunk.seq,
      sources: ["bm25" as const],
      graphExpanded: false,
    },
  };
  const planned = (result: SearchResult): ContextRetrievalCandidate => ({
    result,
    retrievalRank: 1,
    retrievalSources: ["bm25"],
    graphExpanded: false,
    contextIds: [],
    observedAt: null,
  });

  const valid = await materializeContextEvidenceCandidates(
    store,
    [planned(baseResult)],
    "default"
  );
  expect(valid[0]?.ok && valid[0].candidate.value.title?.length).toBe(
    CONTEXT_EVIDENCE_METADATA_MAX_LENGTH
  );
  expect(valid[0]?.ok && valid[0].candidate.value.heading?.length).toBe(
    CONTEXT_EVIDENCE_METADATA_MAX_LENGTH
  );

  const wrongUri = { ...baseResult, uri: "gno://notes/other.md" };
  expect(
    materializeContextEvidenceCandidates(store, [planned(wrongUri)], "default")
  ).rejects.toMatchObject({ code: "stored_provenance_mismatch" });

  const {
    [SEARCH_RESULT_PLANNER_METADATA]: _plannerMetadata,
    ...missingMetadata
  } = baseResult;
  expect(
    materializeContextEvidenceCandidates(
      store,
      [planned(missingMetadata)],
      "default"
    )
  ).rejects.toMatchObject({ code: "chunk_coordinate_mismatch" });

  for (const metadata of [
    {
      ...baseResult[SEARCH_RESULT_PLANNER_METADATA],
      mirrorHash: "f".repeat(64),
    },
    { ...baseResult[SEARCH_RESULT_PLANNER_METADATA], seq: 99 },
  ]) {
    const drifted = {
      ...baseResult,
      [SEARCH_RESULT_PLANNER_METADATA]: metadata,
    };
    expect(
      materializeContextEvidenceCandidates(store, [planned(drifted)], "default")
    ).rejects.toMatchObject({ code: "chunk_coordinate_mismatch" });
  }
});
