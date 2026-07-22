/**
 * Ephemeral activation probe planning shared by local and connector proofs.
 *
 * Raw probe terms never leave this in-memory plan and must not be serialized,
 * logged, or copied into activation receipts.
 */

import type { FtsTokenizer } from "../config/types";
import type {
  ActivationIndexDocument,
  ActivationIndexIdentity,
  StorePort,
  StoreResult,
} from "../store/types";

import { err, ok } from "../store/types";
import {
  extractActivationProbeTerms,
  fingerprintActivationIndex,
} from "./activation-probe";

const MAX_PROBE_DOCUMENTS = 16;
const MAX_PROBE_DOCUMENT_SCANS = 64;
const MAX_PROBE_ATTEMPTS = 64;
const MAX_PROBE_CONTENT_CHARS = 32_768;
const PROBE_RESULT_LIMIT = 8;

interface ProbeDocumentReference {
  document: ActivationIndexDocument;
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
  activeDocuments: ActivationIndexDocument[];
  candidates: EphemeralActivationProbeCandidate[];
}

export interface EphemeralActivationProbeMatch {
  /** Sensitive corpus-derived term. Never serialize or log. */
  term: string;
  probeHash: string;
  resultUri: string;
  resultSourceHash: string;
}

export interface ActivationProbePlanRevalidation {
  stable: boolean;
  currentPlan: EphemeralActivationProbePlan;
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
  documents: ActivationIndexDocument[],
  ftsTokenizer: FtsTokenizer
): Promise<StoreResult<EphemeralActivationProbeCandidate[]>> {
  const probeDocuments: ProbeDocumentCandidates[] = [];
  let probeDocumentReads = 0;
  for (const document of documents) {
    if (!document.mirrorHash) {
      continue;
    }
    if (probeDocumentReads >= MAX_PROBE_DOCUMENT_SCANS) {
      break;
    }
    probeDocumentReads += 1;
    const content = await store.getContentPrefix(
      document.mirrorHash,
      MAX_PROBE_CONTENT_CHARS
    );
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
  const snapshotResult = await store.getActivationIndexSnapshot(collection);
  if (!snapshotResult.ok) {
    return err(
      snapshotResult.error.code,
      snapshotResult.error.message,
      snapshotResult.error.cause
    );
  }
  const { documents, identity } = snapshotResult.value;
  const activeDocuments = documents
    .filter((document) => document.active)
    .sort((left, right) => {
      const uriDifference = compareText(left.uri, right.uri);
      return uriDifference === 0 ? left.id - right.id : uriDifference;
    });
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

/**
 * Re-read the metadata-only activation snapshot and compare it with a plan
 * created before an asynchronous proof. Callers use this optimistic guard
 * immediately before accepting or persisting proof derived from that plan.
 */
export async function revalidateEphemeralActivationProbePlan(
  store: StorePort,
  plan: EphemeralActivationProbePlan
): Promise<StoreResult<ActivationProbePlanRevalidation>> {
  const current = await createEphemeralActivationProbePlan(
    store,
    plan.collection,
    { collectCandidates: false }
  );
  if (!current.ok) {
    return current;
  }
  return ok({
    stable: current.value.fingerprint === plan.fingerprint,
    currentPlan: current.value,
  });
}

export async function findEphemeralActivationProbeMatch(
  store: StorePort,
  plan: EphemeralActivationProbePlan
): Promise<StoreResult<ActivationProbeMatchResult>> {
  if (plan.candidates.length === 0) {
    return ok({ kind: "no_probe_term" });
  }

  const activeDocumentsByUri = new Map(
    plan.activeDocuments.map((document) => [document.uri, document])
  );
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
    const matchedResult = search.value.find((result) => {
      const activeDocument = result.uri
        ? activeDocumentsByUri.get(result.uri)
        : undefined;
      return (
        activeDocument !== undefined &&
        activeDocument.mirrorHash !== null &&
        result.sourceHash === activeDocument.sourceHash &&
        result.mirrorHash === activeDocument.mirrorHash
      );
    });
    if (!matchedResult) {
      continue;
    }
    const matchedDocument = matchedResult.uri
      ? activeDocumentsByUri.get(matchedResult.uri)
      : undefined;
    if (!matchedDocument) {
      continue;
    }
    return ok({
      kind: "matched",
      value: {
        term: candidate.term,
        probeHash: finalProbeHash,
        resultUri: matchedResult.uri ?? matchedDocument.uri,
        resultSourceHash:
          matchedResult.sourceHash ?? matchedDocument.sourceHash,
      },
    });
  }
  return ok({ kind: "retrieval_mismatch", probeHash: finalProbeHash });
}
