/**
 * Integration tests for SQLite adapter.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';

// Windows SQLite file handles may not release immediately after close()
// Increase timeout to allow safeRm retries in afterEach hooks
if (process.platform === 'win32') {
  setDefaultTimeout(15_000);
}

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Collection, Context } from '../../src/config/types';
import { SqliteAdapter } from '../../src/store';
import type { ChunkInput, DocumentInput } from '../../src/store/types';
import { safeRm } from '../helpers/cleanup';

describe('SqliteAdapter', () => {
  let adapter: SqliteAdapter;
  let testDir: string;
  let dbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'gno-store-test-'));
    dbPath = join(testDir, 'test.sqlite');
    adapter = new SqliteAdapter();
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  describe('lifecycle', () => {
    test('opens and closes database', async () => {
      expect(adapter.isOpen()).toBe(false);

      const result = await adapter.open(dbPath, 'unicode61');
      expect(result.ok).toBe(true);
      expect(adapter.isOpen()).toBe(true);

      await adapter.close();
      expect(adapter.isOpen()).toBe(false);
    });

    test('runs initial migrations on fresh database', async () => {
      const result = await adapter.open(dbPath, 'unicode61');

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(result.value.applied).toContain(1);
      expect(result.value.currentVersion).toBe(1);
      expect(result.value.ftsTokenizer).toBe('unicode61');
    });

    test('skips migrations on reopened database', async () => {
      // First open
      let result = await adapter.open(dbPath, 'unicode61');
      expect(result.ok).toBe(true);
      await adapter.close();

      // Second open
      result = await adapter.open(dbPath, 'unicode61');
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(result.value.applied).toHaveLength(0);
      expect(result.value.currentVersion).toBe(1);
    });

    test('rejects tokenizer mismatch', async () => {
      // First open with unicode61
      let result = await adapter.open(dbPath, 'unicode61');
      expect(result.ok).toBe(true);
      await adapter.close();

      // Second open with porter - should fail
      adapter = new SqliteAdapter();
      result = await adapter.open(dbPath, 'porter');
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }

      expect(result.error.code).toBe('MIGRATION_FAILED');
      expect(result.error.message).toContain('tokenizer mismatch');
    });
  });

  describe('collections sync', () => {
    beforeEach(async () => {
      await adapter.open(dbPath, 'unicode61');
    });

    test('syncs collections from config', async () => {
      const collections: Collection[] = [
        {
          name: 'notes',
          path: '/home/user/notes',
          pattern: '**/*.md',
          include: ['.md'],
          exclude: ['.git'],
        },
        {
          name: 'docs',
          path: '/home/user/docs',
          pattern: '**/*',
          include: [],
          exclude: [],
        },
      ];

      const syncResult = await adapter.syncCollections(collections);
      expect(syncResult.ok).toBe(true);

      const getResult = await adapter.getCollections();
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) {
        return;
      }

      expect(getResult.value).toHaveLength(2);

      const notes = getResult.value.find((c) => c.name === 'notes');
      expect(notes).toBeDefined();
      expect(notes?.path).toBe('/home/user/notes');
      expect(notes?.pattern).toBe('**/*.md');
      expect(notes?.include).toEqual(['.md']);
      expect(notes?.exclude).toEqual(['.git']);
    });

    test('removes deleted collections on sync', async () => {
      const initialCollections: Collection[] = [
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
      ];

      await adapter.syncCollections(initialCollections);

      // Remove 'docs' from config
      const updatedCollections: Collection[] = [
        {
          name: 'notes',
          path: '/notes',
          pattern: '**/*',
          include: [],
          exclude: [],
        },
      ];

      await adapter.syncCollections(updatedCollections);

      const result = await adapter.getCollections();
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.name).toBe('notes');
    });
  });

  describe('contexts sync', () => {
    beforeEach(async () => {
      await adapter.open(dbPath, 'unicode61');
    });

    test('syncs contexts from config', async () => {
      const contexts: Context[] = [
        { scopeType: 'global', scopeKey: '/', text: 'Global context' },
        {
          scopeType: 'collection',
          scopeKey: 'notes:',
          text: 'Notes collection context',
        },
      ];

      const syncResult = await adapter.syncContexts(contexts);
      expect(syncResult.ok).toBe(true);

      const getResult = await adapter.getContexts();
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) {
        return;
      }

      expect(getResult.value).toHaveLength(2);

      const global = getResult.value.find((c) => c.scopeType === 'global');
      expect(global?.text).toBe('Global context');
    });
  });

  describe('documents', () => {
    beforeEach(async () => {
      await adapter.open(dbPath, 'unicode61');
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

    test('upserts and retrieves document', async () => {
      const doc: DocumentInput = {
        collection: 'notes',
        relPath: 'readme.md',
        sourceHash: 'abc123def456',
        sourceMime: 'text/markdown',
        sourceExt: '.md',
        sourceSize: 1024,
        sourceMtime: '2024-01-01T00:00:00Z',
        title: 'README',
        mirrorHash: 'mirror123',
        converterId: 'native/markdown',
        converterVersion: '1.0.0',
      };

      const upsertResult = await adapter.upsertDocument(doc);
      expect(upsertResult.ok).toBe(true);
      if (!upsertResult.ok) {
        return;
      }

      // docid is derived from sourceHash (8 hex chars)
      expect(upsertResult.value).toBe('#abc123de');

      const getResult = await adapter.getDocument('notes', 'readme.md');
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) {
        return;
      }

      expect(getResult.value).not.toBeNull();
      expect(getResult.value?.docid).toBe('#abc123de');
      expect(getResult.value?.uri).toBe('gno://notes/readme.md');
      expect(getResult.value?.title).toBe('README');
      expect(getResult.value?.active).toBe(true);
    });

    test('retrieves document by docid', async () => {
      const doc: DocumentInput = {
        collection: 'notes',
        relPath: 'test.md',
        sourceHash: 'xyz789',
        sourceMime: 'text/markdown',
        sourceExt: '.md',
        sourceSize: 512,
        sourceMtime: '2024-01-01T00:00:00Z',
      };

      await adapter.upsertDocument(doc);

      const result = await adapter.getDocumentByDocid('#xyz789');
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(result.value).not.toBeNull();
      expect(result.value?.relPath).toBe('test.md');
    });

    test('retrieves document by URI', async () => {
      const doc: DocumentInput = {
        collection: 'notes',
        relPath: 'subdir/file.md',
        sourceHash: 'uri123',
        sourceMime: 'text/markdown',
        sourceExt: '.md',
        sourceSize: 256,
        sourceMtime: '2024-01-01T00:00:00Z',
      };

      await adapter.upsertDocument(doc);

      const result = await adapter.getDocumentByUri(
        'gno://notes/subdir/file.md'
      );
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(result.value).not.toBeNull();
      expect(result.value?.relPath).toBe('subdir/file.md');
    });

    test('marks documents inactive', async () => {
      await adapter.upsertDocument({
        collection: 'notes',
        relPath: 'a.md',
        sourceHash: 'hash_a',
        sourceMime: 'text/markdown',
        sourceExt: '.md',
        sourceSize: 100,
        sourceMtime: '2024-01-01T00:00:00Z',
      });

      await adapter.upsertDocument({
        collection: 'notes',
        relPath: 'b.md',
        sourceHash: 'hash_b',
        sourceMime: 'text/markdown',
        sourceExt: '.md',
        sourceSize: 100,
        sourceMtime: '2024-01-01T00:00:00Z',
      });

      const markResult = await adapter.markInactive('notes', ['a.md']);
      expect(markResult.ok).toBe(true);
      if (!markResult.ok) {
        return;
      }
      expect(markResult.value).toBe(1);

      const docA = await adapter.getDocument('notes', 'a.md');
      expect(docA.ok).toBe(true);
      if (!docA.ok) {
        return;
      }
      expect(docA.value?.active).toBe(false);

      const docB = await adapter.getDocument('notes', 'b.md');
      expect(docB.ok).toBe(true);
      if (!docB.ok) {
        return;
      }
      expect(docB.value?.active).toBe(true);
    });

    test('lists documents with optional collection filter', async () => {
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

      await adapter.upsertDocument({
        collection: 'notes',
        relPath: 'note.md',
        sourceHash: 'note_hash',
        sourceMime: 'text/markdown',
        sourceExt: '.md',
        sourceSize: 100,
        sourceMtime: '2024-01-01T00:00:00Z',
      });

      await adapter.upsertDocument({
        collection: 'docs',
        relPath: 'doc.md',
        sourceHash: 'doc_hash',
        sourceMime: 'text/markdown',
        sourceExt: '.md',
        sourceSize: 100,
        sourceMtime: '2024-01-01T00:00:00Z',
      });

      // All documents
      let result = await adapter.listDocuments();
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value).toHaveLength(2);

      // Filtered by collection
      result = await adapter.listDocuments('notes');
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.collection).toBe('notes');
    });
  });

  describe('content', () => {
    beforeEach(async () => {
      await adapter.open(dbPath, 'unicode61');
    });

    test('upserts and retrieves content by mirror hash', async () => {
      const markdown = '# Hello World\n\nThis is content.';
      const mirrorHash = 'content_hash_123';

      const upsertResult = await adapter.upsertContent(mirrorHash, markdown);
      expect(upsertResult.ok).toBe(true);

      const getResult = await adapter.getContent(mirrorHash);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) {
        return;
      }

      expect(getResult.value).toBe(markdown);
    });

    test('returns null for missing content', async () => {
      const result = await adapter.getContent('nonexistent');
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value).toBeNull();
    });

    test('upsert is idempotent', async () => {
      const mirrorHash = 'idem_hash';
      const markdown = 'content';

      await adapter.upsertContent(mirrorHash, markdown);
      await adapter.upsertContent(mirrorHash, 'different content');

      const result = await adapter.getContent(mirrorHash);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      // Original content is preserved (ON CONFLICT DO NOTHING)
      expect(result.value).toBe(markdown);
    });
  });

  describe('chunks', () => {
    beforeEach(async () => {
      await adapter.open(dbPath, 'unicode61');
      await adapter.upsertContent('chunk_mirror', '# Content\n\nParagraph.');
    });

    test('upserts and retrieves chunks', async () => {
      const chunks: ChunkInput[] = [
        {
          seq: 0,
          pos: 0,
          text: '# Content',
          startLine: 1,
          endLine: 1,
          language: 'en',
        },
        {
          seq: 1,
          pos: 10,
          text: 'Paragraph.',
          startLine: 3,
          endLine: 3,
          language: 'en',
        },
      ];

      const upsertResult = await adapter.upsertChunks('chunk_mirror', chunks);
      expect(upsertResult.ok).toBe(true);

      const getResult = await adapter.getChunks('chunk_mirror');
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) {
        return;
      }

      expect(getResult.value).toHaveLength(2);
      expect(getResult.value[0]?.seq).toBe(0);
      expect(getResult.value[0]?.text).toBe('# Content');
      expect(getResult.value[1]?.seq).toBe(1);
    });

    test('replaces existing chunks on upsert', async () => {
      const initialChunks: ChunkInput[] = [
        { seq: 0, pos: 0, text: 'old', startLine: 1, endLine: 1 },
      ];

      await adapter.upsertChunks('chunk_mirror', initialChunks);

      const newChunks: ChunkInput[] = [
        { seq: 0, pos: 0, text: 'new1', startLine: 1, endLine: 1 },
        { seq: 1, pos: 5, text: 'new2', startLine: 2, endLine: 2 },
      ];

      await adapter.upsertChunks('chunk_mirror', newChunks);

      const result = await adapter.getChunks('chunk_mirror');
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(result.value).toHaveLength(2);
      expect(result.value[0]?.text).toBe('new1');
    });
  });

  describe('getChunksBatch', () => {
    beforeEach(async () => {
      await adapter.open(dbPath, 'unicode61');
    });

    test('returns empty Map for empty input', async () => {
      const result = await adapter.getChunksBatch([]);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.size).toBe(0);
    });

    test('returns empty Map for only empty/whitespace strings', async () => {
      const result = await adapter.getChunksBatch(['', '  ', '\t']);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.size).toBe(0);
    });

    test('single hash equivalence to getChunks', async () => {
      await adapter.upsertContent('batch_test', 'content');
      const chunks: ChunkInput[] = [
        { seq: 0, pos: 0, text: 'chunk0', startLine: 1, endLine: 1 },
        { seq: 1, pos: 7, text: 'chunk1', startLine: 2, endLine: 2 },
      ];
      await adapter.upsertChunks('batch_test', chunks);

      // Compare single getChunks vs getChunksBatch
      const single = await adapter.getChunks('batch_test');
      const batch = await adapter.getChunksBatch(['batch_test']);

      expect(single.ok).toBe(true);
      expect(batch.ok).toBe(true);
      if (!(single.ok && batch.ok)) {
        return;
      }

      const batchChunks = batch.value.get('batch_test') ?? [];
      expect(batchChunks).toEqual(single.value);
    });

    test('multiple unique hashes with ordering preserved', async () => {
      // Create content for two hashes
      await adapter.upsertContent('hash_a', 'a');
      await adapter.upsertContent('hash_b', 'b');

      await adapter.upsertChunks('hash_a', [
        { seq: 0, pos: 0, text: 'a0', startLine: 1, endLine: 1 },
        { seq: 1, pos: 2, text: 'a1', startLine: 2, endLine: 2 },
      ]);
      await adapter.upsertChunks('hash_b', [
        { seq: 0, pos: 0, text: 'b0', startLine: 1, endLine: 1 },
        { seq: 1, pos: 2, text: 'b1', startLine: 2, endLine: 2 },
        { seq: 2, pos: 4, text: 'b2', startLine: 3, endLine: 3 },
      ]);

      const result = await adapter.getChunksBatch(['hash_b', 'hash_a']);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(result.value.size).toBe(2);

      const aChunks = result.value.get('hash_a') ?? [];
      expect(aChunks).toHaveLength(2);
      expect(aChunks[0]?.seq).toBe(0);
      expect(aChunks[1]?.seq).toBe(1);

      const bChunks = result.value.get('hash_b') ?? [];
      expect(bChunks).toHaveLength(3);
      expect(bChunks[0]?.seq).toBe(0);
      expect(bChunks[1]?.seq).toBe(1);
      expect(bChunks[2]?.seq).toBe(2);
    });

    test('dedups duplicate hashes in input', async () => {
      await adapter.upsertContent('dedup_hash', 'content');
      await adapter.upsertChunks('dedup_hash', [
        { seq: 0, pos: 0, text: 'only', startLine: 1, endLine: 1 },
      ]);

      const result = await adapter.getChunksBatch([
        'dedup_hash',
        'dedup_hash',
        'dedup_hash',
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(result.value.size).toBe(1);
      expect(result.value.get('dedup_hash')?.length).toBe(1);
    });

    test('mix of existing and non-existing hashes', async () => {
      await adapter.upsertContent('exists', 'x');
      await adapter.upsertChunks('exists', [
        { seq: 0, pos: 0, text: 'data', startLine: 1, endLine: 1 },
      ]);

      const result = await adapter.getChunksBatch([
        'exists',
        'not_here',
        'also_missing',
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      // Only 'exists' should be in the map
      expect(result.value.size).toBe(1);
      expect(result.value.has('exists')).toBe(true);
      expect(result.value.has('not_here')).toBe(false);
    });

    // Windows SQLite is ~4x slower due to NTFS + journaling + Defender scanning
    test(
      'large batch (>900 hashes) is correctly batched',
      async () => {
        // Create 950 hashes (should split into 2 batches with SQLITE_MAX_PARAMS=900)
        const hashes: string[] = [];
        for (let i = 0; i < 950; i++) {
          const hash = `large_batch_${i}`;
          hashes.push(hash);
          await adapter.upsertContent(hash, `content ${i}`);
          await adapter.upsertChunks(hash, [
            { seq: 0, pos: 0, text: `chunk ${i}`, startLine: 1, endLine: 1 },
          ]);
        }

        const result = await adapter.getChunksBatch(hashes);
        expect(result.ok).toBe(true);
        if (!result.ok) {
          return;
        }

        expect(result.value.size).toBe(950);

        // Verify first and last entries
        expect(result.value.get('large_batch_0')?.[0]?.text).toBe('chunk 0');
        expect(result.value.get('large_batch_949')?.[0]?.text).toBe(
          'chunk 949'
        );
      },
      { timeout: 60_000 }
    ); // 60s for Windows
  });

  describe('status', () => {
    beforeEach(async () => {
      await adapter.open(dbPath, 'unicode61');
    });

    test('returns index status', async () => {
      await adapter.syncCollections([
        {
          name: 'notes',
          path: '/notes',
          pattern: '**/*',
          include: [],
          exclude: [],
        },
      ]);

      await adapter.upsertDocument({
        collection: 'notes',
        relPath: 'test.md',
        sourceHash: 'status_hash',
        sourceMime: 'text/markdown',
        sourceExt: '.md',
        sourceSize: 100,
        sourceMtime: '2024-01-01T00:00:00Z',
        mirrorHash: 'status_mirror',
      });

      await adapter.upsertContent('status_mirror', '# Test');
      await adapter.upsertChunks('status_mirror', [
        { seq: 0, pos: 0, text: '# Test', startLine: 1, endLine: 1 },
      ]);

      const result = await adapter.getStatus();
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(result.value.version).toBe('1');
      expect(result.value.ftsTokenizer).toBe('unicode61');
      expect(result.value.dbPath).toBe(dbPath);
      expect(result.value.totalDocuments).toBe(1);
      expect(result.value.activeDocuments).toBe(1);
      expect(result.value.totalChunks).toBe(1);
      // All chunks are in embedding backlog (no vectors yet)
      expect(result.value.embeddingBacklog).toBe(1);
      expect(result.value.collections).toHaveLength(1);
      expect(result.value.collections[0]?.name).toBe('notes');
    });
  });

  describe('errors', () => {
    beforeEach(async () => {
      await adapter.open(dbPath, 'unicode61');
    });

    test('records and retrieves ingest errors', async () => {
      await adapter.recordError({
        collection: 'notes',
        relPath: 'broken.pdf',
        code: 'CORRUPT',
        message: 'Invalid PDF structure',
        details: { page: 5 },
      });

      const result = await adapter.getRecentErrors(10);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.code).toBe('CORRUPT');
      expect(result.value[0]?.message).toBe('Invalid PDF structure');
      expect(result.value[0]?.detailsJson).toContain('"page":5');
    });
  });

  describe('cleanup', () => {
    beforeEach(async () => {
      await adapter.open(dbPath, 'unicode61');
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

    test('removes orphaned content', async () => {
      // Create document with content
      await adapter.upsertDocument({
        collection: 'notes',
        relPath: 'test.md',
        sourceHash: 'cleanup_doc',
        sourceMime: 'text/markdown',
        sourceExt: '.md',
        sourceSize: 100,
        sourceMtime: '2024-01-01T00:00:00Z',
        mirrorHash: 'cleanup_mirror',
      });

      await adapter.upsertContent('cleanup_mirror', '# Test');
      await adapter.upsertContent('orphan_content', '# Orphan');

      // Mark document inactive
      await adapter.markInactive('notes', ['test.md']);

      const result = await adapter.cleanupOrphans();
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      // Both contents should be cleaned (doc is inactive)
      expect(result.value.orphanedContent).toBe(2);

      // Verify content is gone
      const content = await adapter.getContent('orphan_content');
      expect(content.ok).toBe(true);
      if (!content.ok) {
        return;
      }
      expect(content.value).toBeNull();
    });
  });
});
