/**
 * Tests for collection API endpoints.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../../src/config/types';
import type { ContextHolder } from '../../src/serve/routes/api';
import {
  handleCollections,
  handleCreateCollection,
  handleDeleteCollection,
} from '../../src/serve/routes/api';

interface ErrorBody {
  error: { code: string };
}

// Minimal mock store for testing
function createMockStore() {
  const collections: Array<{ name: string; path: string }> = [];

  return {
    collections,
    getCollections() {
      return Promise.resolve({ ok: true as const, value: collections });
    },
    syncCollections(cols: Array<{ name: string; path: string }>) {
      collections.length = 0;
      collections.push(...cols);
      return Promise.resolve({ ok: true as const, value: undefined });
    },
    syncContexts() {
      return Promise.resolve({ ok: true as const, value: undefined });
    },
  };
}

// Minimal mock context holder
function createMockContextHolder(config?: Partial<Config>): ContextHolder {
  const fullConfig: Config = {
    version: '1.0',
    ftsTokenizer: 'unicode61',
    collections: [],
    contexts: [],
    ...config,
  };
  return {
    current: {} as ContextHolder['current'],
    config: fullConfig,
  };
}

describe('GET /api/collections', () => {
  test('returns empty list when no collections', async () => {
    const store = createMockStore();
    const res = await handleCollections(store as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  test('returns collections list', async () => {
    const store = createMockStore();
    store.collections.push({ name: 'docs', path: '/path/to/docs' });
    const res = await handleCollections(store as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([{ name: 'docs', path: '/path/to/docs' }]);
  });
});

describe('POST /api/collections', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'gno-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('rejects missing path', async () => {
    const store = createMockStore();
    const ctxHolder = createMockContextHolder();
    const req = new Request('http://localhost/api/collections', {
      method: 'POST',
      body: JSON.stringify({ name: 'test' }),
    });
    const res = await handleCreateCollection(ctxHolder, store as never, req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('VALIDATION');
  });

  test('rejects non-existent path', async () => {
    const store = createMockStore();
    const ctxHolder = createMockContextHolder();
    const req = new Request('http://localhost/api/collections', {
      method: 'POST',
      body: JSON.stringify({ path: '/nonexistent/path', name: 'test' }),
    });
    const res = await handleCreateCollection(ctxHolder, store as never, req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('PATH_NOT_FOUND');
  });

  test('rejects duplicate collection name', async () => {
    const store = createMockStore();
    const ctxHolder = createMockContextHolder({
      collections: [
        {
          name: 'existing',
          path: tmpDir,
          pattern: '**/*.md',
          include: [],
          exclude: [],
        },
      ],
    });
    const req = new Request('http://localhost/api/collections', {
      method: 'POST',
      body: JSON.stringify({ path: tmpDir, name: 'existing' }),
    });
    const res = await handleCreateCollection(ctxHolder, store as never, req);
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('DUPLICATE');
  });
});

describe('DELETE /api/collections/:name', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'gno-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('rejects non-existent collection', async () => {
    const store = createMockStore();
    const ctxHolder = createMockContextHolder();
    const res = await handleDeleteCollection(
      ctxHolder,
      store as never,
      'nonexistent'
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('NOT_FOUND');
  });

  test('rejects collection with context references', async () => {
    const store = createMockStore();
    const ctxHolder = createMockContextHolder({
      collections: [
        {
          name: 'docs',
          path: tmpDir,
          pattern: '**/*.md',
          include: [],
          exclude: [],
        },
      ],
      contexts: [{ scopeType: 'collection', scopeKey: 'docs:', text: 'test' }],
    });
    const res = await handleDeleteCollection(ctxHolder, store as never, 'docs');
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('HAS_REFERENCES');
  });
});
