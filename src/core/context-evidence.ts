/** Strict indexed-evidence loading for Context Capsule compilation. */

import type { SearchResults } from "../pipeline/types";
import type {
  ActivationIndexSnapshot,
  ContextRow,
  DocumentRow,
  StorePort,
  StoreResult,
} from "../store/types";
import type {
  ContextCanonicalProjection,
  MaterializedContextCandidate,
} from "./context-budget";
import type { ContextCapsulePayloadV1 } from "./context-capsule-schema";
import type {
  ContextCanonicalPlanDraft,
  ContextCompilerInput,
  ContextEvidencePlan,
  ContextMaterialization,
  ContextRetrievalCandidate,
  ContextRetrievalRequest,
} from "./context-compiler";

import { decorateUriForIndex, deriveDocid, parseUri } from "../app/constants";
import { canonicalizeIndexName } from "../app/index-name";
import {
  chunkMatchesCanonicalContent,
  createChunkLookup,
} from "../pipeline/chunk-lookup";
import { SEARCH_RESULT_PLANNER_METADATA } from "../pipeline/types";
import {
  contextCapsuleEvidenceIdentity,
  sha256Text,
} from "./context-capsule-validation";
import { planContextEvidence } from "./context-compiler";
import {
  extractInclusiveLines,
  extractSections,
  headingForLine,
} from "./sections";

type ContextEvidenceStore = Pick<
  StorePort,
  | "getActivationIndexSnapshot"
  | "getChunksBatch"
  | "getCollections"
  | "getContexts"
  | "getDocumentsByDocids"
> &
  Required<Pick<StorePort, "getContentBatch">>;

export type ContextEvidenceErrorCode =
  | "chunk_coordinate_mismatch"
  | "chunk_load_failed"
  | "collection_load_failed"
  | "content_load_failed"
  | "context_changed_during_compile"
  | "context_load_failed"
  | "document_load_failed"
  | "index_changed_during_compile"
  | "index_snapshot_failed"
  | "index_snapshot_mismatch"
  | "stored_provenance_mismatch";

export class ContextEvidenceError extends Error {
  readonly code: ContextEvidenceErrorCode;

  constructor(
    code: ContextEvidenceErrorCode,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ContextEvidenceError";
    this.code = code;
  }
}

export interface ContextEvidenceSnapshot {
  collections: string[];
  contexts: ContextRow[];
  contextFingerprint: string;
  indexFingerprint: string;
}

export interface ContextEvidenceValue {
  collection: string;
  title: string | null;
  heading: string | null;
  modifiedAt: string | null;
  documentDate: string | null;
  observedAt: null;
  contextIds: string[];
  trust: "untrusted";
  egress: "unavailable";
}

export type ContextEvidenceCompilerInput = Omit<
  ContextCompilerInput,
  "contextSnapshot" | "observedAt"
>;

export interface ContextEvidenceProjectionContext {
  contextFingerprint: string;
  indexFingerprint: string;
}

export interface ContextEvidenceCompilerDeps<P> {
  store: ContextEvidenceStore;
  retrieve: (request: ContextRetrievalRequest) => Promise<SearchResults>;
  projectCanonical: (
    draft: ContextCanonicalPlanDraft<ContextEvidenceValue>,
    fingerprints: ContextEvidenceProjectionContext
  ) => ContextCanonicalProjection<P> | null;
}

export interface CompiledContextEvidence<P> extends ContextEvidencePlan<
  ContextEvidenceValue,
  P
> {
  snapshot: ContextEvidenceProjectionContext;
}

const compareCodeUnits = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const hashJson = (value: unknown): string => sha256Text(JSON.stringify(value));

const unwrapStore = <T>(
  result: StoreResult<T>,
  code: ContextEvidenceErrorCode,
  operation: string
): T => {
  if (result.ok) return result.value;
  throw new ContextEvidenceError(
    code,
    `${operation}: ${result.error.message}`,
    result.error.cause
  );
};

const canonicalContexts = (contexts: ContextRow[]) =>
  contexts
    .map(({ scopeType, scopeKey, text }) => ({ scopeType, scopeKey, text }))
    .sort(
      (left, right) =>
        compareCodeUnits(left.scopeType, right.scopeType) ||
        compareCodeUnits(left.scopeKey, right.scopeKey) ||
        compareCodeUnits(left.text, right.text)
    );

export const fingerprintContextRows = (contexts: ContextRow[]): string =>
  hashJson(canonicalContexts(contexts));

const canonicalIndexSnapshot = (
  collection: string,
  snapshot: ActivationIndexSnapshot
) => ({
  collection,
  identity: {
    indexName: snapshot.identity.indexName,
    schemaVersion: snapshot.identity.schemaVersion,
    ftsTokenizer: snapshot.identity.ftsTokenizer,
    ftsStateHash: snapshot.identity.ftsStateHash,
    activeDocumentCount: snapshot.identity.activeDocumentCount,
    ftsSynchronized: snapshot.identity.ftsSynchronized,
  },
  documents: [...snapshot.documents]
    .map(({ uri, sourceHash, mirrorHash, active }) => ({
      uri,
      sourceHash,
      mirrorHash,
      active,
    }))
    .sort(
      (left, right) =>
        compareCodeUnits(left.uri, right.uri) ||
        compareCodeUnits(left.sourceHash, right.sourceHash) ||
        compareCodeUnits(left.mirrorHash ?? "", right.mirrorHash ?? "")
    ),
});

