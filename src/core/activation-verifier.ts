/**
 * Deterministic, local-only retrieval activation verification.
 *
 * Probe terms exist only in memory. Persisted receipts contain a SHA-256 probe
 * hash plus exact result identity, never the query, snippet, or passage.
 */

import type {
  ActivationStageReceipt,
  ActivationVerificationCode,
  ActivationVerificationReceipt,
  DocumentRow,
  StorePort,
  StoreResult,
} from "../store/types";

import { err, ok } from "../store/types";
import {
  extractActivationProbeTerms,
  fingerprintActivationIndex,
} from "./activation-probe";

export {
  extractActivationProbeTerms,
  fingerprintActivationIndex,
} from "./activation-probe";

export type {
  ActivationStageName,
  ActivationStageReceipt,
  ActivationStageStatus,
  ActivationVerificationCode,
  ActivationVerificationReceipt,
} from "../store/types";

const RECEIPT_SCHEMA_VERSION = "1.0" as const;
const MAX_PROBE_DOCUMENTS = 16;
const MAX_PROBE_ATTEMPTS = 64;
const PROBE_RESULT_LIMIT = 8;

interface ProbeCandidate {
  term: string;
  mirrorHash: string;
  document: DocumentRow;
  occurrence: number;
}

export interface ActivationVerifierOptions {
  /** Re-run proof instead of reusing a current fingerprint-matched receipt. */
  force?: boolean;
  now?: () => Date;
  monotonicNow?: () => number;
}

function sha256(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function elapsedMs(startedAt: number, monotonicNow: () => number): number {
  return Math.max(0, Math.round(monotonicNow() - startedAt));
}

function completedStage(
  status: "passed" | "failed" | "skipped",
  startedAt: string | null,
  completedAt: string,
  latencyMs: number | null,
  code?: ActivationVerificationCode
): ActivationStageReceipt {
  return {
    status,
    startedAt,
    completedAt,
    latencyMs,
    ...(code ? { code } : {}),
  };
}

function pendingStage(
  status: "pending" | "skipped",
  code: ActivationVerificationCode
): ActivationStageReceipt {
  return {
    status,
    startedAt: null,
    completedAt: null,
    latencyMs: null,
    code,
  };
}

function buildReceipt(input: {
  collection: string;
  fingerprint: string;
  generatedAt: string;
  index: ActivationStageReceipt;
  lexical: ActivationStageReceipt;
  probeHash?: string;
  result?: { uri: string; sourceHash: string };
}): ActivationVerificationReceipt {
  const ready =
    input.index.status === "passed" && input.lexical.status === "passed";
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    collection: input.collection,
    fingerprint: input.fingerprint,
    ready,
    generatedAt: input.generatedAt,
    stages: {
      index: input.index,
      lexical: input.lexical,
      semantic: pendingStage("pending", "semantic_not_checked"),
      connector: pendingStage("skipped", "connector_not_requested"),
    },
    evidence: {
      ...(input.probeHash ? { probeHash: input.probeHash } : {}),
      ...(input.result
        ? {
            resultUri: input.result.uri,
            resultSourceHash: input.result.sourceHash,
          }
        : {}),
    },
  };
}

async function persistReceipt(
  store: StorePort,
  receipt: ActivationVerificationReceipt
): Promise<StoreResult<ActivationVerificationReceipt>> {
  const persisted = await store.upsertActivationReceipt(receipt);
  if (!persisted.ok) {
    return err(
      persisted.error.code,
      persisted.error.message,
      persisted.error.cause
    );
  }
  return ok(receipt);
}

async function collectProbeCandidates(
  store: StorePort,
  documents: DocumentRow[]
): Promise<StoreResult<ProbeCandidate[]>> {
  const candidates: ProbeCandidate[] = [];
  for (const document of documents.slice(0, MAX_PROBE_DOCUMENTS)) {
    if (!document.mirrorHash) {
      continue;
    }
    const content = await store.getContent(document.mirrorHash);
    if (!content.ok) {
      return err(
        content.error.code,
        content.error.message,
        content.error.cause
      );
    }
    if (content.value === null) {
      continue;
    }
    const terms = extractActivationProbeTerms(content.value);
    for (const [occurrence, term] of terms.entries()) {
      candidates.push({
        term,
        mirrorHash: document.mirrorHash,
        document,
        occurrence,
      });
    }
  }

  const documentFrequency = new Map<string, number>();
  const termsByDocument = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const terms = termsByDocument.get(candidate.document.uri) ?? new Set();
    terms.add(candidate.term);
    termsByDocument.set(candidate.document.uri, terms);
  }
  for (const terms of termsByDocument.values()) {
    for (const term of terms) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  candidates.sort((left, right) => {
    const frequencyDifference =
      (documentFrequency.get(left.term) ?? 0) -
      (documentFrequency.get(right.term) ?? 0);
    if (frequencyDifference !== 0) {
      return frequencyDifference;
    }
    const uriDifference = compareText(left.document.uri, right.document.uri);
    if (uriDifference !== 0) {
      return uriDifference;
    }
    if (left.occurrence !== right.occurrence) {
      return left.occurrence - right.occurrence;
    }
    return compareText(left.term, right.term);
  });
  return ok(candidates.slice(0, MAX_PROBE_ATTEMPTS));
}

/**
 * Prove that one collection can retrieve a deterministic corpus-derived term.
 * The verifier never loads embeddings or sends content outside the local store.
 */
