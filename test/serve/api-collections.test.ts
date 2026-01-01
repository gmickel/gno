/**
 * Tests for collection API endpoints.
 *
 * These tests are hermetic - they use a temp config directory to avoid
 * mutating the developer's real config.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

// Import config path utilities to find actual config location
import { getConfigPaths } from '../../src/config/paths';

let originalConfigContent: string | null = null;
let configFilePath: string;

// Set up hermetic config directory before all tests
beforeAll(async () => {
  // Use the actual config path (respects platform-specific locations)
  const paths = getConfigPaths();
  configFilePath = paths.configFile;

  // Save original config if it exists
  const file = Bun.file(configFilePath);
  if (await file.exists()) {
    originalConfigContent = await file.text();
  }

  // Ensure config directory exists
  const { dirname } = await import('node:path');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dirname(configFilePath), { recursive: true });

  await resetConfig();
});

afterAll(async () => {
  // Restore original config or remove test config
  if (originalConfigContent !== null) {
    await writeFile(configFilePath, originalConfigContent);
  }
});

// Helper to reset config to default state
async function resetConfig() {
  await writeFile(
    configFilePath,
    'version: "1.0"\nftsTokenizer: unicode61\ncollections: []\ncontexts: []\n'
  );
}

// Helper to write config with collections/contexts using Bun.YAML
async function writeConfig(config: Partial<Config>) {
  const fullConfig = {
    version: '1.0',
    ftsTokenizer: 'unicode61',
    collections: [] as Config['collections'],
    contexts: [] as Config['contexts'],
    ...config,
  };
  const yaml = Bun.YAML.stringify(fullConfig);
  await writeFile(configFilePath, yaml);
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
    current: { config: fullConfig } as ContextHolder['current'],
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
    await resetConfig();
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
    // Write config with existing collection to disk
    await writeConfig({
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

    const store = createMockStore();
    const ctxHolder = createMockContextHolder();
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
    await resetConfig();
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
    // Write config with collection and context reference to disk
    await writeConfig({
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

    const store = createMockStore();
    const ctxHolder = createMockContextHolder();
    const res = await handleDeleteCollection(ctxHolder, store as never, 'docs');
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('HAS_REFERENCES');
  });
});
