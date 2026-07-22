/**
 * Deterministic, local-only retrieval activation verification.
 *
 * Probe terms exist only in memory. Persisted receipts contain a SHA-256 probe
 * hash plus exact result identity, never the query, snippet, or passage.
 */

import type { FtsTokenizer } from "../config/types";
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
  documents: ProbeDocumentReference[];
}

interface ProbeDocumentReference {
  document: DocumentRow;
  mirrorHash: string;
}

interface ProbeDocumentCandidates extends ProbeDocumentReference {
  terms: Array<{ term: string; occurrence: number }>;
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
  documents: DocumentRow[],
  ftsTokenizer: FtsTokenizer
): Promise<StoreResult<ProbeCandidate[]>> {
  const probeDocuments: ProbeDocumentCandidates[] = [];
  for (const document of documents) {
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
    const terms = extractActivationProbeTerms(content.value, ftsTokenizer);
    if (terms.length === 0) {
      continue;
    }
    probeDocuments.push({
      document,
      mirrorHash: document.mirrorHash,
      terms: terms.map((term, occurrence) => ({ term, occurrence })),
    });
    if (probeDocuments.length >= MAX_PROBE_DOCUMENTS) {
      break;
    }
  }

  const documentsByTerm = new Map<string, ProbeDocumentReference[]>();
  for (const probeDocument of probeDocuments) {
    for (const { term } of probeDocument.terms) {
      const references = documentsByTerm.get(term) ?? [];
      references.push({
        document: probeDocument.document,
        mirrorHash: probeDocument.mirrorHash,
      });
      documentsByTerm.set(term, references);
    }
  }

  for (const probeDocument of probeDocuments) {
    probeDocument.terms.sort((left, right) => {
      const frequencyDifference =
        (documentsByTerm.get(left.term)?.length ?? 0) -
        (documentsByTerm.get(right.term)?.length ?? 0);
      if (frequencyDifference !== 0) {
        return frequencyDifference;
      }
      if (left.occurrence !== right.occurrence) {
        return left.occurrence - right.occurrence;
      }
      return compareText(left.term, right.term);
    });
  }

  const candidates: ProbeCandidate[] = [];
  const seenTerms = new Set<string>();
  const rounds = Math.max(
    0,
    ...probeDocuments.map(({ terms }) => terms.length)
  );
  for (let round = 0; round < rounds; round += 1) {
    for (const probeDocument of probeDocuments) {
      const term = probeDocument.terms[round]?.term;
      if (!term || seenTerms.has(term)) {
        continue;
      }
      seenTerms.add(term);
      candidates.push({
        term,
        documents: documentsByTerm.get(term) ?? [],
      });
      if (candidates.length >= MAX_PROBE_ATTEMPTS) {
        return ok(candidates);
      }
    }
  }
  return ok(candidates);
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
    store.getActivationIndexIdentity(collection),
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
    ftsStateHash: identity.ftsStateHash,
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
  const candidatesResult = await collectProbeCandidates(
    store,
    activeDocuments,
    identity.ftsTokenizer
  );
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
    const digestKey = candidate.documents
      .map(({ mirrorHash }) => mirrorHash)
      .sort(compareText)
      .join("\0");
    finalProbeHash = sha256(`${digestKey}\0${candidate.term}`);
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
    const matchedResult = search.value.find((result) =>
      candidate.documents.some(
        ({ document, mirrorHash }) =>
          result.uri === document.uri &&
          result.sourceHash === document.sourceHash &&
          result.mirrorHash === mirrorHash
      )
    );
    if (!matchedResult) {
      continue;
    }
    const matchedDocument = candidate.documents.find(
      ({ document, mirrorHash }) =>
        matchedResult.uri === document.uri &&
        matchedResult.sourceHash === document.sourceHash &&
        matchedResult.mirrorHash === mirrorHash
    );
    if (!matchedDocument) {
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
          uri: matchedResult.uri ?? matchedDocument.document.uri,
          sourceHash:
            matchedResult.sourceHash ?? matchedDocument.document.sourceHash,
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
