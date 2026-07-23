import type { ContextCapsulePayloadV1 } from "../../src/core/context-capsule-schema";
import type { ContextVerifierDeps } from "../../src/core/context-verifier";
import type { ChunkRow, DocumentRow } from "../../src/store/types";

import { deriveDocid } from "../../src/app/constants";
import { createContextCapsuleV1 } from "../../src/core/context-capsule";
import {
  contextCapsuleEvidenceIdentity,
  sha256Text,
} from "../../src/core/context-capsule-validation";
import { captureContextEvidenceSnapshot } from "../../src/core/context-evidence";
import { ok } from "../../src/store/types";

export type VerifierStore = ContextVerifierDeps["store"];

export interface VerifierState {
  documents: DocumentRow[];
  contents: Map<string, string>;
  chunks: Map<string, ChunkRow[]>;
  indexRevision: string;
  mutateSnapshotAfter?: number;
}

export interface VerifierCalls {
  snapshots: number;
  documents: string[][];
  contents: string[][];
  chunks: string[][];
}

export const FINGERPRINTS = {
  config: sha256Text("config"),
  retrieval: sha256Text("retrieval"),
  embeddingModel: null,
  rerankModel: null,
  tokenizer: null,
};

export const makeChunk = (
  mirrorHash: string,
  content: string,
  startLine = 2,
  endLine = 2
): ChunkRow => {
  const text = content
    .split("\n")
    .slice(startLine - 1, endLine)
    .join("\n");
  return {
    mirrorHash,
    seq: 0,
    pos: content.indexOf(text),
    text,
    startLine,
    endLine,
    language: "en",
    tokenCount: null,
    createdAt: "2026-07-22T10:00:00.000Z",
  };
};

export const documentRow = (
  id: number,
  relPath: string,
  sourceHash: string,
  mirrorHash: string
): DocumentRow => ({
  id,
  collection: "notes",
  relPath,
  sourceHash,
  sourceMime: "text/markdown",
  sourceExt: ".md",
  sourceSize: 100,
  sourceMtime: "2026-07-22T10:00:00.000Z",
  docid: deriveDocid(sourceHash),
  uri: `gno://notes/${relPath}`,
  title: "Decision",
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
});

export const createVerifierStore = (
  state: VerifierState
): { store: VerifierStore; calls: VerifierCalls } => {
  const calls: VerifierCalls = {
    snapshots: 0,
    documents: [],
    contents: [],
    chunks: [],
  };
  const store: VerifierStore = {
    getContexts: async () => ok([]),
    getCollections: async () =>
      ok([
        {
          name: "notes",
          path: "/notes",
          pattern: "**/*.md",
          include: null,
          exclude: null,
          updateCmd: null,
          languageHint: null,
          syncedAt: "2026-07-22T10:00:00.000Z",
        },
      ]),
    getActivationIndexSnapshot: async () => {
      calls.snapshots += 1;
      if (
        state.mutateSnapshotAfter !== undefined &&
        calls.snapshots > state.mutateSnapshotAfter
      ) {
        state.indexRevision = "changed-during-verification";
      }
      return ok({
        identity: {
          indexName: "default",
          schemaVersion: 13,
          ftsTokenizer: "unicode61",
          ftsStateHash: sha256Text(state.indexRevision),
          activeDocumentCount: state.documents.length,
          ftsSynchronized: true,
        },
        documents: state.documents
          .filter((document) => document.active)
          .map((document) => ({
            id: document.id,
            uri: document.uri,
            sourceHash: document.sourceHash,
            mirrorHash: document.mirrorHash,
            active: document.active,
          })),
      });
    },
    getDocumentsByDocids: async (docids) => {
      calls.documents.push([...docids]);
      return ok(
        state.documents.filter(
          (document) => document.active && docids.includes(document.docid)
        )
      );
    },
    getContentBatch: async (hashes) => {
      calls.contents.push([...hashes]);
      return ok(
        new Map(
          hashes.flatMap((hash) => {
            const content = state.contents.get(hash);
            return content === undefined ? [] : [[hash, content] as const];
          })
        )
      );
    },
    getChunksBatch: async (hashes) => {
      calls.chunks.push([...hashes]);
      return ok(
        new Map(
          hashes.flatMap((hash) => {
            const chunks = state.chunks.get(hash);
            return chunks === undefined ? [] : [[hash, chunks] as const];
          })
        )
      );
    },
  };
  return { store, calls };
};

export const verifierFixture = (sameMirror = true) => {
  const firstContent = "# Owner\nMina owns the decision.\nReview Friday.";
  const secondContent = sameMirror
    ? firstContent
    : "# Reviewer\nOmar reviews the decision.\nReview Monday.";
  const firstMirror = sha256Text(firstContent);
  const secondMirror = sha256Text(secondContent);
  const first = documentRow(
    1,
    "first.md",
    sha256Text("source-one"),
    firstMirror
  );
  const second = documentRow(
    2,
    "second.md",
    sha256Text("source-two"),
    secondMirror
  );
  const state: VerifierState = {
    documents: [first, second],
    contents: new Map([
      [firstMirror, firstContent],
      [secondMirror, secondContent],
    ]),
    chunks: new Map([
      [firstMirror, [makeChunk(firstMirror, firstContent)]],
      [secondMirror, [makeChunk(secondMirror, secondContent)]],
    ]),
    indexRevision: "stable",
  };
  return { state, first, second, firstContent, secondContent };
};

