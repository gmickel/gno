/**
 * Search quality TDD tests.
 * These tests FAIL with current implementation, proving the problems exist.
 * After epic gno-5hk implementation, these tests should pass.
 *
 * @module test/pipeline/search-quality
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchBm25 } from '../../src/pipeline/search';
import { SqliteAdapter } from '../../src/store';
import type { ChunkInput } from '../../src/store/types';
import { safeRm } from '../helpers/cleanup';

// Windows needs longer timeout for file handle release
if (process.platform === 'win32') {
  setDefaultTimeout(15_000);
}

// Fixtures path
const FIXTURES_DIR = join(import.meta.dir, '../fixtures/docs');

// Top-level regex for performance
const TITLE_REGEX = /^#\s+(.+)$/m;
const PARAGRAPH_SPLIT_REGEX = /\n\n+/;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface TestDoc {
  relPath: string;
  content: string;
  title: string;
}

async function loadFixtures(): Promise<TestDoc[]> {
  const files = await readdir(FIXTURES_DIR);
  const mdFiles = files.filter((f) => f.endsWith('.md') && f !== 'README.md');

  const docs: TestDoc[] = [];
  for (const file of mdFiles) {
    const content = await Bun.file(join(FIXTURES_DIR, file)).text();
    // Extract title from first # heading
    const titleMatch = content.match(TITLE_REGEX);
    docs.push({
      relPath: file,
      content,
      title: titleMatch?.[1] ?? file.replace('.md', ''),
    });
  }
  return docs;
}

/**
 * Simple chunking for testing.
 * Splits by double newlines, creates ~500 char chunks.
 */
function simpleChunk(content: string): ChunkInput[] {
  const paragraphs = content.split(PARAGRAPH_SPLIT_REGEX);
  const chunks: ChunkInput[] = [];
  let currentChunk = '';
  let startLine = 1;
  let currentLine = 1;

  for (const para of paragraphs) {
    const paraLines = para.split('\n').length;

    if (currentChunk.length + para.length > 500 && currentChunk.length > 0) {
      chunks.push({
        seq: chunks.length,
        pos: chunks.length * 500,
        text: currentChunk.trim(),
        startLine,
        endLine: currentLine - 1,
        tokenCount: Math.ceil(currentChunk.length / 4),
      });
      currentChunk = '';
      startLine = currentLine;
    }

    currentChunk += (currentChunk ? '\n\n' : '') + para;
    currentLine += paraLines + 1;
  }

  if (currentChunk.trim()) {
    chunks.push({
      seq: chunks.length,
      pos: chunks.length * 500,
      text: currentChunk.trim(),
      startLine,
      endLine: currentLine - 1,
      tokenCount: Math.ceil(currentChunk.length / 4),
    });
  }

  return chunks;
}

async function setupTestDb(
  adapter: SqliteAdapter,
  dbPath: string,
  tokenizer: 'unicode61' | 'snowball english' = 'snowball english'
): Promise<void> {
  await adapter.open(dbPath, tokenizer);

  // Sync test collection
  await adapter.syncCollections([
    {
      name: 'test',
      path: FIXTURES_DIR,
      pattern: '**/*.md',
      include: [],
      exclude: [],
    },
  ]);

  // Load and index all fixtures
  const docs = await loadFixtures();

  for (const doc of docs) {
    const sourceHash = Bun.hash(doc.content).toString(16);
    const mirrorHash = sourceHash; // Same for markdown

    // Upsert document
    await adapter.upsertDocument({
      sourceHash,
      collection: 'test',
      relPath: doc.relPath,
      sourceMime: 'text/markdown',
      sourceExt: '.md',
      sourceMtime: new Date().toISOString(),
      sourceSize: doc.content.length,
      mirrorHash,
      title: doc.title,
    });

    // Upsert content
    await adapter.upsertContent(mirrorHash, doc.content);

    // Sync to document-level FTS
    await adapter.syncDocumentFts('test', doc.relPath);

    // Chunk and index (still needed for vector search)
    const chunks = simpleChunk(doc.content);
    await adapter.upsertChunks(mirrorHash, chunks);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Search Quality - Document-Level BM25', () => {
  let adapter: SqliteAdapter;
  let testDir: string;
  let dbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'gno-search-quality-'));
    dbPath = join(testDir, 'test.sqlite');
    adapter = new SqliteAdapter();
    await setupTestDb(adapter, dbPath);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  test('finds document when query terms span multiple chunks', async () => {
    // "gmickel-bench" is in intro (chunk 1), "total score" is in summary table (last chunk)
    // Current chunk-level BM25 fails because no single chunk has both terms
    // Document-level BM25 succeeds because it indexes the whole document
    const result = await searchBm25(adapter, 'gmickel-bench total score');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    // Should find the AI eval results document
    expect(result.value.results.length).toBeGreaterThan(0);
    const found = result.value.results.some(
      (r) => r.source.relPath === 'ai-eval-results.md'
    );

    expect(found).toBe(true);
  });

  test('finds document with terms in different sections', async () => {
    // Query for "goroutines channels" which appear in different sections
    // of go-concurrency.md - tests document-level matching
    const result = await searchBm25(adapter, 'goroutines channels mutex');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    // Should find go-concurrency.md
    expect(result.value.results.length).toBeGreaterThan(0);
    const paths = result.value.results.map((r) => r.source.relPath);
    expect(paths.includes('go-concurrency.md')).toBe(true);
  });
});

