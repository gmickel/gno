/** Non-generative reverification for metadata-only saved Capsule records. */

import type { ContextCapsuleRuntimeDeps } from "../app/context-runtime";
import type {
  SavedCapsuleRegistrationRecord,
  SavedCapsuleTriggerKind,
  SavedCapsuleVerificationRecord,
  StorePort,
  StoreResult,
} from "../store/types";
import type { ContextCapsuleVerification } from "./context-capsule";

import { DEFAULT_INDEX_NAME } from "../app/constants";
import {
  canonicalVerifiedContextCapsuleJson,
  verifyContextCapsuleRuntime,
} from "../app/context-runtime";
import { canonicalizeIndexName } from "../app/index-name";
import {
  getSavedCapsule,
  loadSavedCapsuleFile,
  SavedCapsuleRegistryError,
} from "./capsule-registry";
import { decodeDocumentChangeCursor } from "./change-journal";
import { sha256Text } from "./context-capsule-validation";

type ReverificationStore = StorePort &
  ContextCapsuleRuntimeDeps["store"] &
  Pick<
    StorePort,
    | "getSavedCapsuleRegistration"
    | "listDocumentChanges"
    | "upsertSavedCapsuleVerification"
  >;

const MAX_REGISTRATION_CONFLICT_ATTEMPTS = 2;

export interface SavedCapsuleReverificationNotification {
  type: "capsule-reverified";
  registrationId: string;
  capsuleId: string;
  operationStatus: "completed" | "failed";
  affectedQuestionState: "unaffected" | "affected" | "unknown";
  changedAt: string;
}

export interface SavedCapsuleReverificationOutcome {
  registration: SavedCapsuleRegistrationRecord;
  verification: SavedCapsuleVerificationRecord;
  receipt: ContextCapsuleVerification | null;
}

export interface SavedCapsuleReverificationDeps extends Omit<
  ContextCapsuleRuntimeDeps,
  "store" | "indexName"
> {
  store: ReverificationStore;
  indexName: string;
  now?: () => number;
  notify?: (event: SavedCapsuleReverificationNotification) => void;
}

export interface SavedCapsuleReverificationTrigger {
  kind: SavedCapsuleTriggerKind;
  fromSequence: number;
  throughSequence: number;
}

const unwrapStore = <T>(result: StoreResult<T>, operation: string): T => {
  if (result.ok) return result.value;
  throw new SavedCapsuleRegistryError(
    "store_failed",
    `${operation}: ${result.error.message}`,
    result.error.cause
  );
};

const currentSequence = async (store: ReverificationStore): Promise<number> => {
  const page = unwrapStore(
    await store.listDocumentChanges({ limit: 1 }),
    "Failed to read document change journal"
  );
  return decodeDocumentChangeCursor(page.latestCursor);
};

const affected = (
  receipt: ContextCapsuleVerification
): {
  state: "unaffected" | "affected";
  reasons: string[];
} => {
  const reasons: string[] = [];
  if (receipt.contentStatus === "stale") reasons.push("content_stale");
  if (receipt.contentStatus === "missing") reasons.push("content_missing");
  if (receipt.rankingStatus === "reranked") reasons.push("ranking_changed");
  if (receipt.fingerprintStatus === "drifted") {
    reasons.push("fingerprint_changed");
  }
  return {
    state: reasons.length === 0 ? "unaffected" : "affected",
    reasons,
  };
};

const errorIdentity = (error: unknown): { code: string; message: string } => {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return { code: error.code, message: error.message.slice(0, 4096) };
  }
  return {
    code: "verification_failed",
    message: (error instanceof Error
      ? error.message
      : "Saved Capsule verification failed"
    ).slice(0, 4096),
  };
};

const persist = async (
  deps: SavedCapsuleReverificationDeps,
  registration: SavedCapsuleRegistrationRecord,
  verification: SavedCapsuleVerificationRecord
): Promise<boolean> => {
  const persisted = unwrapStore(
    await deps.store.upsertSavedCapsuleVerification(verification, {
      capsuleId: registration.capsuleId,
      fileHash: registration.fileHash,
    }),
    "Failed to persist saved Context Capsule verification"
  );
  if (!persisted) return false;
  if (registration.notificationPreference === "local") {
    deps.notify?.({
      type: "capsule-reverified",
      registrationId: registration.registrationId,
      capsuleId: registration.capsuleId,
      operationStatus: verification.operationStatus,
      affectedQuestionState: verification.affectedQuestionState,
      changedAt: new Date(verification.verifiedAtMs).toISOString(),
    });
  }
  return true;
};

