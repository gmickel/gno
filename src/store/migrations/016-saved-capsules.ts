/**
 * Migration: metadata-only saved Context Capsule registry.
 *
 * Capsule bodies remain user-owned files. The database stores only file and
 * Capsule identities, evidence references, the latest verification outcome,
 * and the journal high-water sequence used by the resident scheduler.
 *
 * @module src/store/migrations/016-saved-capsules
 */

import type { Database } from "bun:sqlite";

import type { Migration } from "./runner";

export const migration: Migration = {
  version: 16,
  name: "saved_capsules",

  up(db: Database): void {
    db.exec(`
      CREATE TABLE saved_capsule_registrations (
        registration_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL UNIQUE,
        file_hash TEXT NOT NULL,
        capsule_id TEXT NOT NULL,
        index_name TEXT NOT NULL,
        question TEXT,
        label TEXT,
        notification_preference TEXT NOT NULL DEFAULT 'none'
          CHECK (notification_preference IN ('none', 'local')),
        registered_at_ms INTEGER NOT NULL CHECK (registered_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= registered_at_ms),
        last_attempted_sequence INTEGER NOT NULL DEFAULT 0
          CHECK (last_attempted_sequence >= 0),
        CHECK (length(registration_id) BETWEEN 1 AND 128),
        CHECK (length(CAST(file_path AS BLOB)) BETWEEN 1 AND 8192),
        CHECK (length(file_hash) = 64 AND file_hash NOT GLOB '*[^0-9a-f]*'),
        CHECK (length(capsule_id) = 64 AND capsule_id NOT GLOB '*[^0-9a-f]*'),
        CHECK (length(CAST(index_name AS BLOB)) BETWEEN 1 AND 128),
        CHECK (question IS NULL OR length(CAST(question AS BLOB)) <= 8192),
        CHECK (label IS NULL OR length(CAST(label AS BLOB)) <= 512)
      );

      CREATE INDEX idx_saved_capsules_index
      ON saved_capsule_registrations(index_name, registration_id);

      CREATE TABLE saved_capsule_evidence (
        registration_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        canonical_uri TEXT NOT NULL,
        collection TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        mirror_hash TEXT NOT NULL,
        passage_hash TEXT NOT NULL,
        PRIMARY KEY (registration_id, evidence_id),
        FOREIGN KEY (registration_id)
          REFERENCES saved_capsule_registrations(registration_id)
          ON DELETE CASCADE,
        CHECK (length(evidence_id) = 64 AND evidence_id NOT GLOB '*[^0-9a-f]*'),
        CHECK (length(CAST(canonical_uri AS BLOB)) BETWEEN 1 AND 8192),
        CHECK (length(CAST(collection AS BLOB)) BETWEEN 1 AND 256),
        CHECK (length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*'),
        CHECK (length(mirror_hash) = 64 AND mirror_hash NOT GLOB '*[^0-9a-f]*'),
        CHECK (length(passage_hash) = 64 AND passage_hash NOT GLOB '*[^0-9a-f]*')
      );

      CREATE INDEX idx_saved_capsule_evidence_uri
      ON saved_capsule_evidence(canonical_uri, registration_id);

      CREATE INDEX idx_saved_capsule_evidence_source
      ON saved_capsule_evidence(source_hash, registration_id);

      CREATE INDEX idx_saved_capsule_evidence_mirror
      ON saved_capsule_evidence(mirror_hash, registration_id);

      CREATE TABLE saved_capsule_verifications (
        registration_id TEXT PRIMARY KEY,
        trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('manual', 'journal')),
        from_sequence INTEGER NOT NULL CHECK (from_sequence >= 0),
        through_sequence INTEGER NOT NULL
          CHECK (through_sequence >= from_sequence),
        operation_status TEXT NOT NULL CHECK (operation_status IN ('completed', 'failed')),
        affected_question_state TEXT NOT NULL
          CHECK (affected_question_state IN ('unaffected', 'affected', 'unknown')),
        affected_reasons_json TEXT NOT NULL,
        receipt_json TEXT,
        receipt_hash TEXT,
        error_code TEXT,
        error_message TEXT,
        verified_at_ms INTEGER NOT NULL CHECK (verified_at_ms >= 0),
        FOREIGN KEY (registration_id)
          REFERENCES saved_capsule_registrations(registration_id)
          ON DELETE CASCADE,
        CHECK (length(CAST(affected_reasons_json AS BLOB)) <= 4096),
        CHECK (receipt_json IS NULL OR length(CAST(receipt_json AS BLOB)) <= 16777216),
        CHECK (receipt_hash IS NULL OR (
          length(receipt_hash) = 64 AND receipt_hash NOT GLOB '*[^0-9a-f]*'
        )),
        CHECK (error_code IS NULL OR length(CAST(error_code AS BLOB)) <= 256),
        CHECK (error_message IS NULL OR length(CAST(error_message AS BLOB)) <= 4096),
        CHECK (
          (
            operation_status = 'completed'
            AND receipt_json IS NOT NULL
            AND receipt_hash IS NOT NULL
            AND error_code IS NULL
            AND error_message IS NULL
          )
          OR
          (
            operation_status = 'failed'
            AND receipt_json IS NULL
            AND receipt_hash IS NULL
            AND error_code IS NOT NULL
            AND error_message IS NOT NULL
          )
        )
      );

      CREATE TABLE saved_capsule_reverification_state (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        last_processed_sequence INTEGER NOT NULL DEFAULT 0
          CHECK (last_processed_sequence >= 0)
      );

      INSERT INTO saved_capsule_reverification_state (
        singleton_id, last_processed_sequence
      ) VALUES (1, 0);
    `);
  },
};
