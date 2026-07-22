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
  StorePort,
  StoreResult,
} from "../store/types";
import type { EphemeralActivationProbePlan } from "./activation-probe-plan";

import { err, ok } from "../store/types";
import {
  extractActivationProbeTerms,
  fingerprintActivationIndex,
} from "./activation-probe";
import {
  createEphemeralActivationProbePlan,
  findEphemeralActivationProbeMatch,
  populateEphemeralActivationProbePlan,
  revalidateEphemeralActivationProbePlan,
} from "./activation-probe-plan";
import { persistActivationReceiptForKnownCollection } from "./activation-receipt-store";

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
const REUSABLE_NEGATIVE_CODES = new Set<ActivationVerificationCode>([
  "no_documents",
  "no_probe_term",
  "index_out_of_sync",
]);
const MAX_VERIFICATION_ATTEMPTS = 2;
const CONCURRENT_INDEX_CHANGE_MESSAGE =
  "Activation index changed repeatedly during verification; retry";
export interface ActivationVerifierOptions {
  /** Re-run proof instead of reusing a current fingerprint-matched receipt. */
  force?: boolean;
  now?: () => Date;
  monotonicNow?: () => number;
  /** Precomputed, in-memory plan used to fingerprint-scope coalesced callers. */
  plan?: EphemeralActivationProbePlan;
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

function isReusableLexicalReceipt(
  receipt: ActivationVerificationReceipt
): boolean {
  if (receipt.ready) {
    return true;
  }
  const code = receipt.stages.index.code ?? receipt.stages.lexical.code;
  return code !== undefined && REUSABLE_NEGATIVE_CODES.has(code);
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
  return persistActivationReceiptForKnownCollection(store, receipt);
}

interface ActivationVerificationAttempt {
  receipt: ActivationVerificationReceipt;
  cached: boolean;
}

async function verifyLexicalActivationAttempt(
  store: StorePort,
  collection: string,
  plan: EphemeralActivationProbePlan,
  options: ActivationVerifierOptions
): Promise<StoreResult<ActivationVerificationAttempt>> {
  const now = options.now ?? (() => new Date());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const indexStartedAt = now().toISOString();
  const indexStartedClock = monotonicNow();
  const { activeDocuments, fingerprint } = plan;

  if (!options.force) {
    const current = await store.getActivationReceipt(collection, fingerprint);
    if (!current.ok) {
      return err(
        current.error.code,
        current.error.message,
        current.error.cause
      );
    }
    // Deterministic negatives are stable for this exact fingerprint. Query and
    // result mismatches remain recoverable and are retried without a TTL.
    if (current.value && isReusableLexicalReceipt(current.value)) {
      return ok({ receipt: current.value, cached: true });
    }
  }

  const indexCompletedAt = now().toISOString();
  if (activeDocuments.length === 0) {
    return ok({
      cached: false,
      receipt: buildReceipt({
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
      }),
    });
  }

  if (!plan.identity.ftsSynchronized) {
    return ok({
      cached: false,
      receipt: buildReceipt({
        collection,
        fingerprint,
        generatedAt: indexCompletedAt,
        index: completedStage(
          "failed",
          indexStartedAt,
          indexCompletedAt,
          elapsedMs(indexStartedClock, monotonicNow),
          "index_out_of_sync"
        ),
        lexical: completedStage(
          "skipped",
          null,
          indexCompletedAt,
          null,
          "index_out_of_sync"
        ),
      }),
    });
  }

  const indexStage = completedStage(
    "passed",
    indexStartedAt,
    indexCompletedAt,
    elapsedMs(indexStartedClock, monotonicNow)
  );
  const lexicalStartedAt = now().toISOString();
  const lexicalStartedClock = monotonicNow();
  const populatedPlan = await populateEphemeralActivationProbePlan(store, plan);
  const matchResult = populatedPlan.ok
    ? await findEphemeralActivationProbeMatch(store, populatedPlan.value)
    : populatedPlan;
  const completedAt = now().toISOString();

  if (!matchResult.ok) {
    return ok({
      cached: false,
      receipt: buildReceipt({
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
      }),
    });
  }

  const match = matchResult.value;
  if (match.kind === "no_probe_term") {
    return ok({
      cached: false,
      receipt: buildReceipt({
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
      }),
    });
  }

  if (match.kind === "matched") {
    return ok({
      cached: false,
      receipt: buildReceipt({
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
        probeHash: match.value.probeHash,
        result: {
          uri: match.value.resultUri,
          sourceHash: match.value.resultSourceHash,
        },
      }),
    });
  }

  return ok({
    cached: false,
    receipt: buildReceipt({
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
      probeHash: match.probeHash,
    }),
  });
}

async function discardObsoleteLexicalReceipt(
  store: StorePort,
  collection: string,
  currentFingerprint: string
): Promise<StoreResult<void>> {
  const current = await store.getActivationReceipt(
    collection,
    currentFingerprint
  );
  return current.ok
    ? ok(undefined)
    : err(current.error.code, current.error.message, current.error.cause);
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
  const planResult =
    options.plan?.collection === collection
      ? ok(options.plan)
      : await createEphemeralActivationProbePlan(store, collection, {
          collectCandidates: false,
        });
  if (!planResult.ok) {
    return planResult;
  }
  let plan = planResult.value;

  for (let attempt = 0; attempt < MAX_VERIFICATION_ATTEMPTS; attempt += 1) {
    const verification = await verifyLexicalActivationAttempt(
      store,
      collection,
      plan,
      options
    );
    if (!verification.ok) {
      return verification;
    }

    const beforeAcceptance = await revalidateEphemeralActivationProbePlan(
      store,
      plan
    );
    if (!beforeAcceptance.ok) {
      return beforeAcceptance;
    }
    if (!beforeAcceptance.value.stable) {
      plan = beforeAcceptance.value.currentPlan;
      continue;
    }

    if (verification.value.cached) {
      return ok(verification.value.receipt);
    }

    // A configured collection may be checked before its first sync has created
    // the store row. The persistence helper returns the bounded receipt without
    // violating the receipt table's collection foreign key.
    const persisted = await persistReceipt(store, verification.value.receipt);
    if (!persisted.ok) {
      return persisted;
    }
    const afterPersistence = await revalidateEphemeralActivationProbePlan(
      store,
      plan
    );
    if (!afterPersistence.ok) {
      return afterPersistence;
    }
    if (afterPersistence.value.stable) {
      return persisted;
    }

    plan = afterPersistence.value.currentPlan;
  }

  const cleanup = await discardObsoleteLexicalReceipt(
    store,
    collection,
    plan.fingerprint
  );
  if (!cleanup.ok) {
    return cleanup;
  }
  return err("INTERNAL", CONCURRENT_INDEX_CHANGE_MESSAGE);
}
