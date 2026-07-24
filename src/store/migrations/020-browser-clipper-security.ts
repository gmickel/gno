/**
 * Migration: persisted browser-clipper grants and write idempotency.
 *
 * Pairing codes and bearer tokens never enter SQLite. Only SHA-256 token/key
 * digests, exact extension origins, bounded grant lifetimes, and completed
 * capture receipts are durable across resident restarts.
 *
 * @module src/store/migrations/020-browser-clipper-security
 */

import type { Database } from "bun:sqlite";

import type { Migration } from "./runner";

export const migration: Migration = {
  version: 20,
  name: "browser_clipper_security",

  up(db: Database): void {
    db.exec(`
      CREATE TABLE clipper_grants (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        origin TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'capture'
          CHECK (scope = 'capture'),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
        revoked_at_ms INTEGER
          CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= created_at_ms),
        CHECK (length(id) BETWEEN 1 AND 128),
        CHECK (
          length(token_hash) = 64
          AND token_hash NOT GLOB '*[^0-9a-f]*'
        ),
        CHECK (
          length(origin) = 51
          AND substr(origin, 1, 19) = 'chrome-extension://'
          AND substr(origin, 20) NOT GLOB '*[^a-p]*'
        )
      );

      CREATE INDEX idx_clipper_grants_expiry
      ON clipper_grants(expires_at_ms, id);

      CREATE TABLE clipper_capture_idempotency (
        grant_id TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        collection TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        collision_policy_result TEXT NOT NULL
          CHECK (
            collision_policy_result IN (
              'created',
              'opened_existing',
              'created_with_suffix',
              'overwritten',
              'conflict'
            )
          ),
        content_hash TEXT NOT NULL,
        clip_identity TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
        status_code INTEGER,
        response_json TEXT,
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        completed_at_ms INTEGER
          CHECK (
            completed_at_ms IS NULL OR completed_at_ms >= created_at_ms
          ),
        PRIMARY KEY (grant_id, key_hash),
        FOREIGN KEY (grant_id)
          REFERENCES clipper_grants(id)
          ON DELETE CASCADE,
        CHECK (
          length(key_hash) = 64
          AND key_hash NOT GLOB '*[^0-9a-f]*'
        ),
        UNIQUE (grant_id, request_digest),
        CHECK (
          length(request_digest) = 64
          AND request_digest NOT GLOB '*[^0-9a-f]*'
        ),
        CHECK (length(CAST(collection AS BLOB)) BETWEEN 1 AND 256),
        CHECK (length(CAST(rel_path AS BLOB)) BETWEEN 1 AND 8192),
        CHECK (
          length(content_hash) = 64
          AND content_hash NOT GLOB '*[^0-9a-f]*'
        ),
        CHECK (
          length(clip_identity) = 64
          AND clip_identity NOT GLOB '*[^0-9a-f]*'
        ),
        CHECK (
          response_json IS NULL
          OR length(CAST(response_json AS BLOB)) <= 2097152
        ),
        CHECK (
          (
            state = 'pending'
            AND status_code IS NULL
            AND response_json IS NULL
            AND completed_at_ms IS NULL
          )
          OR
          (
            state = 'completed'
            AND status_code BETWEEN 200 AND 599
            AND response_json IS NOT NULL
            AND json_valid(response_json)
            AND completed_at_ms IS NOT NULL
          )
        )
      );

      CREATE INDEX idx_clipper_idempotency_created
      ON clipper_capture_idempotency(created_at_ms, grant_id, key_hash);
    `);
  },

  down(db: Database): void {
    db.exec("DROP INDEX IF EXISTS idx_clipper_idempotency_created");
    db.exec("DROP TABLE IF EXISTS clipper_capture_idempotency");
    db.exec("DROP INDEX IF EXISTS idx_clipper_grants_expiry");
    db.exec("DROP TABLE IF EXISTS clipper_grants");
  },
};