export const capsuleFor = async (
  store: VerifierStore,
  state: VerifierState
) => {
  const snapshot = await captureContextEvidenceSnapshot(store, "default", [
    "notes",
  ]);
  const evidence = state.documents.map((document, index) => {
    const content = state.contents.get(document.mirrorHash ?? "") ?? "";
    const text = content.split("\n")[1] ?? "";
    const identity = {
      uri: document.uri,
      docid: document.docid,
      startLine: 2,
      endLine: 2,
      sourceHash: document.sourceHash,
      mirrorHash: document.mirrorHash ?? "",
      passageHash: sha256Text(text),
    };
    return {
      evidenceId: contextCapsuleEvidenceIdentity(identity),
      ...identity,
      collection: "notes",
      title: "Decision",
      heading: index === 0 ? "Owner" : "Reviewer",
      text,
      modifiedAt: document.sourceMtime,
      documentDate: null,
      observedAt: null,
      contextIds: [],
      retrievalRank: index + 1,
      selectionRank: index + 1,
      facets: index === 0 ? ["decision"] : [],
      trust: "untrusted" as const,
      egress: "unavailable" as const,
    };
  });
  const payload: ContextCapsulePayloadV1 = {
    schemaVersion: "1.0",
    coordinateSpace: "canonical_mirror",
    goal: "Find the decision owners",
    query: "decision owner",
    scope: {
      indexName: "default",
      collections: ["notes"],
      uriPrefix: null,
      tagsAll: [],
      tagsAny: [],
      categories: [],
      since: null,
      until: null,
    },
    budget: {
      authority: "canonical_json",
      requestedTokens: 100_000_000,
      requestedBytes: 100_000_000,
      safetyMarginTokens: 0,
      safetyMarginBytes: 0,
      usedTokens: 1,
      usedBytes: 0,
      estimator: "unicode_conservative",
      tokenizerFingerprint: null,
    },
    retrieval: {
      depthPolicy: "balanced",
      facets: ["decision"],
      queryVariants: ["decision owner"],
      expansionPolicy: "deterministic_only",
      request: {
        author: null,
        lang: null,
        queryModes: [],
        limit: 20,
        candidateLimit: 40,
        graphRequested: false,
      },
      capabilityStates: {
        semanticSearch: {
          requested: true,
          attempted: true,
          outcome: "unavailable",
          fallbackReasons: ["embedding_unavailable"],
        },
        reranking: {
          requested: true,
          attempted: true,
          outcome: "unavailable",
          fallbackReasons: ["reranking_unavailable"],
        },
        graphExpansion: {
          requested: false,
          attempted: false,
          outcome: "not_requested",
          fallbackReasons: [],
        },
      },
      indexSnapshot: {
        before: snapshot.indexFingerprint,
        after: snapshot.indexFingerprint,
        stable: true,
      },
    },
    fingerprints: FINGERPRINTS,
    capabilities: {
      lexicalSearch: true,
      semanticSearch: false,
      reranking: false,
      graphExpansion: false,
      exactTokenCount: false,
      configuredContext: false,
      egressPolicy: false,
    },
    fallbacks: [
      { code: "embedding_unavailable", capability: "semantic_search" },
      { code: "reranking_unavailable", capability: "reranking" },
      { code: "tokenizer_unavailable", capability: "token_count" },
      { code: "egress_policy_unavailable", capability: "egress_policy" },
    ],
    guidance: {
      extractiveOnly: true,
      evidenceTrust: "untrusted_data",
      instructionBoundary: "hard_delimited",
      configuredContexts: [],
    },
    evidence,
    coverage: {
      complete: true,
      requestedFacets: ["decision"],
      coveredFacets: [
        {
          facet: "decision",
          evidenceIds: [evidence[0]!.evidenceId],
        },
      ],
      unresolvedFacets: [],
      gaps: [],
    },
    omissions: {
      total: 0,
      items: [],
      reasonCounts: {
        duplicate: 0,
        overlap: 0,
        global_budget: 0,
        redundant_coverage: 0,
        document_share_cap: 0,
        filtered_by_scope: 0,
        invalid_coordinates: 0,
      },
      truncated: false,
    },
    truncated: false,
    warnings: [{ code: "token_estimate_used" }],
  };
  return createContextCapsuleV1(payload);
};

export const verifierDeps = (
  store: VerifierStore,
  capsule: Awaited<ReturnType<typeof capsuleFor>>,
  fingerprints = FINGERPRINTS
): ContextVerifierDeps => ({
  store,
  currentFingerprints: fingerprints,
  resolveCurrentRanks: async () =>
    new Map(
      capsule.evidence.map((item) => [item.evidenceId, item.retrievalRank])
    ),
});
