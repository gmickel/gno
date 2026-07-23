/** SQLite persistence for metadata-only saved Context Capsules. */

import type { Database } from "bun:sqlite";

import type {
  SavedCapsuleEvidenceReference,
  SavedCapsuleRegistration,
  SavedCapsuleRegistrationInput,
  SavedCapsuleRegistrationRecord,
  SavedCapsuleRegistrationSnapshot,
  SavedCapsuleReverificationState,
  SavedCapsuleVerificationExpectation,
  SavedCapsuleVerificationRecord,
  StoreResult,
} from "../types";

import { err, ok } from "../types";

const MAX_REGISTRATIONS = 10_000;

interface DbRegistration {
  registration_id: string;
  file_path: string;
  file_hash: string;
  capsule_id: string;
  index_name: string;
  question: string | null;
  label: string | null;
  notification_preference: "none" | "local";
  registered_at_ms: number;
  updated_at_ms: number;
  last_attempted_sequence: number;
}

interface DbEvidence {
  registration_id: string;
  evidence_id: string;
  canonical_uri: string;
  collection: string;
  source_hash: string;
  mirror_hash: string;
  passage_hash: string;
}

interface DbVerification {
  registration_id: string;
  trigger_kind: "manual" | "journal";
  from_sequence: number;
  through_sequence: number;
  operation_status: "completed" | "failed";
  affected_question_state: "unaffected" | "affected" | "unknown";
  affected_reasons_json: string;
  receipt_json: string | null;
  receipt_hash: string | null;
  error_code: string | null;
  error_message: string | null;
  verified_at_ms: number;
}

const mapRegistration = (row: DbRegistration): SavedCapsuleRegistration => ({
  registrationId: row.registration_id,
  filePath: row.file_path,
  fileHash: row.file_hash,
  capsuleId: row.capsule_id,
  indexName: row.index_name,
  question: row.question,
  label: row.label,
  notificationPreference: row.notification_preference,
  registeredAtMs: row.registered_at_ms,
  updatedAtMs: row.updated_at_ms,
  lastAttemptedSequence: row.last_attempted_sequence,
});

const mapEvidence = (row: DbEvidence): SavedCapsuleEvidenceReference => ({
  evidenceId: row.evidence_id,
  canonicalUri: row.canonical_uri,
  collection: row.collection,
  sourceHash: row.source_hash,
  mirrorHash: row.mirror_hash,
  passageHash: row.passage_hash,
});

const mapVerification = (
  row: DbVerification
): SavedCapsuleVerificationRecord => ({
  registrationId: row.registration_id,
  triggerKind: row.trigger_kind,
  fromSequence: row.from_sequence,
  throughSequence: row.through_sequence,
  operationStatus: row.operation_status,
  affectedQuestionState: row.affected_question_state,
  affectedReasons: JSON.parse(row.affected_reasons_json) as string[],
  receiptJson: row.receipt_json,
  receiptHash: row.receipt_hash,
  errorCode: row.error_code,
  errorMessage: row.error_message,
  verifiedAtMs: row.verified_at_ms,
});

const loadRecords = (
  db: Database,
  registrationId?: string
): SavedCapsuleRegistrationRecord[] => {
  const registrations = registrationId
    ? db
        .query<DbRegistration, [string]>(
          `SELECT * FROM saved_capsule_registrations
           WHERE registration_id = ?`
        )
        .all(registrationId)
    : db
        .query<DbRegistration, []>(
          `SELECT * FROM saved_capsule_registrations
           ORDER BY registration_id ASC`
        )
        .all();
  if (registrations.length === 0) return [];
  const evidence = registrationId
    ? db
        .query<DbEvidence, [string]>(
          `SELECT * FROM saved_capsule_evidence
           WHERE registration_id = ?
           ORDER BY evidence_id ASC`
        )
        .all(registrationId)
    : db
        .query<DbEvidence, []>(
          `SELECT * FROM saved_capsule_evidence
           ORDER BY registration_id ASC, evidence_id ASC`
        )
        .all();
  const verifications = registrationId
    ? db
        .query<DbVerification, [string]>(
          `SELECT * FROM saved_capsule_verifications
           WHERE registration_id = ?`
        )
        .all(registrationId)
    : db
        .query<DbVerification, []>(
          `SELECT * FROM saved_capsule_verifications
           ORDER BY registration_id ASC`
        )
        .all();
  const evidenceByRegistration = new Map<
    string,
    SavedCapsuleEvidenceReference[]
  >();
  for (const row of evidence) {
    const values = evidenceByRegistration.get(row.registration_id) ?? [];
    values.push(mapEvidence(row));
    evidenceByRegistration.set(row.registration_id, values);
  }
  const verificationByRegistration = new Map(
    verifications.map((row) => [row.registration_id, mapVerification(row)])
  );
  return registrations.map((row) => ({
    ...mapRegistration(row),
    evidence: evidenceByRegistration.get(row.registration_id) ?? [],
    verification: verificationByRegistration.get(row.registration_id) ?? null,
  }));
};

