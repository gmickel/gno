/** Deterministic, non-mutating verification for saved Context Capsules. */

import type {
  ChunkRow,
  DocumentRow,
  StorePort,
  StoreResult,
} from "../store/types";
import type { ContextCapsuleV1 } from "./context-capsule";
import type { ContextCapsuleVerification } from "./context-capsule-verification";

import { decorateUriForIndex, deriveDocid } from "../app/constants";
import { chunkMatchesCanonicalContent } from "../pipeline/chunk-lookup";
import {
  canonicalContextCapsuleJson,
  parseContextCapsuleV1,
  type ContextCapsuleCreateOptions,
} from "./context-capsule";
import { sha256Text } from "./context-capsule-validation";
import { contextCapsuleVerificationSchema } from "./context-capsule-verification";
import {
  captureContextEvidenceSnapshot,
  type ContextEvidenceSnapshot,
} from "./context-evidence";
import { extractInclusiveLines } from "./sections";

type ContextVerifierStore = Pick<
  StorePort,
  | "getActivationIndexSnapshot"
  | "getChunksBatch"
  | "getCollections"
  | "getContexts"
  | "getDocumentsByDocids"
> &
  Required<Pick<StorePort, "getContentBatch">>;

export interface ContextVerifierFingerprints {
  config: string;
  retrieval: string;
  embeddingModel: string | null;
  rerankModel: string | null;
  tokenizer: string | null;
}

export interface ContextVerifierDeps {
  store: ContextVerifierStore;
  currentFingerprints: ContextVerifierFingerprints;
  resolveCurrentRanks?: (
    capsule: ContextCapsuleV1
  ) => Promise<ReadonlyMap<string, number>>;
  countTokens?: ContextCapsuleCreateOptions["countTokens"];
}

export type ContextVerifierErrorCode =
  | "capsule_mutated_during_verify"
  | "chunk_load_failed"
  | "content_load_failed"
  | "context_changed_during_verify"
  | "document_load_failed"
  | "index_changed_during_verify";

export class ContextVerifierError extends Error {
  readonly code: ContextVerifierErrorCode;

  constructor(
    code: ContextVerifierErrorCode,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ContextVerifierError";
    this.code = code;
  }
}

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalizeJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareCodeUnits)) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) {
        throw new Error(`Canonical JSON rejects undefined at ${key}`);
      }
      sorted[key] = canonicalizeJsonValue(child);
    }
    return sorted;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Canonical JSON rejects non-finite numbers");
  }
  return value;
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalizeJsonValue(value));

const unwrapStore = <T>(
  result: StoreResult<T>,
  code: ContextVerifierErrorCode,
  operation: string
): T => {
  if (result.ok) return result.value;
  throw new ContextVerifierError(
    code,
    `${operation}: ${result.error.message}`,
    result.error.cause
  );
};

