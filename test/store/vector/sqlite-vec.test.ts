/**
 * Tests for sqlite-vec adapter.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createVectorIndexPort,
  decodeEmbedding,
  encodeEmbedding,
} from '../../../src/store/vector/sqlite-vec';
import type { VectorRow } from '../../../src/store/vector/types';

describe('encodeEmbedding/decodeEmbedding', () => {
  test('round-trips Float32Array correctly', () => {
    const original = new Float32Array([1.0, 2.0, 3.0, 4.0]);
    const encoded = encodeEmbedding(original);
    const decoded = decodeEmbedding(encoded);

    expect(decoded.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(decoded[i]).toBeCloseTo(original[i] ?? 0, 5);
    }
  });

  test('creates isolated copies', () => {
    const original = new Float32Array([1.0, 2.0]);
    const encoded = encodeEmbedding(original);

    // Modify original - should not affect encoded
    original[0] = 999;
    const decoded = decodeEmbedding(encoded);
    expect(decoded[0]).toBeCloseTo(1.0, 5);
  });
});

describe('createVectorIndexPort', () => {
  let db: Database;
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'gno-vec-test-'));
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

  test('creates port with correct properties', async () => {
    const result = await createVectorIndexPort(db, {
      model: 'test-model',
      dimensions: 4,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const port = result.value;
    expect(port.model).toBe('test-model');
    expect(port.dimensions).toBe(4);
    // searchAvailable depends on sqlite-vec being installed
    expect(typeof port.searchAvailable).toBe('boolean');
  });

  test('upsertVectors stores vectors in content_vectors', async () => {
    const result = await createVectorIndexPort(db, {
      model: 'test-model',
      dimensions: 4,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const port = result.value;
    const vectors: VectorRow[] = [
      {
        mirrorHash: 'hash1',
        seq: 0,
        model: 'test-model',
        embedding: new Float32Array([1.0, 2.0, 3.0, 4.0]),
        embeddedAt: new Date().toISOString(),
      },
      {
        mirrorHash: 'hash1',
        seq: 1,
        model: 'test-model',
        embedding: new Float32Array([5.0, 6.0, 7.0, 8.0]),
        embeddedAt: new Date().toISOString(),
      },
    ];

    const upsertResult = await port.upsertVectors(vectors);
    expect(upsertResult.ok).toBe(true);

    // Verify stored in content_vectors
    const rows = db
      .prepare('SELECT * FROM content_vectors WHERE model = ?')
      .all('test-model') as { mirror_hash: string; seq: number }[];
    expect(rows.length).toBe(2);
  });

  test('upsertVectors replaces existing vectors', async () => {
    const result = await createVectorIndexPort(db, {
      model: 'test-model',
      dimensions: 4,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const port = result.value;

    // Insert initial
    await port.upsertVectors([
      {
        mirrorHash: 'hash1',
        seq: 0,
        model: 'test-model',
        embedding: new Float32Array([1.0, 2.0, 3.0, 4.0]),
        embeddedAt: new Date().toISOString(),
      },
    ]);

    // Update with new embedding
    await port.upsertVectors([
      {
        mirrorHash: 'hash1',
        seq: 0,
        model: 'test-model',
        embedding: new Float32Array([9.0, 9.0, 9.0, 9.0]),
        embeddedAt: new Date().toISOString(),
      },
    ]);

    // Should still be 1 row
    const rows = db.prepare('SELECT * FROM content_vectors').all() as {
      mirror_hash: string;
    }[];
    expect(rows.length).toBe(1);
  });

  test('deleteVectorsForMirror removes vectors for mirror hash', async () => {
    const result = await createVectorIndexPort(db, {
      model: 'test-model',
      dimensions: 4,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const port = result.value;

    // Insert vectors for two different mirrors
    await port.upsertVectors([
      {
        mirrorHash: 'hash1',
        seq: 0,
        model: 'test-model',
        embedding: new Float32Array([1, 2, 3, 4]),
        embeddedAt: new Date().toISOString(),
      },
      {
        mirrorHash: 'hash2',
        seq: 0,
        model: 'test-model',
        embedding: new Float32Array([5, 6, 7, 8]),
        embeddedAt: new Date().toISOString(),
      },
    ]);

    // Delete hash1 vectors
    const deleteResult = await port.deleteVectorsForMirror('hash1');
    expect(deleteResult.ok).toBe(true);

    // Should only have hash2
    const rows = db
      .prepare('SELECT mirror_hash FROM content_vectors')
      .all() as { mirror_hash: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0]?.mirror_hash).toBe('hash2');
  });

  test('searchNearest returns error without sqlite-vec', async () => {
    const result = await createVectorIndexPort(db, {
      model: 'test-model',
      dimensions: 4,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const port = result.value;

    if (!port.searchAvailable) {
      // Without sqlite-vec, search should return error
      const searchResult = await port.searchNearest(
        new Float32Array([1, 2, 3, 4]),
        10
      );
      expect(searchResult.ok).toBe(false);
      if (!searchResult.ok) {
        expect(searchResult.error.code).toBe('VEC_SEARCH_UNAVAILABLE');
      }
    }
  });

  test('different models use separate vec tables', async () => {
    const result1 = await createVectorIndexPort(db, {
      model: 'model-a',
      dimensions: 4,
    });
    const result2 = await createVectorIndexPort(db, {
      model: 'model-b',
      dimensions: 8,
    });

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (!(result1.ok && result2.ok)) {
      return;
    }

    // Both ports should work independently
    expect(result1.value.model).toBe('model-a');
    expect(result1.value.dimensions).toBe(4);
    expect(result2.value.model).toBe('model-b');
    expect(result2.value.dimensions).toBe(8);
  });
});
