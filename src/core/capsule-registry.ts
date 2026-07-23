/** Metadata-only registry for explicitly saved Context Capsule files. */

// node:path resolve has no Bun path utility equivalent.
import { resolve } from "node:path";

import type {
  SavedCapsuleNotificationPreference,
  SavedCapsuleRegistrationRecord,
  StorePort,
  StoreResult,
} from "../store/types";
import type { ContextCapsuleV1 } from "./context-capsule";

import { DEFAULT_INDEX_NAME, stripUriIndex } from "../app/constants";
import { canonicalizeIndexName } from "../app/index-name";
import { decodeDocumentChangeCursor } from "./change-journal";
import { sha256Text } from "./context-capsule-validation";
import { parseCanonicalContextCapsuleForVerification } from "./context-verifier";
import { canonicalVerifierJson } from "./context-verifier-canonical";

const MAX_CAPSULE_BYTES = 16 * 1024 * 1024;
const MAX_EVIDENCE_REFERENCES = 10_000;
const MAX_QUESTION_BYTES = 8192;
const MAX_LABEL_BYTES = 512;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

type RegistryStore = Pick<
  StorePort,
  | "deleteSavedCapsuleRegistration"
  | "getSavedCapsuleRegistration"
  | "listDocumentChanges"
  | "listSavedCapsuleRegistrations"
  | "upsertSavedCapsuleRegistration"
>;

export type SavedCapsuleRegistryErrorCode =
  | "capsule_file_changed"
  | "capsule_file_missing"
  | "capsule_file_too_large"
  | "capsule_read_failed"
  | "invalid_filter"
  | "invalid_metadata"
  | "registration_not_found"
  | "store_failed";

export class SavedCapsuleRegistryError extends Error {
  readonly code: SavedCapsuleRegistryErrorCode;

  constructor(
    code: SavedCapsuleRegistryErrorCode,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SavedCapsuleRegistryError";
    this.code = code;
  }
}

export interface RegisterSavedCapsuleInput {
  filePath: string;
  question?: string;
  label?: string;
  notificationPreference?: SavedCapsuleNotificationPreference;
}

export interface LoadedSavedCapsule {
  capsule: ContextCapsuleV1;
  fileHash: string;
  filePath: string;
  raw: string;
}

const unwrapStore = <T>(result: StoreResult<T>, operation: string): T => {
  if (result.ok) return result.value;
  throw new SavedCapsuleRegistryError(
    "store_failed",
    `${operation}: ${result.error.message}`,
    result.error.cause
  );
};

const boundedOptionalText = (
  value: string | undefined,
  field: "question" | "label",
  maxBytes: number
): string | null => {
  if (value === undefined) return null;
  const normalized = value.trim().normalize("NFC");
  if (
    normalized.length === 0 ||
    UTF8_ENCODER.encode(normalized).byteLength > maxBytes
  ) {
    throw new SavedCapsuleRegistryError(
      "invalid_metadata",
      `${field} must be non-empty and at most ${maxBytes} UTF-8 bytes`
    );
  }
  return normalized;
};

export const loadSavedCapsuleFile = async (
  filePath: string,
  expectedFileHash?: string
): Promise<LoadedSavedCapsule> => {
  const canonicalPath = resolve(filePath);
  const file = Bun.file(canonicalPath);
  if (!(await file.exists())) {
    throw new SavedCapsuleRegistryError(
      "capsule_file_missing",
      "Saved Context Capsule file is missing"
    );
  }
  if (file.size < 1 || file.size > MAX_CAPSULE_BYTES) {
    throw new SavedCapsuleRegistryError(
      "capsule_file_too_large",
      `Saved Context Capsule must be between 1 and ${MAX_CAPSULE_BYTES} bytes`
    );
  }
  try {
    const raw = UTF8_DECODER.decode(await file.arrayBuffer());
    const fileHash = sha256Text(raw);
    if (expectedFileHash !== undefined && fileHash !== expectedFileHash) {
      throw new SavedCapsuleRegistryError(
        "capsule_file_changed",
        "Saved Context Capsule file changed after registration"
      );
    }
    const capsule = parseCanonicalContextCapsuleForVerification(
      JSON.parse(raw) as unknown
    );
    if (capsule.evidence.length > MAX_EVIDENCE_REFERENCES) {
      throw new SavedCapsuleRegistryError(
        "capsule_file_too_large",
        `Saved Context Capsule exceeds ${MAX_EVIDENCE_REFERENCES} evidence references`
      );
    }
    return {
      capsule,
      fileHash,
      filePath: canonicalPath,
      raw,
    };
  } catch (cause) {
    if (cause instanceof SavedCapsuleRegistryError) throw cause;
    throw new SavedCapsuleRegistryError(
      "capsule_read_failed",
      cause instanceof Error
        ? `Saved Context Capsule is invalid: ${cause.message}`
        : "Saved Context Capsule is invalid",
      cause
    );
  }
};

