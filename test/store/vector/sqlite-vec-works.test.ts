/**
 * Integration test: sqlite-vec actually works end-to-end.
 * This test exercises real vector search, not just graceful degradation.
 *
 * Skip/fail rules:
 * - Linux/Windows: MUST pass (native extension support)
 * - macOS with custom SQLite: MUST pass
 * - macOS without custom SQLite: MAY skip (logs reason)
 * - CI: MUST pass on all platforms
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { platform } from 'node:os';
import { getExtensionLoadingMode } from '../../../src/store/sqlite/setup';
import { createVectorIndexPort } from '../../../src/store/vector/sqlite-vec';
import type { VectorRow } from '../../../src/store/vector/types';

// CI detection: accept 'true', '1', or any non-empty value
const isCI = Boolean(process.env.CI);
const isDarwin = platform() === 'darwin';
const mode = getExtensionLoadingMode();

describe('sqlite-vec integration', () => {
  test('vector search works end-to-end', async () => {
    // Determine if we should skip
    if (isDarwin && mode === 'unavailable' && !isCI) {
      console.log(
        'SKIP: macOS without custom SQLite (Homebrew not installed). ' +
          'Install sqlite3: brew install sqlite3'
      );
      return;
    }

    // Create in-memory DB with required schema
    const db = new Database(':memory:');

    try {
      db.exec(`
        CREATE TABLE content_vectors (
          mirror_hash TEXT NOT NULL,
          seq INTEGER NOT NULL,
          model TEXT NOT NULL,
          embedding BLOB NOT NULL,
          embedded_at TEXT DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (mirror_hash, seq, model)
        );
      `);

      // Create vector index port
      const result = await createVectorIndexPort(db, {
        model: 'test-model',
        dimensions: 4,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      const port = result.value;

      // In CI or on non-darwin platforms, search MUST be available
      if (isCI || !isDarwin) {
        expect(port.searchAvailable).toBe(true);
      }

      if (!port.searchAvailable) {
        // Graceful skip for local macOS dev without Homebrew
        console.log('SKIP: sqlite-vec not available on this platform');
        return;
      }

      // Insert test vectors
      const vectors: VectorRow[] = [
        {
          mirrorHash: 'doc1',
          seq: 0,
          model: 'test-model',
          embedding: new Float32Array([1.0, 0.0, 0.0, 0.0]), // Unit vector in x
          embeddedAt: new Date().toISOString(),
        },
        {
          mirrorHash: 'doc2',
          seq: 0,
          model: 'test-model',
          embedding: new Float32Array([0.0, 1.0, 0.0, 0.0]), // Unit vector in y
          embeddedAt: new Date().toISOString(),
        },
        {
          mirrorHash: 'doc3',
          seq: 0,
          model: 'test-model',
          embedding: new Float32Array([0.9, 0.1, 0.0, 0.0]), // Close to doc1
          embeddedAt: new Date().toISOString(),
        },
      ];

      const upsertResult = await port.upsertVectors(vectors);
      expect(upsertResult.ok).toBe(true);

      // Search for vectors similar to [1, 0, 0, 0]
      const query = new Float32Array([1.0, 0.0, 0.0, 0.0]);
      const searchResult = await port.searchNearest(query, 3);

      expect(searchResult.ok).toBe(true);
      if (!searchResult.ok) {
        return;
      }

      const results = searchResult.value;

      // Should get results
      expect(results.length).toBeGreaterThan(0);

      // doc1 should be closest (exact match), doc3 second (similar)
      expect(results[0]?.mirrorHash).toBe('doc1');
      expect(results[0]?.distance).toBeCloseTo(0, 5); // Cosine distance 0 = identical

      // doc3 should be more similar than doc2
      const doc3Idx = results.findIndex((r) => r.mirrorHash === 'doc3');
      const doc2Idx = results.findIndex((r) => r.mirrorHash === 'doc2');
      expect(doc3Idx).toBeLessThan(doc2Idx);
    } finally {
      db.close();
    }
  });

  test('vec0 table is created with correct schema', async () => {
    if (isDarwin && mode === 'unavailable' && !isCI) {
      return; // Skip - no sqlite-vec available
    }

    const db = new Database(':memory:');

    try {
      db.exec(`
        CREATE TABLE content_vectors (
          mirror_hash TEXT NOT NULL,
          seq INTEGER NOT NULL,
          model TEXT NOT NULL,
          embedding BLOB NOT NULL,
          embedded_at TEXT DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (mirror_hash, seq, model)
        );
      `);

      const result = await createVectorIndexPort(db, {
        model: 'schema-test',
        dimensions: 8,
        distanceMetric: 'l2',
      });

      expect(result.ok).toBe(true);
      if (!(result.ok && result.value.searchAvailable)) {
        return;
      }

      // Verify vec0 table exists with correct structure
      const tables = db
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'vec_%'"
        )
        .all() as { name: string }[];

      expect(tables.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test('rebuild and sync operations work', async () => {
    if (isDarwin && mode === 'unavailable' && !isCI) {
      return;
    }

    const db = new Database(':memory:');

    try {
      db.exec(`
        CREATE TABLE content_vectors (
          mirror_hash TEXT NOT NULL,
          seq INTEGER NOT NULL,
          model TEXT NOT NULL,
          embedding BLOB NOT NULL,
          embedded_at TEXT DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (mirror_hash, seq, model)
        );
      `);

      const result = await createVectorIndexPort(db, {
        model: 'rebuild-test',
        dimensions: 4,
      });

      if (!(result.ok && result.value.searchAvailable)) {
        return;
      }

      const port = result.value;

      // Insert via port
      await port.upsertVectors([
        {
          mirrorHash: 'rebuild1',
          seq: 0,
          model: 'rebuild-test',
          embedding: new Float32Array([1, 0, 0, 0]),
          embeddedAt: new Date().toISOString(),
        },
      ]);

      // Rebuild
      const rebuildResult = await port.rebuildVecIndex();
      expect(rebuildResult.ok).toBe(true);

      // Search should still work
      const searchResult = await port.searchNearest(
        new Float32Array([1, 0, 0, 0]),
        1
      );
      expect(searchResult.ok).toBe(true);
      if (searchResult.ok) {
        expect(searchResult.value.length).toBe(1);
      }

      // Sync
      const syncResult = await port.syncVecIndex();
      expect(syncResult.ok).toBe(true);
    } finally {
      db.close();
    }
  });
});
