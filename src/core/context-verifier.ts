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
  ContextCapsuleContractError,
  parseContextCapsuleV1,
  type ContextCapsuleCreateOptions,
} from "./context-capsule";
import { sha256Text } from "./context-capsule-validation";
import {
  CONTEXT_CAPSULE_FINGERPRINT_DRIFT_REASONS,
  contextCapsuleVerificationSchema,
} from "./context-capsule-verification";
import {
  captureContextEvidenceSnapshot,
  type ContextEvidenceSnapshot,
} from "./context-evidence";
import {
  canonicalVerifierJson,
  hasNoncanonicalVerifierText,
} from "./context-verifier-canonical";
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

const missingMirrorReceipt = (
  evidence: Evidence,
  sourceHash: string,
  mirrorHash: string | null
): EvidenceReceipt => ({
  evidenceId: evidence.evidenceId,
  uri: evidence.uri,
  contentStatus: "missing",
  contentCode: "mirror_missing",
  rankingStatus: "unavailable",
  rankingCode: "ranking_unavailable",
  currentSourceHash: sourceHash,
  currentMirrorHash: mirrorHash,
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
  if (!identity) return missingReceipt(evidence);
  if (!identity.mirrorHash) {
    return missingMirrorReceipt(evidence, identity.sourceHash, null);
  }
  const document = matchingDocument(
    loaded.documents,
    evidence.uri,
    identity.sourceHash,
    identity.mirrorHash,
    indexName
  );
  const currentSourceHash = document?.sourceHash ?? identity.sourceHash;
  const registeredMirrorHash = document?.mirrorHash ?? identity.mirrorHash;
  const content = loaded.contentByHash.get(registeredMirrorHash);
  if (content === undefined) {
    return missingMirrorReceipt(
      evidence,
      currentSourceHash,
      registeredMirrorHash
    );
  }

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
  const chunks = loaded.chunksByHash.get(registeredMirrorHash);
  const chunk = chunks?.find(
    (candidate) =>
      candidate.mirrorHash === registeredMirrorHash &&
      candidate.startLine === evidence.startLine &&
      candidate.endLine === evidence.endLine &&
      chunkMatchesCanonicalContent(candidate, content)
  );
  const chunkValid = chunk !== undefined;

  let contentCode: EvidenceReceipt["contentCode"] = "verified_unchanged";
  if (currentSourceHash !== evidence.sourceHash) {
    contentCode = "source_stale";
  } else if (
    currentMirrorHash !== registeredMirrorHash ||
    content.includes("\r")
  ) {
    contentCode = "mirror_corrupt";
  } else if (registeredMirrorHash !== evidence.mirrorHash) {
    contentCode = "mirror_stale";
  } else if (
    exactPassage === null ||
    currentPassageHash !== evidence.passageHash
  ) {
    contentCode = "passage_stale";
  } else if (!chunks || chunks.length === 0) {
    contentCode = "chunk_missing";
  } else if (!chunkValid) {
    contentCode = "chunk_corrupt";
  }

  return {
    evidenceId: evidence.evidenceId,
    uri: evidence.uri,
    contentStatus: contentCode === "verified_unchanged" ? "unchanged" : "stale",
    contentCode,
    rankingStatus: "unavailable",
    rankingCode: "ranking_unavailable",
    currentSourceHash,
    currentMirrorHash,
    currentPassageHash,
    currentRetrievalRank: null,
  };
};

const applyRanking = (
  receipt: EvidenceReceipt,
  evidence: Evidence,
  currentRanks: ReadonlyMap<string, number> | null
): EvidenceReceipt => {
  if (receipt.contentStatus !== "unchanged") return receipt;
  const rank = currentRanks?.get(evidence.evidenceId);
  if (!Number.isSafeInteger(rank) || (rank ?? 0) < 1) return receipt;
  const reranked = rank !== evidence.retrievalRank;
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
  currentFingerprints: ContextVerifierFingerprints,
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
  const reasons = fingerprintReasons(
    capsule,
    currentFingerprints,
    indexFingerprint
  );
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
    currentFingerprints: {
      ...currentFingerprints,
      index: indexFingerprint,
    },
    fingerprintStatus: reasons.length === 0 ? "unchanged" : "drifted",
    fingerprintReasons: reasons,
    indexSnapshot: {
      before: indexFingerprint,
      after: indexFingerprint,
      stable: true,
    },
    evidence,
  });
};

const fingerprintReasons = (
  capsule: ContextCapsuleV1,
  current: ContextVerifierFingerprints,
  indexFingerprint: string
): (typeof CONTEXT_CAPSULE_FINGERPRINT_DRIFT_REASONS)[number][] => {
  const changed = {
    config_changed: current.config !== capsule.fingerprints.config,
    retrieval_changed: current.retrieval !== capsule.fingerprints.retrieval,
    embedding_model_changed:
      current.embeddingModel !== capsule.fingerprints.embeddingModel,
    rerank_model_changed:
      current.rerankModel !== capsule.fingerprints.rerankModel,
    tokenizer_changed: current.tokenizer !== capsule.fingerprints.tokenizer,
    index_changed: indexFingerprint !== capsule.retrieval.indexSnapshot.after,
  } satisfies Record<
    (typeof CONTEXT_CAPSULE_FINGERPRINT_DRIFT_REASONS)[number],
    boolean
  >;
  return CONTEXT_CAPSULE_FINGERPRINT_DRIFT_REASONS.filter(
    (reason) => changed[reason]
  );
};

const rawCanonicalJson = (input: unknown): string => {
  try {
    return canonicalVerifierJson(input);
  } catch (cause) {
    throw new ContextCapsuleContractError(
      "invalid_input",
      "Context Capsule input must be canonical JSON",
      { cause }
    );
  }
};

/** Verify a Capsule without rebuilding it or mutating caller-owned input. */
export const verifyContextCapsule = async (
  input: unknown,
  deps: ContextVerifierDeps
): Promise<ContextCapsuleVerification> => {
  const options = { countTokens: deps.countTokens };
  const rawInputBefore = rawCanonicalJson(input);
  if (hasNoncanonicalVerifierText(input)) {
    throw new ContextCapsuleContractError(
      "invalid_input",
      "Context Capsule input must already use NFC text and LF line endings"
    );
  }
  const capsule = parseContextCapsuleV1(input, options);
  if (rawInputBefore !== canonicalContextCapsuleJson(capsule)) {
    throw new ContextCapsuleContractError(
      "invalid_input",
      "Context Capsule input must already use its canonical semantic representation"
    );
  }
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
  const rawInputAfter = rawCanonicalJson(input);
  if (rawInputBefore !== rawInputAfter) {
    throw new ContextVerifierError(
      "capsule_mutated_during_verify",
      "Context Capsule input changed while verification was running"
    );
  }

  const evidence = capsule.evidence.map((item) =>
    applyRanking(
      verifyContent(item, loaded, capsule.scope.indexName),
      item,
      rankResult
    )
  );
  return aggregateReceipt(
    capsule,
    before.indexFingerprint,
    deps.currentFingerprints,
    evidence
  );
};

/** Canonical JSON projection for cross-surface receipt parity. */
export const canonicalContextCapsuleVerificationJson = (
  input: unknown
): string =>
  canonicalVerifierJson(contextCapsuleVerificationSchema.parse(input));