const assertRuntimeIndex = (
  capsule: ContextCapsuleV1,
  runtimeIndexName: string
): string => {
  const effective = canonicalizeIndexName(
    runtimeIndexName || DEFAULT_INDEX_NAME
  );
  if (effective !== capsule.scope.indexName) {
    throw new SavedCapsuleRegistryError(
      "invalid_filter",
      `Context Capsule index ${capsule.scope.indexName} does not match runtime index ${effective}`
    );
  }
  return effective;
};

const latestSequence = async (store: RegistryStore): Promise<number> => {
  const page = unwrapStore(
    await store.listDocumentChanges({ limit: 1 }),
    "Failed to read the document change journal"
  );
  return decodeDocumentChangeCursor(page.latestCursor);
};

/** Register an explicit file without persisting or rewriting its body. */
export const registerSavedCapsule = async (
  store: RegistryStore,
  runtimeIndexName: string,
  input: RegisterSavedCapsuleInput,
  nowMs: number = Date.now()
): Promise<SavedCapsuleRegistrationRecord> => {
  // Capture the conservative high-water mark before reading the caller-owned
  // file. Any journal change concurrent with file loading then remains newer
  // than the registration and cannot be skipped by the resident scheduler.
  const sequence = await latestSequence(store);
  const loaded = await loadSavedCapsuleFile(input.filePath);
  const indexName = assertRuntimeIndex(loaded.capsule, runtimeIndexName);
  const registrationId = `capsule-${sha256Text(loaded.filePath).slice(0, 40)}`;
  const existing = unwrapStore(
    await store.getSavedCapsuleRegistration(registrationId),
    "Failed to read saved Context Capsule registration"
  );
  return unwrapStore(
    await store.upsertSavedCapsuleRegistration({
      registrationId,
      filePath: loaded.filePath,
      fileHash: loaded.fileHash,
      capsuleId: loaded.capsule.capsuleId,
      indexName,
      question: boundedOptionalText(
        input.question,
        "question",
        MAX_QUESTION_BYTES
      ),
      label: boundedOptionalText(input.label, "label", MAX_LABEL_BYTES),
      notificationPreference: input.notificationPreference ?? "none",
      registeredAtMs: existing?.registeredAtMs ?? nowMs,
      updatedAtMs: nowMs,
      lastAttemptedSequence: sequence,
      evidence: loaded.capsule.evidence
        .map((evidence) => ({
          evidenceId: evidence.evidenceId,
          canonicalUri: stripUriIndex(evidence.uri),
          collection: evidence.collection,
          sourceHash: evidence.sourceHash,
          mirrorHash: evidence.mirrorHash,
          passageHash: evidence.passageHash,
        }))
        .sort((left, right) =>
          left.evidenceId < right.evidenceId
            ? -1
            : left.evidenceId > right.evidenceId
              ? 1
              : 0
        ),
    }),
    "Failed to register saved Context Capsule"
  );
};

export const listSavedCapsules = async (
  store: RegistryStore
): Promise<SavedCapsuleRegistrationRecord[]> =>
  unwrapStore(
    await store.listSavedCapsuleRegistrations(),
    "Failed to list saved Context Capsules"
  );

export const getSavedCapsule = async (
  store: RegistryStore,
  registrationId: string
): Promise<SavedCapsuleRegistrationRecord> => {
  const registration = unwrapStore(
    await store.getSavedCapsuleRegistration(registrationId),
    "Failed to read saved Context Capsule"
  );
  if (!registration) {
    throw new SavedCapsuleRegistryError(
      "registration_not_found",
      "Saved Context Capsule registration not found"
    );
  }
  return registration;
};

export const unregisterSavedCapsule = async (
  store: RegistryStore,
  registrationId: string
): Promise<void> => {
  const deleted = unwrapStore(
    await store.deleteSavedCapsuleRegistration(registrationId),
    "Failed to remove saved Context Capsule"
  );
  if (!deleted) {
    throw new SavedCapsuleRegistryError(
      "registration_not_found",
      "Saved Context Capsule registration not found"
    );
  }
};

export const canonicalSavedCapsuleRegistryJson = (value: unknown): string =>
  canonicalVerifierJson(value);