export async function verifyLexicalActivation(
  store: StorePort,
  collection: string,
  options: ActivationVerifierOptions = {}
): Promise<StoreResult<ActivationVerificationReceipt>> {
  const now = options.now ?? (() => new Date());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const indexStartedAt = now().toISOString();
  const indexStartedClock = monotonicNow();

  const [identityResult, documentsResult] = await Promise.all([
    store.getActivationIndexIdentity(),
    store.listDocuments(collection),
  ]);
  if (!identityResult.ok) {
    return err(
      identityResult.error.code,
      identityResult.error.message,
      identityResult.error.cause
    );
  }
  if (!documentsResult.ok) {
    return err(
      documentsResult.error.code,
      documentsResult.error.message,
      documentsResult.error.cause
    );
  }

  const activeDocuments = documentsResult.value
    .filter((document) => document.active)
    .sort((left, right) => {
      const uriDifference = compareText(left.uri, right.uri);
      return uriDifference === 0 ? left.id - right.id : uriDifference;
    });
  const identity = identityResult.value;
  const fingerprint = fingerprintActivationIndex({
    collection,
    indexName: identity.indexName,
    schemaVersion: identity.schemaVersion,
    ftsTokenizer: identity.ftsTokenizer,
    documents: activeDocuments,
  });

  if (!options.force) {
    const current = await store.getActivationReceipt(collection, fingerprint);
    if (!current.ok) {
      return err(
        current.error.code,
        current.error.message,
        current.error.cause
      );
    }
    if (current.value) {
      return ok(current.value);
    }
  }

  const indexCompletedAt = now().toISOString();
  if (activeDocuments.length === 0) {
    const receipt = buildReceipt({
      collection,
      fingerprint,
      generatedAt: indexCompletedAt,
      index: completedStage(
        "failed",
        indexStartedAt,
        indexCompletedAt,
        elapsedMs(indexStartedClock, monotonicNow),
        "no_documents"
      ),
      lexical: completedStage(
        "skipped",
        null,
        indexCompletedAt,
        null,
        "no_documents"
      ),
    });
    return persistReceipt(store, receipt);
  }

  const indexStage = completedStage(
    "passed",
    indexStartedAt,
    indexCompletedAt,
    elapsedMs(indexStartedClock, monotonicNow)
  );
  const lexicalStartedAt = now().toISOString();
  const lexicalStartedClock = monotonicNow();
  const candidatesResult = await collectProbeCandidates(store, activeDocuments);
  if (!candidatesResult.ok) {
    const completedAt = now().toISOString();
    return persistReceipt(
      store,
      buildReceipt({
        collection,
        fingerprint,
        generatedAt: completedAt,
        index: indexStage,
        lexical: completedStage(
          "failed",
          lexicalStartedAt,
          completedAt,
          elapsedMs(lexicalStartedClock, monotonicNow),
          "index_query_failed"
        ),
      })
    );
  }

  const candidates = candidatesResult.value;
  if (candidates.length === 0) {
    const completedAt = now().toISOString();
    return persistReceipt(
      store,
      buildReceipt({
        collection,
        fingerprint,
        generatedAt: completedAt,
        index: indexStage,
        lexical: completedStage(
          "failed",
          lexicalStartedAt,
          completedAt,
          elapsedMs(lexicalStartedClock, monotonicNow),
          "no_probe_term"
        ),
      })
    );
  }

  let finalProbeHash: string | undefined;
  for (const candidate of candidates) {
    finalProbeHash = sha256(`${candidate.mirrorHash}\0${candidate.term}`);
    const search = await store.searchFts(candidate.term, {
      collection,
      limit: PROBE_RESULT_LIMIT,
      snippet: false,
    });
    if (!search.ok) {
      const completedAt = now().toISOString();
      return persistReceipt(
        store,
        buildReceipt({
          collection,
          fingerprint,
          generatedAt: completedAt,
          index: indexStage,
          lexical: completedStage(
            "failed",
            lexicalStartedAt,
            completedAt,
            elapsedMs(lexicalStartedClock, monotonicNow),
            "index_query_failed"
          ),
          probeHash: finalProbeHash,
        })
      );
    }
    const expected = search.value.find(
      (result) =>
        result.uri === candidate.document.uri &&
        result.sourceHash === candidate.document.sourceHash &&
        result.mirrorHash === candidate.document.mirrorHash
    );
    if (!expected) {
      continue;
    }

    const completedAt = now().toISOString();
    return persistReceipt(
      store,
      buildReceipt({
        collection,
        fingerprint,
        generatedAt: completedAt,
        index: indexStage,
        lexical: completedStage(
          "passed",
          lexicalStartedAt,
          completedAt,
          elapsedMs(lexicalStartedClock, monotonicNow)
        ),
        probeHash: finalProbeHash,
        result: {
          uri: expected.uri ?? candidate.document.uri,
          sourceHash: expected.sourceHash ?? candidate.document.sourceHash,
        },
      })
    );
  }

  const completedAt = now().toISOString();
  return persistReceipt(
    store,
    buildReceipt({
      collection,
      fingerprint,
      generatedAt: completedAt,
      index: indexStage,
      lexical: completedStage(
        "failed",
        lexicalStartedAt,
        completedAt,
        elapsedMs(lexicalStartedClock, monotonicNow),
        "retrieval_mismatch"
      ),
      probeHash: finalProbeHash,
    })
  );
}
