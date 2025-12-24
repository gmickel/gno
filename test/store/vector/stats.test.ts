/**
 * Tests for VectorStatsPort.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVectorStatsPort } from '../../../src/store/vector/stats';

describe('VectorStatsPort', () => {
  let db: Database;
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'gno-stats-test-'));
    const dbPath = join(testDir, 'test.sqlite');
    db = new Database(dbPath, { create: true });

    // Create required tables (minimal schema)
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY,
        mirror_hash TEXT,
        active INTEGER DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS content_chunks (
        mirror_hash TEXT NOT NULL,
        seq INTEGER NOT NULL,
        pos INTEGER NOT NULL DEFAULT 0,
        text TEXT NOT NULL,
        start_line INTEGER NOT NULL DEFAULT 0,
        end_line INTEGER NOT NULL DEFAULT 0,
        language TEXT,
        token_count INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (mirror_hash, seq)
      );

      CREATE TABLE IF NOT EXISTS content_vectors (
        mirror_hash TEXT NOT NULL,
        seq INTEGER NOT NULL,
        model TEXT NOT NULL,
        embedding BLOB NOT NULL,
        embedded_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (mirror_hash, seq, model)
      );
    `);
  });

  afterEach(async () => {
    db.close();
    await rm(testDir, { recursive: true, force: true });
  });

  describe('countVectors', () => {
    test('returns 0 for empty table', async () => {
      const stats = createVectorStatsPort(db);
      const result = await stats.countVectors('test-model');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
    });

    test('counts vectors for specific model', async () => {
      // Insert vectors for two models
      db.exec(`
        INSERT INTO content_vectors (mirror_hash, seq, model, embedding)
        VALUES ('h1', 0, 'model-a', x'00000000'),
               ('h1', 1, 'model-a', x'00000000'),
               ('h2', 0, 'model-b', x'00000000');
      `);

      const stats = createVectorStatsPort(db);

      const resultA = await stats.countVectors('model-a');
      expect(resultA.ok).toBe(true);
      if (resultA.ok) {
        expect(resultA.value).toBe(2);
      }

      const resultB = await stats.countVectors('model-b');
      expect(resultB.ok).toBe(true);
      if (resultB.ok) {
        expect(resultB.value).toBe(1);
      }
    });
  });

  describe('countBacklog', () => {
    test('returns 0 when all chunks are embedded', async () => {
      // Setup: document with chunk and matching vector
      db.exec(`
        INSERT INTO documents (id, mirror_hash, active) VALUES (1, 'h1', 1);
        INSERT INTO content_chunks (mirror_hash, seq, text, created_at)
        VALUES ('h1', 0, 'chunk text', datetime('now', '-1 minute'));
        INSERT INTO content_vectors (mirror_hash, seq, model, embedding, embedded_at)
        VALUES ('h1', 0, 'test-model', x'00000000', datetime('now'));
      `);

      const stats = createVectorStatsPort(db);
      const result = await stats.countBacklog('test-model');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
    });

    test('counts chunks without vectors', async () => {
      // Setup: active document with 3 chunks, only 1 has vector
      db.exec(`
        INSERT INTO documents (id, mirror_hash, active) VALUES (1, 'h1', 1);
        INSERT INTO content_chunks (mirror_hash, seq, text) VALUES
          ('h1', 0, 'chunk 0'),
          ('h1', 1, 'chunk 1'),
          ('h1', 2, 'chunk 2');
        INSERT INTO content_vectors (mirror_hash, seq, model, embedding, embedded_at)
        VALUES ('h1', 0, 'test-model', x'00000000', datetime('now'));
      `);

      const stats = createVectorStatsPort(db);
      const result = await stats.countBacklog('test-model');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(2); // chunks 1 and 2
      }
    });

    test('excludes chunks from inactive documents', async () => {
      // Setup: one active, one inactive document
      db.exec(`
        INSERT INTO documents (id, mirror_hash, active) VALUES
          (1, 'h1', 1),
          (2, 'h2', 0);
        INSERT INTO content_chunks (mirror_hash, seq, text) VALUES
          ('h1', 0, 'active chunk'),
          ('h2', 0, 'inactive chunk');
      `);

      const stats = createVectorStatsPort(db);
      const result = await stats.countBacklog('test-model');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(1); // only h1 chunk
      }
    });

    test('counts stale vectors as backlog', async () => {
      // Setup: chunk created after embedding
      db.exec(`
        INSERT INTO documents (id, mirror_hash, active) VALUES (1, 'h1', 1);
        INSERT INTO content_chunks (mirror_hash, seq, text, created_at)
        VALUES ('h1', 0, 'updated chunk', datetime('now'));
        INSERT INTO content_vectors (mirror_hash, seq, model, embedding, embedded_at)
        VALUES ('h1', 0, 'test-model', x'00000000', datetime('now', '-1 minute'));
      `);

      const stats = createVectorStatsPort(db);
      const result = await stats.countBacklog('test-model');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(1); // stale vector
      }
    });
  });

  describe('getBacklog', () => {
    test('returns empty array when no backlog', async () => {
      db.exec(`
        INSERT INTO documents (id, mirror_hash, active) VALUES (1, 'h1', 1);
        INSERT INTO content_chunks (mirror_hash, seq, text, created_at)
        VALUES ('h1', 0, 'chunk', datetime('now', '-1 minute'));
        INSERT INTO content_vectors (mirror_hash, seq, model, embedding, embedded_at)
        VALUES ('h1', 0, 'test-model', x'00000000', datetime('now'));
      `);

      const stats = createVectorStatsPort(db);
      const result = await stats.getBacklog('test-model');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(0);
      }
    });

    test('returns chunks needing embedding with reason', async () => {
      db.exec(`
        INSERT INTO documents (id, mirror_hash, active) VALUES (1, 'h1', 1);
        INSERT INTO content_chunks (mirror_hash, seq, text) VALUES
          ('h1', 0, 'new chunk'),
          ('h1', 1, 'another new chunk');
      `);

      const stats = createVectorStatsPort(db);
      const result = await stats.getBacklog('test-model');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        expect(result.value[0]?.reason).toBe('new');
        expect(result.value[0]?.text).toBe('new chunk');
      }
    });

    test('respects limit and cursor pagination', async () => {
      db.exec(`
        INSERT INTO documents (id, mirror_hash, active) VALUES (1, 'h1', 1);
        INSERT INTO content_chunks (mirror_hash, seq, text) VALUES
          ('h1', 0, 'chunk 0'),
          ('h1', 1, 'chunk 1'),
          ('h1', 2, 'chunk 2'),
          ('h1', 3, 'chunk 3'),
          ('h1', 4, 'chunk 4');
      `);

      const stats = createVectorStatsPort(db);

      // Get first 2
      const result1 = await stats.getBacklog('test-model', { limit: 2 });
      expect(result1.ok).toBe(true);
      if (!result1.ok) {
        return;
      }
      expect(result1.value).toHaveLength(2);
      expect(result1.value[0]?.seq).toBe(0);
      expect(result1.value[1]?.seq).toBe(1);

      // Get next 2 using cursor from last item
      const lastItem = result1.value[1];
      const result2 = await stats.getBacklog('test-model', {
        limit: 2,
        after: {
          mirrorHash: lastItem?.mirrorHash ?? '',
          seq: lastItem?.seq ?? 0,
        },
      });
      expect(result2.ok).toBe(true);
      if (result2.ok) {
        expect(result2.value).toHaveLength(2);
        expect(result2.value[0]?.seq).toBe(2);
        expect(result2.value[1]?.seq).toBe(3);
      }
    });

    test('marks changed chunks correctly', async () => {
      // Setup: chunk with stale vector
      db.exec(`
        INSERT INTO documents (id, mirror_hash, active) VALUES (1, 'h1', 1);
        INSERT INTO content_chunks (mirror_hash, seq, text, created_at)
        VALUES ('h1', 0, 'updated chunk', datetime('now'));
        INSERT INTO content_vectors (mirror_hash, seq, model, embedding, embedded_at)
        VALUES ('h1', 0, 'test-model', x'00000000', datetime('now', '-1 minute'));
      `);

      const stats = createVectorStatsPort(db);
      const result = await stats.getBacklog('test-model');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0]?.reason).toBe('changed');
      }
    });
  });
});
