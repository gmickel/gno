/**
 * Ephemeral activation probe planning shared by local and connector proofs.
 *
 * Raw probe terms never leave this in-memory plan and must not be serialized,
 * logged, or copied into activation receipts.
 */

import type { FtsTokenizer } from "../config/types";
import type {
  ActivationIndexIdentity,
  DocumentRow,
  StorePort,
  StoreResult,
} from "../store/types";

import { err, ok } from "../store/types";
import {
  extractActivationProbeTerms,
  fingerprintActivationIndex,
} from "./activation-probe";

const MAX_PROBE_DOCUMENTS = 16;
const MAX_PROBE_ATTEMPTS = 64;
const PROBE_RESULT_LIMIT = 8;

interface ProbeDocumentReference {
  document: DocumentRow;
  mirrorHash: string;
}

interface ProbeDocumentCandidates extends ProbeDocumentReference {
  terms: Array<{ term: string; occurrence: number }>;
}

export interface EphemeralActivationProbeCandidate {
  /** Sensitive corpus-derived term. Never serialize or log. */
  term: string;
  documents: ProbeDocumentReference[];
}

export interface EphemeralActivationProbePlan {
  collection: string;
  fingerprint: string;
  identity: ActivationIndexIdentity;
  activeDocuments: DocumentRow[];
  candidates: EphemeralActivationProbeCandidate[];
}

export interface EphemeralActivationProbeMatch {
  /** Sensitive corpus-derived term. Never serialize or log. */
  term: string;
  probeHash: string;
  resultUri: string;
  resultSourceHash: string;
}

export type ActivationProbeMatchResult =
  | { kind: "matched"; value: EphemeralActivationProbeMatch }
  | { kind: "no_probe_term" }
  | { kind: "retrieval_mismatch"; probeHash?: string };

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

async function collectProbeCandidates(
  store: StorePort,
  documents: DocumentRow[],
  ftsTokenizer: FtsTokenizer
): Promise<StoreResult<EphemeralActivationProbeCandidate[]>> {
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

  const candidates: EphemeralActivationProbeCandidate[] = [];
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

export async function createEphemeralActivationProbePlan(
  store: StorePort,
  collection: string,
  options: { collectCandidates?: boolean } = {}
): Promise<StoreResult<EphemeralActivationProbePlan>> {
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
  const candidates =
    options.collectCandidates === false
      ? ok([])
      : await collectProbeCandidates(
          store,
          activeDocuments,
          identity.ftsTokenizer
        );
  if (!candidates.ok) {
    return candidates;
  }
  return ok({
    collection,
    fingerprint,
    identity,
    activeDocuments,
    candidates: candidates.value,
  });
}

export async function populateEphemeralActivationProbePlan(
  store: StorePort,
  plan: EphemeralActivationProbePlan
): Promise<StoreResult<EphemeralActivationProbePlan>> {
  const candidates = await collectProbeCandidates(
    store,
    plan.activeDocuments,
    plan.identity.ftsTokenizer
  );
  if (!candidates.ok) {
    return candidates;
  }
  return ok({ ...plan, candidates: candidates.value });
}

export async function findEphemeralActivationProbeMatch(
  store: StorePort,
  plan: EphemeralActivationProbePlan
): Promise<StoreResult<ActivationProbeMatchResult>> {
  if (plan.candidates.length === 0) {
    return ok({ kind: "no_probe_term" });
  }

  let finalProbeHash: string | undefined;
  for (const candidate of plan.candidates) {
    const digestKey = candidate.documents
      .map(({ mirrorHash }) => mirrorHash)
      .sort(compareText)
      .join("\0");
    finalProbeHash = sha256(`${digestKey}\0${candidate.term}`);
    const search = await store.searchFts(candidate.term, {
      collection: plan.collection,
      limit: PROBE_RESULT_LIMIT,
      snippet: false,
    });
    if (!search.ok) {
      return err(search.error.code, search.error.message, search.error.cause);
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
    return ok({
      kind: "matched",
      value: {
        term: candidate.term,
        probeHash: finalProbeHash,
        resultUri: matchedResult.uri ?? matchedDocument.document.uri,
        resultSourceHash:
          matchedResult.sourceHash ?? matchedDocument.document.sourceHash,
      },
    });
  }
  return ok({ kind: "retrieval_mismatch", probeHash: finalProbeHash });
}
