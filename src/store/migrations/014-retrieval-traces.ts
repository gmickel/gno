/**
 * Migration: private, bounded retrieval trace receipts.
 *
 * Trace rows own all subordinate runs, events, judgments, and export receipts.
 * Foreign-key cascades make per-trace deletion and full purge atomic.
 *
 * @module src/store/migrations/014-retrieval-traces
 */

import type { Database } from "bun:sqlite";

import type { Migration } from "./runner";

export const migration: Migration = {
  version: 14,
  name: "retrieval_traces",

  up(db: Database): void {
    db.exec(`
      CREATE TABLE retrieval_traces (
        trace_id TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL CHECK (schema_version = '1.0'),
        redaction_mode TEXT NOT NULL
          CHECK (redaction_mode IN ('metadata', 'replay')),
        replay_capable INTEGER NOT NULL
          CHECK (replay_capable IN (0, 1)),
        query_text TEXT,
        query_digest TEXT,
        query_shape_json TEXT NOT NULL,
        goal_text TEXT,
        goal_digest TEXT,
        goal_shape_json TEXT NOT NULL,
        filters_json TEXT NOT NULL,
        pipeline_fingerprint TEXT NOT NULL
          CHECK (length(pipeline_fingerprint) = 64 AND pipeline_fingerprint NOT GLOB '*[^0-9a-f]*'),
        model_fingerprint TEXT NOT NULL
          CHECK (length(model_fingerprint) = 64 AND model_fingerprint NOT GLOB '*[^0-9a-f]*'),
        config_fingerprint TEXT NOT NULL
          CHECK (length(config_fingerprint) = 64 AND config_fingerprint NOT GLOB '*[^0-9a-f]*'),
        index_fingerprint TEXT NOT NULL
          CHECK (length(index_fingerprint) = 64 AND index_fingerprint NOT GLOB '*[^0-9a-f]*'),
        status TEXT NOT NULL
          CHECK (status IN ('open', 'completed', 'partial', 'failed', 'cancelled')),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
        expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
        byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
        creation_digest TEXT NOT NULL
          CHECK (length(creation_digest) = 64 AND creation_digest NOT GLOB '*[^0-9a-f]*'),
        CHECK (length(CAST(query_shape_json AS BLOB)) <= 1024),
        CHECK (length(CAST(goal_shape_json AS BLOB)) <= 1024),
        CHECK (length(CAST(filters_json AS BLOB)) <= 16384),
        CHECK (query_text IS NULL OR length(CAST(query_text AS BLOB)) <= 8192),
        CHECK (goal_text IS NULL OR length(CAST(goal_text AS BLOB)) <= 8192),
        CHECK (length(trace_id) BETWEEN 1 AND 128),
        CHECK (
          byte_size =
            length(CAST(COALESCE(query_text, '') AS BLOB))
            + length(CAST(query_shape_json AS BLOB))
            + length(CAST(COALESCE(goal_text, '') AS BLOB))
            + length(CAST(goal_shape_json AS BLOB))
            + length(CAST(filters_json AS BLOB))
        ),
        CHECK (
          (
            redaction_mode = 'metadata'
            AND replay_capable = 0
            AND query_text IS NULL
            AND query_digest IS NULL
            AND goal_text IS NULL
            AND goal_digest IS NULL
          )
          OR
          (
            redaction_mode = 'replay'
            AND replay_capable = 1
            AND query_text IS NOT NULL
            AND length(query_digest) = 64
            AND query_digest NOT GLOB '*[^0-9a-f]*'
            AND (
              (goal_text IS NULL AND goal_digest IS NULL)
              OR
              (
                goal_text IS NOT NULL
                AND length(goal_digest) = 64
                AND goal_digest NOT GLOB '*[^0-9a-f]*'
              )
            )
          )
        )
      );

      CREATE INDEX idx_retrieval_traces_retention
      ON retrieval_traces(expires_at_ms, created_at_ms, trace_id);

      CREATE TABLE retrieval_trace_runs (
        run_id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        kind TEXT NOT NULL
          CHECK (kind IN ('retrieval', 'context', 'get')),
        payload_json TEXT NOT NULL,
        payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
        canonical_digest TEXT NOT NULL
          CHECK (length(canonical_digest) = 64 AND canonical_digest NOT GLOB '*[^0-9a-f]*'),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        CHECK (length(idempotency_key) BETWEEN 1 AND 256),
        CHECK (length(run_id) BETWEEN 1 AND 128),
        CHECK (length(trace_id) BETWEEN 1 AND 128),
        CHECK (payload_bytes = length(CAST(payload_json AS BLOB))),
        CHECK (payload_bytes <= 65536),
        UNIQUE (trace_id, idempotency_key),
        UNIQUE (trace_id, run_id),
        FOREIGN KEY (trace_id) REFERENCES retrieval_traces(trace_id) ON DELETE CASCADE
      );

      CREATE INDEX idx_retrieval_trace_runs_trace
      ON retrieval_trace_runs(trace_id, created_at_ms, run_id);

      CREATE TABLE retrieval_trace_events (
        event_id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        run_id TEXT,
        idempotency_key TEXT NOT NULL,
        kind TEXT NOT NULL
          CHECK (kind IN ('query', 'retrieval', 'context', 'get', 'open', 'cite', 'pin', 'capability', 'complete')),
        payload_json TEXT NOT NULL,
        payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
        canonical_digest TEXT NOT NULL
          CHECK (length(canonical_digest) = 64 AND canonical_digest NOT GLOB '*[^0-9a-f]*'),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        CHECK (length(idempotency_key) BETWEEN 1 AND 256),
        CHECK (length(event_id) BETWEEN 1 AND 128),
        CHECK (run_id IS NULL OR length(run_id) BETWEEN 1 AND 128),
        CHECK (length(trace_id) BETWEEN 1 AND 128),
        CHECK (payload_bytes = length(CAST(payload_json AS BLOB))),
        CHECK (payload_bytes <= 65536),
        UNIQUE (trace_id, idempotency_key),
        FOREIGN KEY (trace_id) REFERENCES retrieval_traces(trace_id) ON DELETE CASCADE,
        FOREIGN KEY (trace_id, run_id)
          REFERENCES retrieval_trace_runs(trace_id, run_id) ON DELETE CASCADE
      );

      CREATE INDEX idx_retrieval_trace_events_trace
      ON retrieval_trace_events(trace_id, created_at_ms, event_id);

      CREATE TABLE retrieval_trace_judgments (
        judgment_id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        run_id TEXT,
        idempotency_key TEXT NOT NULL,
        label TEXT NOT NULL
          CHECK (label IN ('relevant', 'irrelevant', 'missing_expected')),
        target_kind TEXT NOT NULL
          CHECK (target_kind IN ('document', 'chunk', 'span', 'query')),
        target_ref TEXT NOT NULL,
        target_json TEXT NOT NULL,
        target_bytes INTEGER NOT NULL CHECK (target_bytes >= 0),
        canonical_digest TEXT NOT NULL
          CHECK (length(canonical_digest) = 64 AND canonical_digest NOT GLOB '*[^0-9a-f]*'),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        CHECK (length(idempotency_key) BETWEEN 1 AND 256),
        CHECK (length(judgment_id) BETWEEN 1 AND 128),
        CHECK (run_id IS NULL OR length(run_id) BETWEEN 1 AND 128),
        CHECK (length(trace_id) BETWEEN 1 AND 128),
        CHECK (length(CAST(target_ref AS BLOB)) BETWEEN 1 AND 4096),
        CHECK (target_bytes = length(CAST(target_json AS BLOB))),
        CHECK (target_bytes <= 16384),
        UNIQUE (trace_id, idempotency_key),
        FOREIGN KEY (trace_id) REFERENCES retrieval_traces(trace_id) ON DELETE CASCADE,
        FOREIGN KEY (trace_id, run_id)
          REFERENCES retrieval_trace_runs(trace_id, run_id) ON DELETE CASCADE
      );

      CREATE INDEX idx_retrieval_trace_judgments_trace
      ON retrieval_trace_judgments(trace_id, created_at_ms, judgment_id);

      CREATE TABLE retrieval_trace_exports (
        export_id TEXT PRIMARY KEY,
        format TEXT NOT NULL CHECK (format IN ('agentic-receipt', 'qrels')),
        artifact_hash TEXT NOT NULL
          CHECK (length(artifact_hash) = 64 AND artifact_hash NOT GLOB '*[^0-9a-f]*'),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        CHECK (length(export_id) BETWEEN 1 AND 128),
        UNIQUE (format, artifact_hash)
      );

      CREATE TABLE retrieval_trace_export_traces (
        export_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        PRIMARY KEY (export_id, trace_id),
        FOREIGN KEY (export_id) REFERENCES retrieval_trace_exports(export_id) ON DELETE CASCADE,
        FOREIGN KEY (trace_id) REFERENCES retrieval_traces(trace_id) ON DELETE CASCADE
      );

      CREATE INDEX idx_retrieval_trace_export_traces_trace
      ON retrieval_trace_export_traces(trace_id, export_id);

      CREATE TRIGGER delete_empty_retrieval_trace_export
      AFTER DELETE ON retrieval_trace_export_traces
      WHEN NOT EXISTS (
        SELECT 1 FROM retrieval_trace_export_traces
        WHERE export_id = OLD.export_id
      )
      BEGIN
        DELETE FROM retrieval_trace_exports WHERE export_id = OLD.export_id;
      END;

      CREATE TRIGGER cap_retrieval_trace_runs
      BEFORE INSERT ON retrieval_trace_runs
      WHEN (
        (SELECT COUNT(*) FROM retrieval_trace_runs WHERE trace_id = NEW.trace_id)
        + (SELECT COUNT(*) FROM retrieval_trace_events WHERE trace_id = NEW.trace_id)
        + (SELECT COUNT(*) FROM retrieval_trace_judgments WHERE trace_id = NEW.trace_id)
        + (SELECT COUNT(*) FROM retrieval_trace_export_traces WHERE trace_id = NEW.trace_id)
      ) >= 100000
      AND NOT EXISTS (
        SELECT 1 FROM retrieval_trace_runs existing
        WHERE existing.run_id = NEW.run_id
           OR (
             existing.trace_id = NEW.trace_id
             AND existing.idempotency_key = NEW.idempotency_key
           )
      )
      BEGIN
        SELECT RAISE(ABORT, 'retrieval trace record cap exceeded');
      END;

      CREATE TRIGGER cap_retrieval_trace_events
      BEFORE INSERT ON retrieval_trace_events
      WHEN (
        (SELECT COUNT(*) FROM retrieval_trace_runs WHERE trace_id = NEW.trace_id)
        + (SELECT COUNT(*) FROM retrieval_trace_events WHERE trace_id = NEW.trace_id)
        + (SELECT COUNT(*) FROM retrieval_trace_judgments WHERE trace_id = NEW.trace_id)
        + (SELECT COUNT(*) FROM retrieval_trace_export_traces WHERE trace_id = NEW.trace_id)
      ) >= 100000
      AND NOT EXISTS (
        SELECT 1 FROM retrieval_trace_events existing
        WHERE existing.event_id = NEW.event_id
           OR (
             existing.trace_id = NEW.trace_id
             AND existing.idempotency_key = NEW.idempotency_key
           )
      )
      BEGIN
        SELECT RAISE(ABORT, 'retrieval trace record cap exceeded');
      END;

      CREATE TRIGGER cap_retrieval_trace_judgments
      BEFORE INSERT ON retrieval_trace_judgments
      WHEN (
        (SELECT COUNT(*) FROM retrieval_trace_runs WHERE trace_id = NEW.trace_id)
        + (SELECT COUNT(*) FROM retrieval_trace_events WHERE trace_id = NEW.trace_id)
        + (SELECT COUNT(*) FROM retrieval_trace_judgments WHERE trace_id = NEW.trace_id)
        + (SELECT COUNT(*) FROM retrieval_trace_export_traces WHERE trace_id = NEW.trace_id)
      ) >= 100000
      AND NOT EXISTS (
        SELECT 1 FROM retrieval_trace_judgments existing
        WHERE existing.judgment_id = NEW.judgment_id
           OR (
             existing.trace_id = NEW.trace_id
             AND existing.idempotency_key = NEW.idempotency_key
           )
      )
      BEGIN
        SELECT RAISE(ABORT, 'retrieval trace record cap exceeded');
      END;

      CREATE TRIGGER cap_retrieval_trace_export_links
      BEFORE INSERT ON retrieval_trace_export_traces
      WHEN (
        (SELECT COUNT(*) FROM retrieval_trace_runs WHERE trace_id = NEW.trace_id)
        + (SELECT COUNT(*) FROM retrieval_trace_events WHERE trace_id = NEW.trace_id)
        + (SELECT COUNT(*) FROM retrieval_trace_judgments WHERE trace_id = NEW.trace_id)
        + (SELECT COUNT(*) FROM retrieval_trace_export_traces WHERE trace_id = NEW.trace_id)
      ) >= 100000
      AND NOT EXISTS (
        SELECT 1 FROM retrieval_trace_export_traces existing
        WHERE existing.export_id = NEW.export_id
          AND existing.trace_id = NEW.trace_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'retrieval trace record cap exceeded');
      END;
    `);
  },

  down(db: Database): void {
    db.exec(`
      DROP TRIGGER IF EXISTS cap_retrieval_trace_export_links;
      DROP TRIGGER IF EXISTS cap_retrieval_trace_judgments;
      DROP TRIGGER IF EXISTS cap_retrieval_trace_events;
      DROP TRIGGER IF EXISTS cap_retrieval_trace_runs;
      DROP TRIGGER IF EXISTS delete_empty_retrieval_trace_export;
      DROP TABLE IF EXISTS retrieval_trace_export_traces;
      DROP TABLE IF EXISTS retrieval_trace_exports;
      DROP TABLE IF EXISTS retrieval_trace_judgments;
      DROP TABLE IF EXISTS retrieval_trace_events;
      DROP TABLE IF EXISTS retrieval_trace_runs;
      DROP TABLE IF EXISTS retrieval_traces;
    `);
  },
};