/** Capture one strict, content-free index/context snapshot before or after work. */
export const captureContextEvidenceSnapshot = async (
  store: ContextEvidenceStore,
  indexNameInput: string,
  requestedCollections: string[]
): Promise<ContextEvidenceSnapshot> => {
  const contexts = unwrapStore(
    await store.getContexts(),
    "context_load_failed",
    "Failed to load configured contexts"
  ).map((row) => ({ ...row }));
  const collections =
    requestedCollections.length > 0
      ? [...new Set(requestedCollections)].sort(compareCodeUnits)
      : [
          ...new Set(
            unwrapStore(
              await store.getCollections(),
              "collection_load_failed",
              "Failed to load indexed collections"
            ).map((row) => row.name)
          ),
        ].sort(compareCodeUnits);
  const indexName = canonicalizeIndexName(indexNameInput);
  const indexSnapshots: ReturnType<typeof canonicalIndexSnapshot>[] = [];
  for (const collection of collections) {
    const snapshot = unwrapStore(
      await store.getActivationIndexSnapshot(collection),
      "index_snapshot_failed",
      `Failed to load index snapshot for ${collection}`
    );
    if (canonicalizeIndexName(snapshot.identity.indexName) !== indexName) {
      throw new ContextEvidenceError(
        "index_snapshot_mismatch",
        `Index snapshot for ${collection} belongs to ${snapshot.identity.indexName}, not ${indexName}`
      );
    }
    indexSnapshots.push(canonicalIndexSnapshot(collection, snapshot));
  }
  return {
    collections,
    contexts,
    contextFingerprint: fingerprintContextRows(contexts),
    indexFingerprint: hashJson(indexSnapshots),
  };
};

const referenceDocument = (
  documents: DocumentRow[],
  candidate: ContextRetrievalCandidate,
  indexName: string
): DocumentRow => {
  const result = candidate.result;
  const matches = documents.filter(
    (document) =>
      document.docid === result.docid &&
      decorateUriForIndex(document.uri, indexName) === result.uri
  );
  if (matches.length !== 1) {
    throw new ContextEvidenceError(
      "stored_provenance_mismatch",
      `Expected one active indexed document for ${result.uri}; found ${matches.length}`
    );
  }
  const document = matches[0];
  const parsedUri = parseUri(result.uri);
  const sourceHash = result.source.sourceHash;
  const mirrorHash = result.conversion?.mirrorHash;
  if (
    !document ||
    !document.active ||
    !document.mirrorHash ||
    parsedUri?.collection !== document.collection ||
    result.source.relPath !== document.relPath ||
    sourceHash !== document.sourceHash ||
    mirrorHash !== document.mirrorHash ||
    deriveDocid(document.sourceHash) !== document.docid
  ) {
    throw new ContextEvidenceError(
      "stored_provenance_mismatch",
      `Stored source identity drifted for ${result.uri}`
    );
  }
  return document;
};