const matchingDocument = (
  documents: readonly DocumentRow[],
  uri: string,
  sourceHash: string,
  mirrorHash: string,
  indexName: string
): DocumentRow | null => {
  const matches = documents.filter(
    (document) =>
      document.active &&
      document.docid === deriveDocid(sourceHash) &&
      document.sourceHash === sourceHash &&
      document.mirrorHash === mirrorHash &&
      decorateUriForIndex(document.uri, indexName) === uri
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
};

const rawInclusiveLines = (
  content: string,
  startLine: number,
  endLine: number
): string => {
  const lines = content.split("\n");
  if (startLine > lines.length) return "";
  return lines.slice(startLine - 1, Math.min(endLine, lines.length)).join("\n");
};

const fingerprintsMatch = (
  current: ContextVerifierFingerprints,
  saved: ContextCapsuleV1["fingerprints"]
): boolean =>
  current.config === saved.config &&
  current.retrieval === saved.retrieval &&
  current.embeddingModel === saved.embeddingModel &&
  current.rerankModel === saved.rerankModel &&
  current.tokenizer === saved.tokenizer;

type Evidence = ContextCapsuleV1["evidence"][number];
type EvidenceReceipt = ContextCapsuleVerification["evidence"][number];

interface LoadedEvidence {
  contentByHash: Map<string, string>;
  chunksByHash: Map<string, ChunkRow[]>;
  documents: DocumentRow[];
  snapshot: ContextEvidenceSnapshot;
}

const missingReceipt = (evidence: Evidence): EvidenceReceipt => ({
  evidenceId: evidence.evidenceId,
  uri: evidence.uri,
  contentStatus: "missing",
  contentCode: "source_missing",
  rankingStatus: "unavailable",
  rankingCode: "ranking_unavailable",
  currentSourceHash: null,
  currentMirrorHash: null,
  currentPassageHash: null,
  currentRetrievalRank: null,
});

const verifyContent = (
  evidence: Evidence,
  loaded: LoadedEvidence,
  indexName: string
): EvidenceReceipt => {
  const identities = loaded.snapshot.documents.filter(
    (document) => document.uri === evidence.uri
  );
  const identity = identities.length === 1 ? identities[0] : undefined;
  if (!identity?.mirrorHash) return missingReceipt(evidence);
  const document = matchingDocument(
    loaded.documents,
    evidence.uri,
    identity.sourceHash,
    identity.mirrorHash,
    indexName
  );
  const content = loaded.contentByHash.get(identity.mirrorHash);
  if (!document || content === undefined) return missingReceipt(evidence);

  const currentMirrorHash = sha256Text(content);
  const exactPassage = extractInclusiveLines(
    content,
    evidence.startLine,
    evidence.endLine
  );
  const currentPassageHash = sha256Text(
    exactPassage ??
      rawInclusiveLines(content, evidence.startLine, evidence.endLine)
  );
  const chunk = loaded.chunksByHash
    .get(identity.mirrorHash)
    ?.find(
      (candidate) =>
        candidate.mirrorHash === identity.mirrorHash &&
        candidate.startLine === evidence.startLine &&
        candidate.endLine === evidence.endLine &&
        chunkMatchesCanonicalContent(candidate, content)
    );
  const chunkValid = chunk !== undefined;

  let contentCode: EvidenceReceipt["contentCode"] = "verified_unchanged";
  if (identity.sourceHash !== evidence.sourceHash) {
    contentCode = "source_stale";
  } else if (
    identity.mirrorHash !== evidence.mirrorHash ||
    currentMirrorHash !== identity.mirrorHash ||
    content.includes("\r")
  ) {
    contentCode = "mirror_stale";
  } else if (
    exactPassage === null ||
    currentPassageHash !== evidence.passageHash ||
    !chunkValid
  ) {
    contentCode = "passage_stale";
  }

  return {
    evidenceId: evidence.evidenceId,
    uri: evidence.uri,
    contentStatus: contentCode === "verified_unchanged" ? "unchanged" : "stale",
    contentCode,
    rankingStatus: "unavailable",
    rankingCode: "ranking_unavailable",
    currentSourceHash: identity.sourceHash,
    currentMirrorHash,
    currentPassageHash,
    currentRetrievalRank: null,
  };
};

const applyRanking = (
  receipt: EvidenceReceipt,
  evidence: Evidence,
  currentRanks: ReadonlyMap<string, number> | null,
  fingerprintsDrifted: boolean,
  indexDrifted: boolean
): EvidenceReceipt => {
  if (receipt.contentStatus !== "unchanged") return receipt;
  const rank = currentRanks?.get(evidence.evidenceId);
  if (!Number.isSafeInteger(rank) || (rank ?? 0) < 1) return receipt;
  const reranked =
    rank !== evidence.retrievalRank || fingerprintsDrifted || indexDrifted;
  return {
    ...receipt,
    rankingStatus: reranked ? "reranked" : "unchanged",
    rankingCode: reranked ? "ranking_changed" : "ranking_unchanged",
    currentRetrievalRank: rank ?? null,
  };
};

const aggregateReceipt = (
  capsule: ContextCapsuleV1,
  indexFingerprint: string,
  evidence: EvidenceReceipt[]
): ContextCapsuleVerification => {
  const contentStatus = evidence.some(
    (item) => item.contentStatus === "missing"
  )
    ? "missing"
    : evidence.some((item) => item.contentStatus === "stale")
      ? "stale"
      : "unchanged";
  const rankingStatus = evidence.some(
    (item) => item.rankingStatus === "unavailable"
  )
    ? "unavailable"
    : evidence.some((item) => item.rankingStatus === "reranked")
      ? "reranked"
      : "unchanged";
  return contextCapsuleVerificationSchema.parse({
    schemaVersion: capsule.schemaVersion,
    coordinateSpace: capsule.coordinateSpace,
    capsuleId: capsule.capsuleId,
    operationStatus: "completed",
    contentStatus,
    contentCode:
      contentStatus === "missing"
        ? "content_missing"
        : contentStatus === "stale"
          ? "content_stale"
          : "verified_unchanged",
    rankingStatus,
    rankingCode:
      rankingStatus === "unavailable"
        ? "ranking_unavailable"
        : rankingStatus === "reranked"
          ? "ranking_changed"
          : "ranking_unchanged",
    indexSnapshot: {
      before: indexFingerprint,
      after: indexFingerprint,
      stable: true,
    },
    evidence,
  });
};

/** Verify a Capsule without rebuilding it or mutating caller-owned input. */
export const verifyContextCapsule = async (
  input: unknown,
  deps: ContextVerifierDeps
): Promise<ContextCapsuleVerification> => {
  const options = { countTokens: deps.countTokens };
  const capsule = parseContextCapsuleV1(input, options);
  const inputBytesBefore = canonicalContextCapsuleJson(capsule);
  const before = await captureContextEvidenceSnapshot(
    deps.store,
    capsule.scope.indexName,
    capsule.scope.collections
  );
  const evidenceUris = new Set(capsule.evidence.map((item) => item.uri));
  const referencedDocuments = before.documents.filter((document) =>
    evidenceUris.has(document.uri)
  );
  const docids = [
    ...new Set(
      referencedDocuments.map((document) => deriveDocid(document.sourceHash))
    ),
  ];
  const mirrorHashes = [
    ...new Set(
      referencedDocuments.flatMap((document) =>
        document.mirrorHash === null ? [] : [document.mirrorHash]
      )
    ),
  ];
  const [documentResult, contentResult, chunkResult, rankResult] =
    await Promise.all([
      deps.store.getDocumentsByDocids(docids, { activeOnly: true }),
      deps.store.getContentBatch(mirrorHashes),
      deps.store.getChunksBatch(mirrorHashes),
      deps.resolveCurrentRanks?.(structuredClone(capsule)).catch(() => null) ??
        Promise.resolve(null),
    ]);
  const loaded: LoadedEvidence = {
    snapshot: before,
    documents: unwrapStore(
      documentResult,
      "document_load_failed",
      "Failed to batch-load verification documents"
    ),
    contentByHash: unwrapStore(
      contentResult,
      "content_load_failed",
      "Failed to batch-load verification mirrors"
    ),
    chunksByHash: unwrapStore(
      chunkResult,
      "chunk_load_failed",
      "Failed to batch-load verification chunks"
    ),
  };
  const after = await captureContextEvidenceSnapshot(
    deps.store,
    capsule.scope.indexName,
    capsule.scope.collections
  );
  if (before.indexFingerprint !== after.indexFingerprint) {
    throw new ContextVerifierError(
      "index_changed_during_verify",
      "Index changed while Context Capsule verification was running"
    );
  }
  if (before.contextFingerprint !== after.contextFingerprint) {
    throw new ContextVerifierError(
      "context_changed_during_verify",
      "Configured contexts changed while Context Capsule verification was running"
    );
  }
  const inputBytesAfter = canonicalContextCapsuleJson(input);
  if (inputBytesBefore !== inputBytesAfter) {
    throw new ContextVerifierError(
      "capsule_mutated_during_verify",
      "Context Capsule input changed while verification was running"
    );
  }

  const fingerprintsDrifted = !fingerprintsMatch(
    deps.currentFingerprints,
    capsule.fingerprints
  );
  const indexDrifted =
    before.indexFingerprint !== capsule.retrieval.indexSnapshot.after;
  const evidence = capsule.evidence.map((item) =>
    applyRanking(
      verifyContent(item, loaded, capsule.scope.indexName),
      item,
      rankResult,
      fingerprintsDrifted,
      indexDrifted
    )
  );
  return aggregateReceipt(capsule, before.indexFingerprint, evidence);
};

/** Canonical JSON projection for cross-surface receipt parity. */
export const canonicalContextCapsuleVerificationJson = (
  input: unknown
): string => canonicalJson(contextCapsuleVerificationSchema.parse(input));