export const upsertSavedCapsuleRegistration = (
  db: Database,
  input: SavedCapsuleRegistrationInput
): StoreResult<SavedCapsuleRegistrationRecord> => {
  try {
    const transaction = db.transaction(() => {
      const count = db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM saved_capsule_registrations"
        )
        .get()?.count;
      const exists = db
        .query<{ found: number }, [string]>(
          `SELECT 1 AS found FROM saved_capsule_registrations
           WHERE registration_id = ?`
        )
        .get(input.registrationId);
      if (!exists && (count ?? 0) >= MAX_REGISTRATIONS) {
        throw new RangeError("Saved Capsule registration limit reached");
      }
      db.run(
        `UPDATE saved_capsule_reverification_state
         SET last_processed_sequence = MIN(last_processed_sequence, ?),
             registration_epoch = registration_epoch + 1
         WHERE singleton_id = 1`,
        [input.lastAttemptedSequence]
      );
      const registrationGeneration = db
        .query<{ registration_epoch: number }, []>(
          `SELECT registration_epoch
           FROM saved_capsule_reverification_state
           WHERE singleton_id = 1`
        )
        .get()?.registration_epoch;
      if (registrationGeneration === undefined) {
        throw new Error("Saved Capsule reverification state is missing");
      }
      db.run(
        `INSERT INTO saved_capsule_registrations (
           registration_id, file_path, file_hash, capsule_id, index_name,
           question, label, notification_preference, registered_at_ms,
           updated_at_ms, last_attempted_sequence, registration_generation
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(registration_id) DO UPDATE SET
           file_path = excluded.file_path,
           file_hash = excluded.file_hash,
           capsule_id = excluded.capsule_id,
           index_name = excluded.index_name,
           question = excluded.question,
           label = excluded.label,
           notification_preference = excluded.notification_preference,
           updated_at_ms = excluded.updated_at_ms,
           last_attempted_sequence = excluded.last_attempted_sequence,
           registration_generation = excluded.registration_generation`,
        [
          input.registrationId,
          input.filePath,
          input.fileHash,
          input.capsuleId,
          input.indexName,
          input.question,
          input.label,
          input.notificationPreference,
          input.registeredAtMs,
          input.updatedAtMs,
          input.lastAttemptedSequence,
          registrationGeneration,
        ]
      );
      db.run("DELETE FROM saved_capsule_evidence WHERE registration_id = ?", [
        input.registrationId,
      ]);
      const insertEvidence = db.prepare(
        `INSERT INTO saved_capsule_evidence (
           registration_id, evidence_id, canonical_uri, collection,
           source_hash, mirror_hash, passage_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const evidence of input.evidence) {
        insertEvidence.run(
          input.registrationId,
          evidence.evidenceId,
          evidence.canonicalUri,
          evidence.collection,
          evidence.sourceHash,
          evidence.mirrorHash,
          evidence.passageHash
        );
      }
      db.run(
        "DELETE FROM saved_capsule_verifications WHERE registration_id = ?",
        [input.registrationId]
      );
      return loadRecords(db, input.registrationId)[0]!;
    });
    return ok(transaction());
  } catch (cause) {
    return err(
      cause instanceof RangeError ? "INVALID_INPUT" : "QUERY_FAILED",
      cause instanceof Error
        ? cause.message
        : "Failed to register saved Context Capsule",
      cause
    );
  }
};

export const listSavedCapsuleRegistrations = (
  db: Database
): StoreResult<SavedCapsuleRegistrationRecord[]> => {
  try {
    return ok(loadRecords(db));
  } catch (cause) {
    return err("QUERY_FAILED", "Failed to list saved Context Capsules", cause);
  }
};

export const getSavedCapsuleRegistration = (
  db: Database,
  registrationId: string
): StoreResult<SavedCapsuleRegistrationRecord | null> => {
  try {
    return ok(loadRecords(db, registrationId)[0] ?? null);
  } catch (cause) {
    return err("QUERY_FAILED", "Failed to read saved Context Capsule", cause);
  }
};

export const getSavedCapsuleRegistrationSnapshot = (
  db: Database,
  registrationId: string
): StoreResult<SavedCapsuleRegistrationSnapshot | null> => {
  try {
    const transaction = db.transaction(() => {
      const registration = loadRecords(db, registrationId)[0];
      if (!registration) return null;
      const registrationGeneration = db
        .query<{ registration_generation: number }, [string]>(
          `SELECT registration_generation
           FROM saved_capsule_registrations
           WHERE registration_id = ?`
        )
        .get(registrationId)?.registration_generation;
      if (registrationGeneration === undefined) return null;
      return { registration, registrationGeneration };
    });
    return ok(transaction());
  } catch (cause) {
    return err(
      "QUERY_FAILED",
      "Failed to read saved Context Capsule verification snapshot",
      cause
    );
  }
};

export const deleteSavedCapsuleRegistration = (
  db: Database,
  registrationId: string
): StoreResult<boolean> => {
  try {
    return ok(
      db.run(
        "DELETE FROM saved_capsule_registrations WHERE registration_id = ?",
        [registrationId]
      ).changes > 0
    );
  } catch (cause) {
    return err("QUERY_FAILED", "Failed to remove saved Context Capsule", cause);
  }
};

export const listSavedCapsuleIdsAffectedByChanges = (
  db: Database,
  afterSequence: number,
  throughSequence: number,
  limit: number
): StoreResult<{ registrationIds: string[]; truncated: boolean }> => {
  try {
    if (
      !Number.isSafeInteger(afterSequence) ||
      !Number.isSafeInteger(throughSequence) ||
      afterSequence < 0 ||
      throughSequence < afterSequence ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_REGISTRATIONS
    ) {
      return err("INVALID_INPUT", "Invalid saved Capsule change range");
    }
    const rows = db
      .query<{ registration_id: string }, [number, number, number]>(
        `SELECT DISTINCT evidence.registration_id
         FROM saved_capsule_evidence evidence
         INNER JOIN saved_capsule_registrations registration
           ON registration.registration_id = evidence.registration_id
         INNER JOIN document_changes change
           ON (
             evidence.canonical_uri = change.old_uri
             OR evidence.canonical_uri = change.new_uri
             OR evidence.source_hash = change.old_source_hash
             OR evidence.source_hash = change.new_source_hash
             OR evidence.mirror_hash = change.old_mirror_hash
             OR evidence.mirror_hash = change.new_mirror_hash
           )
         WHERE change.sequence > ?
           AND change.sequence > registration.last_attempted_sequence
           AND change.sequence <= ?
         ORDER BY evidence.registration_id ASC
         LIMIT ?`
      )
      .all(afterSequence, throughSequence, limit + 1);
    return ok({
      registrationIds: rows.slice(0, limit).map((row) => row.registration_id),
      truncated: rows.length > limit,
    });
  } catch (cause) {
    return err(
      "QUERY_FAILED",
      "Failed to resolve affected saved Context Capsules",
      cause
    );
  }
};

export const upsertSavedCapsuleVerification = (
  db: Database,
  verification: SavedCapsuleVerificationRecord,
  expectedRegistration: SavedCapsuleVerificationExpectation
): StoreResult<boolean> => {
  try {
    const transaction = db.transaction(() => {
      const registrationMatches = db
        .query<{ found: number }, [string, number]>(
          `SELECT 1 AS found
           FROM saved_capsule_registrations
           WHERE registration_id = ?
             AND registration_generation = ?`
        )
        .get(
          verification.registrationId,
          expectedRegistration.registrationGeneration
        );
      if (!registrationMatches) return false;

      db.run(
        `INSERT INTO saved_capsule_verifications (
           registration_id, trigger_kind, from_sequence, through_sequence,
           operation_status, affected_question_state, affected_reasons_json,
           receipt_json, receipt_hash, error_code, error_message, verified_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(registration_id) DO UPDATE SET
           trigger_kind = excluded.trigger_kind,
           from_sequence = excluded.from_sequence,
           through_sequence = excluded.through_sequence,
           operation_status = excluded.operation_status,
           affected_question_state = excluded.affected_question_state,
           affected_reasons_json = excluded.affected_reasons_json,
           receipt_json = excluded.receipt_json,
           receipt_hash = excluded.receipt_hash,
           error_code = excluded.error_code,
           error_message = excluded.error_message,
           verified_at_ms = excluded.verified_at_ms`,
        [
          verification.registrationId,
          verification.triggerKind,
          verification.fromSequence,
          verification.throughSequence,
          verification.operationStatus,
          verification.affectedQuestionState,
          JSON.stringify(verification.affectedReasons),
          verification.receiptJson,
          verification.receiptHash,
          verification.errorCode,
          verification.errorMessage,
          verification.verifiedAtMs,
        ]
      );
      db.run(
        `UPDATE saved_capsule_registrations
         SET last_attempted_sequence = MAX(last_attempted_sequence, ?),
             updated_at_ms = MAX(updated_at_ms, ?)
         WHERE registration_id = ?
           AND registration_generation = ?`,
        [
          verification.throughSequence,
          verification.verifiedAtMs,
          verification.registrationId,
          expectedRegistration.registrationGeneration,
        ]
      );
      return true;
    });
    return ok(transaction());
  } catch (cause) {
    return err(
      "QUERY_FAILED",
      "Failed to persist saved Context Capsule verification",
      cause
    );
  }
};

export const getSavedCapsuleReverificationSequence = (
  db: Database
): StoreResult<number> => {
  try {
    return ok(
      db
        .query<{ last_processed_sequence: number }, []>(
          `SELECT last_processed_sequence
           FROM saved_capsule_reverification_state WHERE singleton_id = 1`
        )
        .get()?.last_processed_sequence ?? 0
    );
  } catch (cause) {
    return err("QUERY_FAILED", "Failed to read reverification state", cause);
  }
};

export const getSavedCapsuleReverificationState = (
  db: Database
): StoreResult<SavedCapsuleReverificationState> => {
  try {
    const row = db
      .query<
        {
          last_processed_sequence: number;
          registration_epoch: number;
        },
        []
      >(
        `SELECT last_processed_sequence, registration_epoch
         FROM saved_capsule_reverification_state WHERE singleton_id = 1`
      )
      .get();
    return ok({
      lastProcessedSequence: row?.last_processed_sequence ?? 0,
      registrationEpoch: row?.registration_epoch ?? 0,
    });
  } catch (cause) {
    return err("QUERY_FAILED", "Failed to read reverification state", cause);
  }
};

export const setSavedCapsuleReverificationSequence = (
  db: Database,
  sequence: number,
  expectedRegistrationEpoch: number
): StoreResult<boolean> => {
  try {
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      !Number.isSafeInteger(expectedRegistrationEpoch) ||
      expectedRegistrationEpoch < 0
    ) {
      return err("INVALID_INPUT", "Invalid reverification sequence");
    }
    const updated = db.run(
      `UPDATE saved_capsule_reverification_state
       SET last_processed_sequence = MAX(last_processed_sequence, ?)
       WHERE singleton_id = 1
         AND registration_epoch = ?`,
      [sequence, expectedRegistrationEpoch]
    ).changes;
    return ok(updated > 0);
  } catch (cause) {
    return err("QUERY_FAILED", "Failed to update reverification state", cause);
  }
};