/** Materialize all planned candidates with exactly one batch per store layer. */
export const materializeContextEvidenceCandidates = async (
  store: ContextEvidenceStore,
  candidates: ContextRetrievalCandidate[],
  indexNameInput: string
): Promise<ContextMaterialization<ContextEvidenceValue>[]> => {
  if (candidates.length === 0) return [];
  const indexName = canonicalizeIndexName(indexNameInput);
  const docids = [...new Set(candidates.map(({ result }) => result.docid))];
  const documents = unwrapStore(
    await store.getDocumentsByDocids(docids, { activeOnly: true }),
    "document_load_failed",
    "Failed to batch-load Context evidence documents"
  );
  const alignedDocuments = candidates.map((candidate) =>
    referenceDocument(documents, candidate, indexName)
  );
  const mirrorHashes = [
    ...new Set(
      alignedDocuments.map((document) => document.mirrorHash as string)
    ),
  ];
  const [contentResult, chunksResult] = await Promise.all([
    store.getContentBatch(mirrorHashes),
    store.getChunksBatch(mirrorHashes),
  ]);
  const contentByHash = unwrapStore(
    contentResult,
    "content_load_failed",
    "Failed to batch-load Context evidence mirrors"
  );
  const chunksByHash = unwrapStore(
    chunksResult,
    "chunk_load_failed",
    "Failed to batch-load Context evidence chunks"
  );
  const getChunk = createChunkLookup(chunksByHash);
  const sectionsByHash = new Map<string, ReturnType<typeof extractSections>>();
  const validatedMirrors = new Set<string>();
  const validatedChunks = new Set<string>();

  return candidates.map((candidate, index) => {
    const result = candidate.result;
    const document = alignedDocuments[index];
    const metadata = result[SEARCH_RESULT_PLANNER_METADATA];
    const snippetRange = result.snippetRange;
    if (!document?.mirrorHash || !metadata || !snippetRange) {
      throw new ContextEvidenceError(
        "chunk_coordinate_mismatch",
        `Hybrid result lacks exact chunk coordinates for ${result.uri}`
      );
    }
    const content = contentByHash.get(document.mirrorHash);
    const chunk = getChunk(document.mirrorHash, metadata.seq);
    const chunkKey = `${document.mirrorHash}:${metadata.seq}`;
    if (
      !content ||
      metadata.mirrorHash !== document.mirrorHash ||
      !chunk ||
      chunk.mirrorHash !== document.mirrorHash ||
      snippetRange.startLine !== chunk.startLine ||
      snippetRange.endLine !== chunk.endLine
    ) {
      throw new ContextEvidenceError(
        "chunk_coordinate_mismatch",
        `Stored chunk identity drifted for ${result.uri}`
      );
    }
    if (!validatedMirrors.has(document.mirrorHash)) {
      if (sha256Text(content) !== document.mirrorHash) {
        throw new ContextEvidenceError(
          "chunk_coordinate_mismatch",
          `Stored mirror bytes drifted for ${result.uri}`
        );
      }
      validatedMirrors.add(document.mirrorHash);
    }
    if (!validatedChunks.has(chunkKey)) {
      if (!chunkMatchesCanonicalContent(chunk, content)) {
        throw new ContextEvidenceError(
          "chunk_coordinate_mismatch",
          `Stored chunk coordinates drifted for ${result.uri}`
        );
      }
      validatedChunks.add(chunkKey);
    }
    const text = extractInclusiveLines(content, chunk.startLine, chunk.endLine);
    if (!text) {
      throw new ContextEvidenceError(
        "chunk_coordinate_mismatch",
        `Canonical line range is unavailable for ${result.uri}`
      );
    }
    let sections = sectionsByHash.get(document.mirrorHash);
    if (!sections) {
      sections = extractSections(content);
      sectionsByHash.set(document.mirrorHash, sections);
    }
    return {
      ok: true,
      candidate: {
        uri: result.uri,
        docid: document.docid,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        text,
        sourceHash: document.sourceHash,
        mirrorHash: document.mirrorHash,
        value: {
          collection: document.collection,
          title: document.title,
          heading: headingForLine(sections, chunk.startLine),
          modifiedAt: document.sourceMtime ?? null,
          documentDate: document.frontmatterDate ?? null,
          observedAt: null,
          contextIds: [...candidate.contextIds],
          trust: "untrusted",
          egress: "unavailable",
        },
      },
    };
  });
};

/** Compile one evidence plan and discard it if either source snapshot drifted. */
export const compileContextEvidence = async <P>(
  input: ContextEvidenceCompilerInput,
  deps: ContextEvidenceCompilerDeps<P>
): Promise<CompiledContextEvidence<P>> => {
  const before = await captureContextEvidenceSnapshot(
    deps.store,
    input.indexName,
    input.collections
  );
  const fingerprints = {
    contextFingerprint: before.contextFingerprint,
    indexFingerprint: before.indexFingerprint,
  };
  const plan = await planContextEvidence(
    { ...input, contextSnapshot: before.contexts, observedAt: null },
    {
      retrieve: deps.retrieve,
      materializeCandidates: (candidates) =>
        materializeContextEvidenceCandidates(
          deps.store,
          candidates,
          input.indexName
        ),
      projectCanonical: (draft) => deps.projectCanonical(draft, fingerprints),
    }
  );
  const after = await captureContextEvidenceSnapshot(
    deps.store,
    input.indexName,
    input.collections
  );
  if (before.indexFingerprint !== after.indexFingerprint) {
    throw new ContextEvidenceError(
      "index_changed_during_compile",
      "Index changed while Context evidence was being compiled"
    );
  }
  if (before.contextFingerprint !== after.contextFingerprint) {
    throw new ContextEvidenceError(
      "context_changed_during_compile",
      "Configured contexts changed while Context evidence was being compiled"
    );
  }
  return { ...plan, snapshot: fingerprints };
};

/** Project one selected candidate into the frozen Capsule evidence contract. */
export const toContextCapsuleEvidence = (
  candidate: MaterializedContextCandidate<ContextEvidenceValue>,
  selectionRank: number
): ContextCapsulePayloadV1["evidence"][number] => {
  const identity = {
    uri: candidate.uri,
    docid: candidate.docid,
    startLine: candidate.startLine,
    endLine: candidate.endLine,
    sourceHash: candidate.sourceHash,
    mirrorHash: candidate.mirrorHash,
    passageHash: candidate.passageHash,
  };
  return {
    evidenceId: contextCapsuleEvidenceIdentity(identity),
    ...identity,
    ...candidate.value,
    text: candidate.text,
    retrievalRank: candidate.retrievalRank,
    selectionRank,
    facets: [...candidate.facets],
  };
};
