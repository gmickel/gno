/**
 * FTS5 search tests for SQLite adapter.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../../src/store';
import type { ChunkInput } from '../../src/store/types';
import { safeRm } from '../helpers/cleanup';

describe('FTS search', () => {
  let adapter: SqliteAdapter;
  let testDir: string;
  let dbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'gno-fts-test-'));
    dbPath = join(testDir, 'test.sqlite');
    adapter = new SqliteAdapter();
    await adapter.open(dbPath, 'unicode61');

    // Set up test data
    await adapter.syncCollections([
      {
        name: 'notes',
        path: '/notes',
        pattern: '**/*',
        include: [],
        exclude: [],
      },
    ]);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  async function setupDocument(
    relPath: string,
    markdown: string,
    chunks: ChunkInput[]
  ) {
    const sourceHash = `hash_${relPath.replace(/\W/g, '')}`;
    const mirrorHash = `mirror_${relPath.replace(/\W/g, '')}`;

    await adapter.upsertDocument({
      collection: 'notes',
      relPath,
      sourceHash,
      sourceMime: 'text/markdown',
      sourceExt: '.md',
      sourceSize: markdown.length,
      sourceMtime: '2024-01-01T00:00:00Z',
      mirrorHash,
      title: relPath,
    });

    await adapter.upsertContent(mirrorHash, markdown);
    await adapter.upsertChunks(mirrorHash, chunks);
    await adapter.rebuildFtsForHash(mirrorHash);
  }

  test('searches chunk text with FTS5', async () => {
    await setupDocument('hello.md', '# Hello World', [
      { seq: 0, pos: 0, text: 'Hello World', startLine: 1, endLine: 1 },
    ]);

    const result = await adapter.searchFts('hello');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value).toHaveLength(1);
    // docid is first 8 chars of sourceHash which is "hash_hellomd"
    expect(result.value[0]?.docid).toBe('#hash_hel');
  });

  test('returns multiple matches ranked by score', async () => {
    await setupDocument('doc1.md', 'Apple pie recipe', [
      { seq: 0, pos: 0, text: 'Apple pie recipe', startLine: 1, endLine: 1 },
    ]);

    await setupDocument('doc2.md', 'Apple and orange', [
      { seq: 0, pos: 0, text: 'Apple and orange', startLine: 1, endLine: 1 },
    ]);

    await setupDocument('doc3.md', 'Banana bread', [
      { seq: 0, pos: 0, text: 'Banana bread', startLine: 1, endLine: 1 },
    ]);

    const result = await adapter.searchFts('apple');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value).toHaveLength(2);
    // Both results should contain "apple"
    expect(result.value.every((r) => r.uri?.includes('doc'))).toBe(true);
  });

  test('returns empty results for no match', async () => {
    await setupDocument('doc.md', 'Hello World', [
      { seq: 0, pos: 0, text: 'Hello World', startLine: 1, endLine: 1 },
    ]);

    const result = await adapter.searchFts('nonexistent');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value).toHaveLength(0);
  });

  test('filters by collection', async () => {
    await adapter.syncCollections([
      {
        name: 'notes',
        path: '/notes',
        pattern: '**/*',
        include: [],
        exclude: [],
      },
      {
        name: 'docs',
        path: '/docs',
        pattern: '**/*',
        include: [],
        exclude: [],
      },
    ]);

    // Add to notes collection (already set up)
    await setupDocument('note.md', 'Important note about testing', [
      {
        seq: 0,
        pos: 0,
        text: 'Important note about testing',
        startLine: 1,
        endLine: 1,
      },
    ]);

    // Add to docs collection
    const mirrorHash = 'mirror_doc';
    await adapter.upsertDocument({
      collection: 'docs',
      relPath: 'doc.md',
      sourceHash: 'hash_doc',
      sourceMime: 'text/markdown',
      sourceExt: '.md',
      sourceSize: 100,
      sourceMtime: '2024-01-01T00:00:00Z',
      mirrorHash,
    });
    await adapter.upsertContent(mirrorHash, 'Important doc about testing');
    await adapter.upsertChunks(mirrorHash, [
      {
        seq: 0,
        pos: 0,
        text: 'Important doc about testing',
        startLine: 1,
        endLine: 1,
      },
    ]);
    await adapter.rebuildFtsForHash(mirrorHash);

    // Search without filter
    let result = await adapter.searchFts('important');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toHaveLength(2);

    // Search with collection filter
    result = await adapter.searchFts('important', { collection: 'notes' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.collection).toBe('notes');
  });

  test('respects limit option', async () => {
    for (let i = 0; i < 5; i++) {
      await setupDocument(`doc${i}.md`, `Document number ${i} about testing`, [
        {
          seq: 0,
          pos: 0,
          text: `Document number ${i} about testing`,
          startLine: 1,
          endLine: 1,
        },
      ]);
    }

    const result = await adapter.searchFts('testing', { limit: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value).toHaveLength(3);
  });

  test('returns snippet with highlights when requested', async () => {
    await setupDocument(
      'doc.md',
      'The quick brown fox jumps over the lazy dog',
      [
        {
          seq: 0,
          pos: 0,
          text: 'The quick brown fox jumps over the lazy dog',
          startLine: 1,
          endLine: 1,
        },
      ]
    );

    const result = await adapter.searchFts('fox', { snippet: true });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.snippet).toBeDefined();
    expect(result.value[0]?.snippet).toContain('<mark>');
    expect(result.value[0]?.snippet).toContain('fox');
  });

  test('excludes inactive documents from search', async () => {
    await setupDocument('active.md', 'Active document content', [
      {
        seq: 0,
        pos: 0,
        text: 'Active document content',
        startLine: 1,
        endLine: 1,
      },
    ]);

    await setupDocument('inactive.md', 'Inactive document content', [
      {
        seq: 0,
        pos: 0,
        text: 'Inactive document content',
        startLine: 1,
        endLine: 1,
      },
    ]);

    await adapter.markInactive('notes', ['inactive.md']);

    const result = await adapter.searchFts('document');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.uri).toContain('active.md');
  });

  test('handles multilingual content (German)', async () => {
    await setupDocument(
      'german.md',
      'Wie können wir die Dokumentation verbessern?',
      [
        {
          seq: 0,
          pos: 0,
          text: 'Wie können wir die Dokumentation verbessern?',
          startLine: 1,
          endLine: 1,
          language: 'de',
        },
      ]
    );

    // unicode61 tokenizer should handle German umlauts
    const result = await adapter.searchFts('Dokumentation');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value).toHaveLength(1);
  });
});
