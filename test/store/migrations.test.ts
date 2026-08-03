import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyLexicalActivation } from "../../src/core/activation-verifier";
import { legacyLocalOnlyEgressLineage } from "../../src/core/egress-provenance";
import { getSchemaVersion, migrations, runMigrations } from "../../src/store";
import { migration as collectionEgressMigration } from "../../src/store/migrations/023-collection-egress-policy";
import { migration as derivedEgressMigration } from "../../src/store/migrations/024-egress-derived-lineage";
import { migration as policyRevisionMigration } from "../../src/store/migrations/025-collection-egress-policy-revision";
import {
  hashLegacyRetrievalTraceCreation,
  hashRetrievalTraceCreation,
} from "../../src/store/retrieval-trace-codec";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { createTrace } from "../../src/store/sqlite/retrieval-trace-store";
import { safeRm } from "../helpers/cleanup";

describe("store migrations", () => {
  let testDir = "";
  let dbPath = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-migrations-test-"));
    dbPath = join(testDir, "test.sqlite");
  });

  afterEach(async () => {
    await safeRm(testDir);
  });

  test("defaults legacy collections local-only and supports rollback", () => {
    const db = new Database(dbPath);
    try {
      expect(runMigrations(db, migrations.slice(0, 22), "unicode61").ok).toBe(
        true
      );
      db.run(
        `INSERT INTO collections (name, path, pattern)
         VALUES ('legacy', '/legacy', '**/*')`
      );

      collectionEgressMigration.up(db, "unicode61");
      expect(
        db
          .query<{ egress_policy: string; egress_policy_source: string }, []>(
            `SELECT egress_policy, egress_policy_source
             FROM collections WHERE name = 'legacy'`
          )
          .get()
      ).toEqual({
        egress_policy: "local_only",
        egress_policy_source: "legacy_default",
      });
      expect(() =>
        db.run(
          "UPDATE collections SET egress_policy = 'future' WHERE name = 'legacy'"
        )
      ).toThrow();
      expect(() =>
        db.run(
          `UPDATE collections SET egress_policy_source = 'inferred'
           WHERE name = 'legacy'`
        )
      ).toThrow();
      for (const source of ["config_default", "legacy_default"]) {
        for (const policy of ["lan", "remote"]) {
          expect(() =>
            db.run(
              `UPDATE collections
               SET egress_policy = ?, egress_policy_source = ?
               WHERE name = 'legacy'`,
              [policy, source]
            )
          ).toThrow();
        }
      }

      collectionEgressMigration.down?.(db);
      const columns = db
        .query<{ name: string }, []>("PRAGMA table_info(collections)")
        .all()
        .map((column) => column.name);
      expect(columns).not.toContain("egress_policy");
      expect(columns).not.toContain("egress_policy_source");
      expect(
        db
          .query<{ name: string }, []>(
            "SELECT name FROM collections WHERE name = 'legacy'"
          )
          .get()
      ).toEqual({ name: "legacy" });
    } finally {
      db.close();
    }
  });

  test("backfills derived lineage, journal bytes, and supports rollback", () => {
    const db = new Database(dbPath);
    const hash = "a".repeat(64);
    try {
      expect(runMigrations(db, migrations.slice(0, 23), "unicode61").ok).toBe(
        true
      );
      db.exec(`
        INSERT INTO retrieval_traces (
          trace_id, schema_version, redaction_mode, replay_capable,
          query_text, query_digest, query_shape_json,
          goal_text, goal_digest, goal_shape_json, filters_json,
          pipeline_fingerprint, model_fingerprint, config_fingerprint,
          index_fingerprint, status, created_at_ms, updated_at_ms,
          expires_at_ms, byte_size, creation_digest
        ) VALUES (
          'legacy-trace', '1.0', 'metadata', 0,
          NULL, NULL, '{"characters":0,"terms":0}',
          NULL, NULL, '{"characters":0,"terms":0}', '{}',
          '${hash}', '${hash}', '${hash}', '${hash}',
          'completed', 1, 2, 10,
          length(CAST('{"characters":0,"terms":0}' AS BLOB)) * 2
            + length(CAST('{}' AS BLOB)),
          '${hash}'
        );
        INSERT INTO retrieval_trace_exports (
          export_id, format, artifact_hash, created_at_ms
        ) VALUES ('legacy-export', 'agentic-receipt', '${hash}', 3);
        INSERT INTO document_changes (
          document_id, collection, change_kind, new_rel_path, new_docid,
          new_uri, new_source_hash, new_mirror_hash, new_active,
          observed_at_ms, byte_size
        ) VALUES (
          1, 'notes', 'create', 'legacy.md', '#legacy',
          'gno://notes/legacy.md', '${hash}', '${hash}', 1, 4, 100
        );
        UPDATE document_change_journal_state
        SET last_sequence = 1, retained_entries = 1, retained_bytes = 100
        WHERE singleton_id = 1;
      `);

      derivedEgressMigration.up(db, "unicode61");
      const expectedDigest =
        "87b249b76459c91c172da6be6cbe3f93b61c44869eb196f3470ec36ebb50b8b0";
      for (const table of [
        "retrieval_traces",
        "retrieval_trace_exports",
        "document_changes",
      ]) {
        expect(
          db
            .query<
              {
                effective_egress_policy: string;
                egress_lineage_digest: string;
              },
              []
            >(
              `SELECT effective_egress_policy, egress_lineage_digest FROM ${table}`
            )
            .get()
        ).toEqual({
          effective_egress_policy: "local_only",
          egress_lineage_digest: expectedDigest,
        });
      }
      const journal = db
        .query<{ byte_size: number; egress_lineage_bytes: number }, []>(
          "SELECT byte_size, egress_lineage_bytes FROM document_changes"
        )
        .get();
      expect(journal?.byte_size).toBe(
        100 + (journal?.egress_lineage_bytes ?? 0)
      );
      expect(
        db
          .query<{ retained_bytes: number }, []>(
            "SELECT retained_bytes FROM document_change_journal_state"
          )
          .get()?.retained_bytes
      ).toBe(journal?.byte_size);
      expect(
        db
          .query<{ name: string }, []>(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name = 'egress_audit_receipts'`
          )
          .get()
      ).toEqual({ name: "egress_audit_receipts" });

      derivedEgressMigration.down?.(db);
      expect(
        db
          .query<{ retained_bytes: number }, []>(
            "SELECT retained_bytes FROM document_change_journal_state"
          )
          .get()?.retained_bytes
      ).toBe(100);
      expect(
        db
          .query<{ name: string }, []>(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name = 'egress_audit_receipts'`
          )
          .get()
      ).toBeNull();
      for (const table of [
        "retrieval_traces",
        "retrieval_trace_exports",
        "document_changes",
      ]) {
        expect(
          db
            .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
            .all()
            .map((column) => column.name)
        ).not.toContain("egress_lineage_json");
      }
    } finally {
      db.close();
    }
  });

  test("adds a non-negative egress policy revision and preserves rollback", () => {
    const db = new Database(dbPath);
    try {
      expect(runMigrations(db, migrations.slice(0, 24), "unicode61").ok).toBe(
        true
      );
      db.run(
        `INSERT INTO collections (name, path, pattern)
         VALUES ('legacy', '/legacy', '**/*')`
      );
      policyRevisionMigration.up(db, "unicode61");
      expect(
        db
          .query<{ revision: number }, []>(
            `SELECT egress_policy_revision AS revision
             FROM collections WHERE name = 'legacy'`
          )
          .get()
      ).toEqual({ revision: 0 });
      expect(() =>
        db.run(
          "UPDATE collections SET egress_policy_revision = -1 WHERE name = 'legacy'"
        )
      ).toThrow();
      policyRevisionMigration.down?.(db);
      expect(
        db
          .query<{ name: string }, []>("PRAGMA table_info(collections)")
          .all()
          .map(({ name }) => name)
      ).not.toContain("egress_policy_revision");
    } finally {
      db.close();
    }
  });

  test("preserves v23 trace retries with a provable one-way digest marker", () => {
    const db = new Database(dbPath);
    const hash = "a".repeat(64);
    const trace = {
      traceId: "migrated-retry",
      schemaVersion: "1.0" as const,
      redactionMode: "metadata" as const,
      replayCapable: false,
      queryText: null,
      queryDigest: null,
      queryShape: { characters: 0, terms: 0 },
      goalText: null,
      goalDigest: null,
      goalShape: { characters: 0, terms: 0 },
      filters: {},
      egressLineage: legacyLocalOnlyEgressLineage(),
      fingerprints: {
        pipeline: hash,
        model: hash,
        config: hash,
        index: hash,
      },
      status: "open" as const,
      createdAtMs: 1,
      updatedAtMs: 1,
      expiresAtMs: 10,
    };
    const traceByteSize = new TextEncoder().encode(
      `${JSON.stringify(trace.queryShape)}${JSON.stringify(trace.goalShape)}${JSON.stringify(trace.filters)}`
    ).byteLength;
    try {
      expect(runMigrations(db, migrations.slice(0, 23), "unicode61").ok).toBe(
        true
      );
      db.run(
        `INSERT INTO retrieval_traces (
           trace_id, schema_version, redaction_mode, replay_capable,
           query_text, query_digest, query_shape_json,
           goal_text, goal_digest, goal_shape_json, filters_json,
           pipeline_fingerprint, model_fingerprint, config_fingerprint,
           index_fingerprint, status, created_at_ms, updated_at_ms,
           expires_at_ms, byte_size, creation_digest
         ) VALUES (?, '1.0', 'metadata', 0, NULL, NULL, ?, NULL, NULL, ?, ?,
                   ?, ?, ?, ?, 'open', 1, 1, 10, ?, ?)`,
        [
          trace.traceId,
          JSON.stringify(trace.queryShape),
          JSON.stringify(trace.goalShape),
          JSON.stringify(trace.filters),
          hash,
          hash,
          hash,
          hash,
          traceByteSize,
          hashLegacyRetrievalTraceCreation(trace),
        ]
      );
      derivedEgressMigration.up(db, "unicode61");
      expect(createTrace(db, trace)).toEqual({ ok: true, value: "duplicate" });
      expect(
        db
          .query<
            { creation_digest: string; creation_digest_version: number },
            []
          >(
            `SELECT creation_digest, creation_digest_version
             FROM retrieval_traces WHERE trace_id = 'migrated-retry'`
          )
          .get()
      ).toEqual({
        creation_digest: hashRetrievalTraceCreation(trace),
        creation_digest_version: 1,
      });
      expect(
        createTrace(db, {
          ...trace,
          fingerprints: { ...trace.fingerprints, pipeline: "b".repeat(64) },
        }).ok
      ).toBe(false);

      derivedEgressMigration.down?.(db);
      derivedEgressMigration.up(db, "unicode61");
      expect(createTrace(db, trace)).toEqual({ ok: true, value: "duplicate" });
      expect(
        db
          .query<{ creation_digest_version: number }, []>(
            `SELECT creation_digest_version
             FROM retrieval_traces WHERE trace_id = 'migrated-retry'`
          )
          .get()?.creation_digest_version
      ).toBe(1);

      const postMigration = { ...trace, traceId: "post-migration-sentinel" };
      expect(createTrace(db, postMigration)).toEqual({
        ok: true,
        value: "inserted",
      });
      db.run(
        `UPDATE retrieval_traces SET creation_digest = ?
         WHERE trace_id = 'post-migration-sentinel'`,
        [hashLegacyRetrievalTraceCreation(postMigration)]
      );
      expect(createTrace(db, postMigration).ok).toBe(false);
      expect(
        db
          .query<{ creation_digest_version: number }, []>(
            `SELECT creation_digest_version FROM retrieval_traces
             WHERE trace_id = 'post-migration-sentinel'`
          )
          .get()?.creation_digest_version
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  test("upgrades v5 databases without non-constant ALTER TABLE defaults", () => {
    const db = new Database(dbPath);

    try {
      const v5Result = runMigrations(db, migrations.slice(0, 5), "unicode61");
      expect(v5Result.ok).toBe(true);

      db.exec(`
        INSERT INTO collections (name, path, pattern)
        VALUES ('notes', '/notes', '**/*')
      `);
      db.exec(`
        INSERT INTO documents (
          collection, rel_path, source_hash, source_mime, source_ext,
          source_size, source_mtime, docid, uri, active, ingest_version
        ) VALUES (
          'notes',
          'legacy.md',
          'abc123',
          'text/markdown',
          '.md',
          100,
          '2026-02-20T12:00:00.000Z',
          'doc-legacy',
          'notes://legacy.md',
          1,
          1
        )
      `);

      const upgradeResult = runMigrations(db, migrations, "unicode61");
      expect(upgradeResult.ok).toBe(true);
      expect(getSchemaVersion(db)).toBe(26);

      const indexedRow = db
        .query<{ indexed_at: string | null }, []>(
          "SELECT indexed_at FROM documents WHERE collection = 'notes' AND rel_path = 'legacy.md'"
        )
        .get();
      expect(indexedRow).toBeDefined();
      expect(indexedRow?.indexed_at).not.toBeNull();
      expect(
        db
          .query<
            {
              egress_policy: string;
              egress_policy_revision: number;
              egress_policy_source: string;
            },
            []
          >(
            `SELECT egress_policy, egress_policy_source, egress_policy_revision
             FROM collections WHERE name = 'notes'`
          )
          .get()
      ).toEqual({
        egress_policy: "local_only",
        egress_policy_revision: 0,
        egress_policy_source: "legacy_default",
      });

      const vectorColumns = db
        .query<{ name: string }, []>("PRAGMA table_info(content_vectors)")
        .all()
        .map((column) => column.name);
      expect(vectorColumns).toContain("embed_fingerprint");

      const activationColumns = db
        .query<{ name: string }, []>("PRAGMA table_info(activation_receipts)")
        .all()
        .map((column) => column.name);
      expect(activationColumns).toEqual([
        "collection",
        "connector_target",
        "schema_version",
        "fingerprint",
        "receipt_json",
        "updated_at",
      ]);

      const documentColumns = db
        .query<{ name: string }, []>("PRAGMA table_info(documents)")
        .all()
        .map((column) => column.name);
      expect(documentColumns).toContain("fts_mirror_hash");

      const traceColumns = db
        .query<{ name: string }, []>("PRAGMA table_info(retrieval_traces)")
        .all()
        .map((column) => column.name);
      expect(traceColumns).toContain("creation_digest");
      expect(traceColumns).toContain("expires_at_ms");

      const changeColumns = db
        .query<{ name: string }, []>("PRAGMA table_info(document_changes)")
        .all()
        .map((column) => column.name);
      expect(changeColumns).toContain("old_source_hash");
      expect(changeColumns).toContain("new_mirror_hash");
      expect(changeColumns).toContain("heading_delta_json");
      expect(changeColumns).toContain("structure_truncated");
    } finally {
      db.close();
    }
  });

  test("upgrades context identity from v20 and preserves existing guidance", () => {
    const db = new Database(dbPath);
    try {
      expect(runMigrations(db, migrations.slice(0, 20), "unicode61").ok).toBe(
        true
      );
      db.run(
        `INSERT INTO contexts (scope_type, scope_key, text)
         VALUES ('collection', 'notes:', 'Existing guidance')`
      );

      expect(runMigrations(db, migrations, "unicode61").ok).toBe(true);
      expect(getSchemaVersion(db)).toBe(26);
      db.run(
        `INSERT INTO contexts (scope_type, scope_key, text)
         VALUES ('collection', 'notes:', 'Additional guidance')`
      );
      expect(
        db
          .query<{ text: string }, []>(
            `SELECT text FROM contexts
             WHERE scope_type = 'collection' AND scope_key = 'notes:'
             ORDER BY text`
          )
          .all()
      ).toEqual([
        { text: "Additional guidance" },
        { text: "Existing guidance" },
      ]);
    } finally {
      db.close();
    }
  });

  test("creates the metadata-only saved Capsule registry with bounded lifecycle constraints", () => {
    const db = new Database(dbPath);
    db.exec("PRAGMA foreign_keys = ON");

    try {
      expect(runMigrations(db, migrations, "unicode61").ok).toBe(true);
      expect(getSchemaVersion(db)).toBe(26);

      const savedTables = db
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name LIKE 'saved_capsule_%'
           ORDER BY name`
        )
        .all()
        .map((row) => row.name);
      expect(savedTables).toEqual([
        "saved_capsule_evidence",
        "saved_capsule_registrations",
        "saved_capsule_reverification_state",
        "saved_capsule_verifications",
      ]);
      expect(
        db
          .query<{ last_processed_sequence: number }, []>(
            `SELECT last_processed_sequence
             FROM saved_capsule_reverification_state
             WHERE singleton_id = 1`
          )
          .get()
      ).toEqual({ last_processed_sequence: 0 });

      const registrationId = `capsule-${"a".repeat(40)}`;
      const insertRegistration = db.prepare(
        `INSERT INTO saved_capsule_registrations (
           registration_id, file_path, file_hash, capsule_id, index_name,
           question, label, notification_preference, registered_at_ms,
           updated_at_ms, last_attempted_sequence
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      insertRegistration.run(
        registrationId,
        "/tmp/decision.capsule.json",
        "b".repeat(64),
        "c".repeat(64),
        "default",
        "Who owns the decision?",
        "Decision",
        "local",
        1,
        2,
        0
      );
      expect(() =>
        insertRegistration.run(
          `capsule-${"d".repeat(40)}`,
          "/tmp/decision.capsule.json",
          "e".repeat(64),
          "f".repeat(64),
          "default",
          null,
          null,
          "none",
          1,
          1,
          0
        )
      ).toThrow();
      expect(() =>
        insertRegistration.run(
          `capsule-${"d".repeat(40)}`,
          "/tmp/other.capsule.json",
          "not-a-hash",
          "f".repeat(64),
          "default",
          null,
          null,
          "none",
          1,
          1,
          0
        )
      ).toThrow();

      db.run(
        `INSERT INTO saved_capsule_evidence (
           registration_id, evidence_id, canonical_uri, collection,
           source_hash, mirror_hash, passage_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          registrationId,
          "1".repeat(64),
          "gno://notes/decision.md",
          "notes",
          "2".repeat(64),
          "3".repeat(64),
          "4".repeat(64),
        ]
      );
      db.run(
        `INSERT INTO saved_capsule_verifications (
           registration_id, trigger_kind, from_sequence, through_sequence,
           operation_status, affected_question_state, affected_reasons_json,
           receipt_json, receipt_hash, error_code, error_message, verified_at_ms
         ) VALUES (?, 'manual', 0, 0, 'completed', 'unaffected', '[]',
                   ?, ?, NULL, NULL, 3)`,
        [registrationId, '{"schemaVersion":"1.0"}', "5".repeat(64)]
      );
      expect(() =>
        db.run(
          `UPDATE saved_capsule_verifications
           SET error_code = 'mixed_outcome', error_message = 'invalid'
           WHERE registration_id = ?`,
          [registrationId]
        )
      ).toThrow();

      db.run(
        "DELETE FROM saved_capsule_registrations WHERE registration_id = ?",
        [registrationId]
      );
      expect(
        db
          .query<{ count: number }, []>(
            `SELECT (
               (SELECT COUNT(*) FROM saved_capsule_evidence) +
               (SELECT COUNT(*) FROM saved_capsule_verifications)
             ) AS count`
          )
          .get()
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  test("backfills bounded document-change retention counters from v16", () => {
    const db = new Database(dbPath);
    try {
      expect(runMigrations(db, migrations.slice(0, 16), "unicode61").ok).toBe(
        true
      );
      db.run(
        `INSERT INTO document_changes (
           document_id, collection, change_kind, observed_at_ms, byte_size
         ) VALUES (1, 'notes', 'create', 1, 41),
                  (2, 'notes', 'create', 2, 59)`
      );
      db.run(
        `UPDATE document_change_journal_state
         SET last_sequence = 2
         WHERE singleton_id = 1`
      );

      expect(runMigrations(db, migrations, "unicode61").ok).toBe(true);
      expect(getSchemaVersion(db)).toBe(26);
      expect(
        db
          .query<{ retained_entries: number; retained_bytes: number }, []>(
            `SELECT retained_entries, retained_bytes
             FROM document_change_journal_state
             WHERE singleton_id = 1`
          )
          .get()
      ).toEqual({
        retained_entries: 2,
        retained_bytes:
          db
            .query<{ total: number }, []>(
              "SELECT SUM(byte_size) AS total FROM document_changes"
            )
            .get()?.total ?? 0,
      });
      expect(() =>
        db.run(
          `UPDATE document_change_journal_state
           SET retained_entries = -1
           WHERE singleton_id = 1`
        )
      ).toThrow();
    } finally {
      db.close();
    }
  });

  test("adds a non-negative saved-Capsule registration epoch from v17", () => {
    const db = new Database(dbPath);
    try {
      expect(runMigrations(db, migrations.slice(0, 17), "unicode61").ok).toBe(
        true
      );
      db.run(
        `UPDATE saved_capsule_reverification_state
         SET last_processed_sequence = 7
         WHERE singleton_id = 1`
      );

      expect(runMigrations(db, migrations, "unicode61").ok).toBe(true);
      expect(getSchemaVersion(db)).toBe(26);
      expect(
        db
          .query<
            {
              last_processed_sequence: number;
              registration_epoch: number;
            },
            []
          >(
            `SELECT last_processed_sequence, registration_epoch
             FROM saved_capsule_reverification_state
             WHERE singleton_id = 1`
          )
          .get()
      ).toEqual({ last_processed_sequence: 7, registration_epoch: 0 });
      expect(() =>
        db.run(
          `UPDATE saved_capsule_reverification_state
           SET registration_epoch = -1
           WHERE singleton_id = 1`
        )
      ).toThrow();
    } finally {
      db.close();
    }
  });

  test("backfills unique registration generations above the v18 epoch", () => {
    const db = new Database(dbPath);
    try {
      expect(runMigrations(db, migrations.slice(0, 18), "unicode61").ok).toBe(
        true
      );
      db.run(
        `UPDATE saved_capsule_reverification_state
         SET registration_epoch = 5
         WHERE singleton_id = 1`
      );
      const insert = db.prepare(
        `INSERT INTO saved_capsule_registrations (
           registration_id, file_path, file_hash, capsule_id, index_name,
           notification_preference, registered_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, 'default', 'none', 1, 1)`
      );
      insert.run(
        "capsule-a",
        "/tmp/a.capsule.json",
        "a".repeat(64),
        "b".repeat(64)
      );
      insert.run(
        "capsule-b",
        "/tmp/b.capsule.json",
        "c".repeat(64),
        "d".repeat(64)
      );

      expect(runMigrations(db, migrations, "unicode61").ok).toBe(true);
      expect(getSchemaVersion(db)).toBe(26);
      expect(
        db
          .query<
            { registration_id: string; registration_generation: number },
            []
          >(
            `SELECT registration_id, registration_generation
             FROM saved_capsule_registrations
             ORDER BY registration_id ASC`
          )
          .all()
      ).toEqual([
        { registration_id: "capsule-a", registration_generation: 6 },
        { registration_id: "capsule-b", registration_generation: 7 },
      ]);
      expect(
        db
          .query<{ registration_epoch: number }, []>(
            `SELECT registration_epoch
             FROM saved_capsule_reverification_state
             WHERE singleton_id = 1`
          )
          .get()
      ).toEqual({ registration_epoch: 7 });
      expect(() =>
        db.run(
          `UPDATE saved_capsule_registrations
           SET registration_generation = -1
           WHERE registration_id = 'capsule-a'`
        )
      ).toThrow();
    } finally {
      db.close();
    }
  });

  test("backfills FTS sync markers only for fully aligned active legacy rows", () => {
    const db = new Database(dbPath);

    try {
      expect(runMigrations(db, migrations.slice(0, 12), "unicode61").ok).toBe(
        true
      );
      db.exec(`
        INSERT INTO collections (name, path, pattern)
        VALUES ('notes', '/notes', '**/*');
        INSERT INTO content (mirror_hash, markdown)
        VALUES
          ('mirror-current', 'current body'),
          ('mirror-filepath', 'filepath body'),
          ('mirror-title', 'title body'),
          ('mirror-inactive', 'inactive body'),
          ('mirror-body', 'expected body');
        INSERT INTO documents (
          collection, rel_path, source_hash, source_mime, source_ext,
          source_size, source_mtime, docid, uri, title, mirror_hash, active
        ) VALUES
          ('notes', 'current.md', 'source-current', 'text/markdown', '.md',
           12, '2026-07-22T10:00:00.000Z', 'current1', 'gno://notes/current.md',
           'Current', 'mirror-current', 1),
          ('notes', 'filepath.md', 'source-filepath', 'text/markdown', '.md',
           13, '2026-07-22T10:00:00.000Z', 'filepath1', 'gno://notes/filepath.md',
           'Filepath', 'mirror-filepath', 1),
          ('notes', 'title.md', 'source-title', 'text/markdown', '.md',
           10, '2026-07-22T10:00:00.000Z', 'title001', 'gno://notes/title.md',
           'Title', 'mirror-title', 1),
          ('notes', 'inactive.md', 'source-inactive', 'text/markdown', '.md',
           13, '2026-07-22T10:00:00.000Z', 'inactive1', 'gno://notes/inactive.md',
           'Inactive', 'mirror-inactive', 0),
          ('notes', 'body.md', 'source-body', 'text/markdown', '.md',
           13, '2026-07-22T10:00:00.000Z', 'body0001', 'gno://notes/body.md',
           'Body', 'mirror-body', 1);
        INSERT INTO documents_fts (rowid, filepath, title, body)
        SELECT id, rel_path, title, 'current body'
        FROM documents WHERE rel_path = 'current.md';
        INSERT INTO documents_fts (rowid, filepath, title, body)
        SELECT id, 'wrong-path.md', title, 'filepath body'
        FROM documents WHERE rel_path = 'filepath.md';
        INSERT INTO documents_fts (rowid, filepath, title, body)
        SELECT id, rel_path, 'Wrong title', 'title body'
        FROM documents WHERE rel_path = 'title.md';
        INSERT INTO documents_fts (rowid, filepath, title, body)
        SELECT id, rel_path, title, 'inactive body'
        FROM documents WHERE rel_path = 'inactive.md';
        INSERT INTO documents_fts (rowid, filepath, title, body)
        SELECT id, rel_path, title, 'stale body'
        FROM documents WHERE rel_path = 'body.md';
      `);

      const upgraded = runMigrations(db, migrations, "unicode61");
      expect(upgraded.ok).toBe(true);
      expect(getSchemaVersion(db)).toBe(26);
      const rows = db
        .query<{ rel_path: string; fts_mirror_hash: string | null }, []>(
          "SELECT rel_path, fts_mirror_hash FROM documents ORDER BY rel_path"
        )
        .all();
      expect(rows).toEqual([
        { rel_path: "body.md", fts_mirror_hash: null },
        { rel_path: "current.md", fts_mirror_hash: "mirror-current" },
        { rel_path: "filepath.md", fts_mirror_hash: null },
        { rel_path: "inactive.md", fts_mirror_hash: null },
        { rel_path: "title.md", fts_mirror_hash: null },
      ]);
      expect(
        db
          .query<
            {
              egress_policy: string;
              egress_policy_revision: number;
              egress_policy_source: string;
            },
            []
          >(
            `SELECT egress_policy, egress_policy_source, egress_policy_revision
             FROM collections WHERE name = 'notes'`
          )
          .get()
      ).toEqual({
        egress_policy: "local_only",
        egress_policy_revision: 0,
        egress_policy_source: "legacy_default",
      });
      expect(
        db
          .query<{ filepath: string }, []>(
            `SELECT filepath FROM documents_fts
             WHERE documents_fts MATCH 'current'`
          )
          .all()
      ).toEqual([{ filepath: "current.md" }]);
    } finally {
      db.close();
    }
  });

  test("leaves stale legacy FTS bodies unsynchronized until rebuilt", async () => {
    const db = new Database(dbPath);
    try {
      expect(runMigrations(db, migrations.slice(0, 12), "unicode61").ok).toBe(
        true
      );
      db.exec(`
        INSERT INTO collections (name, path, pattern)
        VALUES ('notes', '/notes', '**/*');
        INSERT INTO content (mirror_hash, markdown)
        VALUES ('mirror-new', 'shared beta evidence');
        INSERT INTO documents (
          collection, rel_path, source_hash, source_mime, source_ext,
          source_size, source_mtime, docid, uri, title, mirror_hash, active
        ) VALUES (
          'notes', 'stale.md',
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'text/markdown', '.md', 20,
          '2026-07-22T10:00:00.000Z', 'stale001', 'gno://notes/stale.md',
          'Stale', 'mirror-new', 1
        );
        INSERT INTO documents_fts (rowid, filepath, title, body)
        SELECT id, rel_path, title, 'shared alpha evidence'
        FROM documents WHERE rel_path = 'stale.md';
      `);

      expect(runMigrations(db, migrations, "unicode61").ok).toBe(true);
      expect(
        db
          .query<{ fts_mirror_hash: string | null }, []>(
            "SELECT fts_mirror_hash FROM documents WHERE rel_path = 'stale.md'"
          )
          .get()?.fts_mirror_hash
      ).toBeNull();
    } finally {
      db.close();
    }

    const adapter = new SqliteAdapter();
    try {
      expect((await adapter.open(dbPath, "unicode61")).ok).toBe(true);
      const stale = await verifyLexicalActivation(adapter, "notes");
      expect(stale.ok).toBe(true);
      if (stale.ok) {
        expect(stale.value.stages.index.code).toBe("index_out_of_sync");
      }

      expect((await adapter.rebuildAllDocumentsFts()).ok).toBe(true);
      const rebuilt = await verifyLexicalActivation(adapter, "notes");
      expect(rebuilt.ok && rebuilt.value.ready).toBe(true);
    } finally {
      await adapter.close();
    }
  });
});
