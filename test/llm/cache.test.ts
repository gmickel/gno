/**
 * Tests for model cache.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelCache } from '../../src/llm/cache';

describe('ModelCache', () => {
  let tempDir: string;
  let cache: ModelCache;

  beforeEach(async () => {
    tempDir = join(
      tmpdir(),
      `gno-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(tempDir, { recursive: true });
    cache = new ModelCache(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('resolve', () => {
    test('returns error for file: URI when file does not exist', async () => {
      const result = await cache.resolve(
        'file:/nonexistent/model.gguf',
        'embed'
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MODEL_NOT_FOUND');
      }
    });

    test('returns path for file: URI when file exists', async () => {
      const modelPath = join(tempDir, 'test-model.gguf');
      await writeFile(modelPath, 'test content');

      const result = await cache.resolve(`file:${modelPath}`, 'embed');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(modelPath);
      }
    });

    test('returns path for absolute path when file exists', async () => {
      const modelPath = join(tempDir, 'test-model.gguf');
      await writeFile(modelPath, 'test content');

      const result = await cache.resolve(modelPath, 'embed');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(modelPath);
      }
    });

    test('returns NOT_CACHED for uncached hf: URI', async () => {
      const result = await cache.resolve('hf:test/model/model.gguf', 'embed');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MODEL_NOT_CACHED');
      }
    });

    test('returns error for invalid URI', async () => {
      const result = await cache.resolve('invalid-uri', 'embed');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_URI');
      }
    });
  });

  describe('isCached', () => {
    test('returns false for uncached model', async () => {
      const isCached = await cache.isCached('hf:test/model/model.gguf');
      expect(isCached).toBe(false);
    });

    test('returns true for file: URI when file exists', async () => {
      const modelPath = join(tempDir, 'local-model.gguf');
      await writeFile(modelPath, 'test content');

      const isCached = await cache.isCached(`file:${modelPath}`);
      expect(isCached).toBe(true);
    });

    test('returns false for file: URI when file does not exist', async () => {
      const isCached = await cache.isCached('file:/nonexistent/model.gguf');
      expect(isCached).toBe(false);
    });

    test('returns true for absolute path when file exists', async () => {
      const modelPath = join(tempDir, 'local-model.gguf');
      await writeFile(modelPath, 'test content');

      const isCached = await cache.isCached(modelPath);
      expect(isCached).toBe(true);
    });

    test('returns false for stale manifest entry', async () => {
      // Write a manifest with an entry pointing to a non-existent file
      const manifestPath = join(tempDir, 'manifest.json');
      await writeFile(
        manifestPath,
        JSON.stringify({
          version: '1.0',
          models: [
            {
              uri: 'hf:test/model/model.gguf',
              type: 'embed',
              path: '/nonexistent/path.gguf',
              size: 100,
              checksum: '',
              cachedAt: new Date().toISOString(),
            },
          ],
        })
      );

      const isCached = await cache.isCached('hf:test/model/model.gguf');
      expect(isCached).toBe(false);
    });
  });

  describe('list', () => {
    test('returns empty array when no manifest', async () => {
      const entries = await cache.list();
      expect(entries).toEqual([]);
    });

    test('returns entries from manifest', async () => {
      const manifestPath = join(tempDir, 'manifest.json');
      const modelPath = join(tempDir, 'model.gguf');
      await writeFile(modelPath, 'test content');

      await writeFile(
        manifestPath,
        JSON.stringify({
          version: '1.0',
          models: [
            {
              uri: 'hf:test/model/model.gguf',
              type: 'embed',
              path: modelPath,
              size: 12,
              checksum: '',
              cachedAt: '2024-01-01T00:00:00Z',
            },
          ],
        })
      );

      const entries = await cache.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.uri).toBe('hf:test/model/model.gguf');
      expect(entries[0]?.type).toBe('embed');
    });
  });

  describe('totalSize', () => {
    test('returns 0 for empty cache', async () => {
      const size = await cache.totalSize();
      expect(size).toBe(0);
    });

    test('returns sum of model sizes', async () => {
      const manifestPath = join(tempDir, 'manifest.json');
      await writeFile(
        manifestPath,
        JSON.stringify({
          version: '1.0',
          models: [
            {
              uri: 'hf:test/embed/model.gguf',
              type: 'embed',
              path: '/path/embed.gguf',
              size: 100,
              checksum: '',
              cachedAt: '2024-01-01T00:00:00Z',
            },
            {
              uri: 'hf:test/gen/model.gguf',
              type: 'gen',
              path: '/path/gen.gguf',
              size: 200,
              checksum: '',
              cachedAt: '2024-01-01T00:00:00Z',
            },
          ],
        })
      );

      const size = await cache.totalSize();
      expect(size).toBe(300);
    });
  });

  describe('clear', () => {
    test('clears all models', async () => {
      const manifestPath = join(tempDir, 'manifest.json');
      const modelPath = join(tempDir, 'model.gguf');
      await writeFile(modelPath, 'test content');

      await writeFile(
        manifestPath,
        JSON.stringify({
          version: '1.0',
          models: [
            {
              uri: 'hf:test/model/model.gguf',
              type: 'embed',
              path: modelPath,
              size: 12,
              checksum: '',
              cachedAt: '2024-01-01T00:00:00Z',
            },
          ],
        })
      );

      await cache.clear();

      const entries = await cache.list();
      expect(entries).toEqual([]);
    });

    test('clears only specified types', async () => {
      const manifestPath = join(tempDir, 'manifest.json');
      const embedPath = join(tempDir, 'embed.gguf');
      const genPath = join(tempDir, 'gen.gguf');
      await writeFile(embedPath, 'embed');
      await writeFile(genPath, 'gen');

      await writeFile(
        manifestPath,
        JSON.stringify({
          version: '1.0',
          models: [
            {
              uri: 'hf:test/embed/model.gguf',
              type: 'embed',
              path: embedPath,
              size: 5,
              checksum: '',
              cachedAt: '2024-01-01T00:00:00Z',
            },
            {
              uri: 'hf:test/gen/model.gguf',
              type: 'gen',
              path: genPath,
              size: 3,
              checksum: '',
              cachedAt: '2024-01-01T00:00:00Z',
            },
          ],
        })
      );

      await cache.clear(['embed']);

      const entries = await cache.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.type).toBe('gen');
    });
  });
});