describe('Search Quality - Stemming', () => {
  let adapter: SqliteAdapter;
  let testDir: string;
  let dbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'gno-stemming-'));
    dbPath = join(testDir, 'test.sqlite');
    adapter = new SqliteAdapter();
    await setupTestDb(adapter, dbPath);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  test('stemming: "scored" matches documents containing "score"', async () => {
    // ai-eval-results.md contains "scored" in body text
    // With snowball stemming, "scored" stems to match "score" variants
    const result = await searchBm25(adapter, 'scored models');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    // Should find results - with stemming, "scored" matches "score"
    expect(result.value.results.length).toBeGreaterThan(0);
    const found = result.value.results.some(
      (r) => r.source.relPath === 'ai-eval-results.md'
    );

    expect(found).toBe(true);
  });

  test('stemming: "running" matches documents containing "run"', async () => {
    // Tests stem matching: running -> run
    const result = await searchBm25(adapter, 'running tests');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    // testing-strategies.md has content about running tests
    const hasRunMatch = result.value.results.some(
      (r) =>
        r.snippet.toLowerCase().includes('run') ||
        r.snippet.toLowerCase().includes('test')
    );

    expect(hasRunMatch).toBe(true);
  });

  test('stemming: plural forms match singular', async () => {
    // "workers" should match "worker", "goroutines" should match "goroutine"
    const result = await searchBm25(adapter, 'workers processing jobs');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    // go-concurrency.md has Worker/worker and job/jobs
    const found = result.value.results.some(
      (r) =>
        r.source.relPath === 'go-concurrency.md' ||
        r.snippet.toLowerCase().includes('worker')
    );

    expect(found).toBe(true);
  });
});

describe('Search Quality - Result Relevance', () => {
  let adapter: SqliteAdapter;
  let testDir: string;
  let dbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'gno-relevance-'));
    dbPath = join(testDir, 'test.sqlite');
    adapter = new SqliteAdapter();
    await setupTestDb(adapter, dbPath);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  test('top result contains most relevant content', async () => {
    // Query specifically about Go concurrency should rank go-concurrency.md first
    const result = await searchBm25(adapter, 'goroutines channels waitgroup');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.results.length).toBeGreaterThan(0);

    // Top result should be go-concurrency.md (most relevant)
    const topResult = result.value.results[0];
    expect(topResult?.source.relPath).toBe('go-concurrency.md');
  });

  test('returns results even for partial matches', async () => {
    // Even if not all terms match, should return relevant docs
    const result = await searchBm25(adapter, 'Python asyncio semaphores');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    // Should find python-async.md which has asyncio and Semaphore
    const found = result.value.results.some(
      (r) => r.source.relPath === 'python-async.md'
    );

    expect(found).toBe(true);
  });
});

describe('Search Quality - Full Document Context', () => {
  let adapter: SqliteAdapter;
  let testDir: string;
  let dbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'gno-full-doc-'));
    dbPath = join(testDir, 'test.sqlite');
    adapter = new SqliteAdapter();
    await setupTestDb(adapter, dbPath);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  test('--full returns complete document content', async () => {
    const result = await searchBm25(adapter, 'goroutines', { full: true });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    // Find the go-concurrency result
    const goResult = result.value.results.find(
      (r) => r.source.relPath === 'go-concurrency.md'
    );

    expect(goResult).toBeDefined();
    if (!goResult) {
      return;
    }

    // Full content should include sections from throughout the document
    // (not just the chunk that matched)
    expect(goResult.snippet).toContain('# Go Concurrency Patterns');
    expect(goResult.snippet).toContain('WaitGroups');
    expect(goResult.snippet).toContain('Mutex for Shared State');
    expect(goResult.snippet).toContain('Error Groups');
  });

  test('full document includes data tables', async () => {
    // This is the key test case from the epic
    // The answer "494.6" is in a table at the end of the document
    const result = await searchBm25(adapter, 'gmickel-bench evaluation', {
      full: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const evalResult = result.value.results.find(
      (r) => r.source.relPath === 'ai-eval-results.md'
    );

    expect(evalResult).toBeDefined();
    if (!evalResult) {
      return;
    }

    // Full doc should include the summary table with scores
    expect(evalResult.snippet).toContain('494.6');
    expect(evalResult.snippet).toContain('GPT-5.2-xhigh');
  });
});