const reverifySavedCapsuleAttempt = async (
  registrationId: string,
  trigger: SavedCapsuleReverificationTrigger,
  deps: SavedCapsuleReverificationDeps
): Promise<SavedCapsuleReverificationOutcome | null> => {
  const registration = await getSavedCapsule(deps.store, registrationId);
  const runtimeIndex = canonicalizeIndexName(
    deps.indexName || DEFAULT_INDEX_NAME
  );
  const verifiedAtMs = (deps.now ?? Date.now)();
  let receipt: ContextCapsuleVerification | null = null;
  let verification: SavedCapsuleVerificationRecord;
  try {
    if (runtimeIndex !== registration.indexName) {
      throw Object.assign(
        new Error(
          `Saved Context Capsule index ${registration.indexName} does not match runtime index ${runtimeIndex}`
        ),
        { code: "invalid_filter" }
      );
    }
    const loaded = await loadSavedCapsuleFile(
      registration.filePath,
      registration.fileHash
    );
    if (loaded.capsule.capsuleId !== registration.capsuleId) {
      throw Object.assign(
        new Error("Saved Context Capsule file changed after registration"),
        { code: "capsule_file_changed" }
      );
    }
    receipt = await verifyContextCapsuleRuntime(loaded.capsule, {
      ...deps,
      store: deps.store,
      indexName: runtimeIndex,
    });
    const receiptJson = canonicalVerifiedContextCapsuleJson(receipt);
    const projection = affected(receipt);
    verification = {
      registrationId,
      triggerKind: trigger.kind,
      fromSequence: trigger.fromSequence,
      throughSequence: trigger.throughSequence,
      operationStatus: "completed",
      affectedQuestionState: projection.state,
      affectedReasons: projection.reasons,
      receiptJson,
      receiptHash: sha256Text(receiptJson),
      errorCode: null,
      errorMessage: null,
      verifiedAtMs,
    };
  } catch (error) {
    const failure = errorIdentity(error);
    verification = {
      registrationId,
      triggerKind: trigger.kind,
      fromSequence: trigger.fromSequence,
      throughSequence: trigger.throughSequence,
      operationStatus: "failed",
      affectedQuestionState: "unknown",
      affectedReasons: [],
      receiptJson: null,
      receiptHash: null,
      errorCode: failure.code,
      errorMessage: failure.message,
      verifiedAtMs,
    };
  }
  if (!(await persist(deps, registration, verification))) return null;
  const refreshed = await getSavedCapsule(deps.store, registrationId);
  return { registration: refreshed, verification, receipt };
};

export const reverifySavedCapsule = async (
  registrationId: string,
  trigger: SavedCapsuleReverificationTrigger,
  deps: SavedCapsuleReverificationDeps
): Promise<SavedCapsuleReverificationOutcome> => {
  for (
    let attempt = 0;
    attempt < MAX_REGISTRATION_CONFLICT_ATTEMPTS;
    attempt += 1
  ) {
    const outcome = await reverifySavedCapsuleAttempt(
      registrationId,
      trigger,
      deps
    );
    if (outcome) return outcome;
  }
  throw new SavedCapsuleRegistryError(
    "store_failed",
    "Saved Context Capsule registration changed repeatedly during verification"
  );
};

export const reverifySavedCapsuleManually = async (
  registrationId: string,
  deps: SavedCapsuleReverificationDeps
): Promise<SavedCapsuleReverificationOutcome> => {
  const sequence = await currentSequence(deps.store);
  const registration = await getSavedCapsule(deps.store, registrationId);
  return reverifySavedCapsule(
    registrationId,
    {
      kind: "manual",
      fromSequence: registration.lastAttemptedSequence,
      throughSequence: sequence,
    },
    deps
  );
};
