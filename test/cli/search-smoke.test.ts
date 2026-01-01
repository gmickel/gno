/**
 * Search commands smoke tests.
 * Tests gno search and gno vsearch CLI behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv';
// biome-ignore lint/performance/noNamespaceImport: ajv-formats requires namespace for .default
import * as addFormatsModule from 'ajv-formats';
import searchResultsSchema from '../../spec/output-schemas/search-results.schema.json';
import { runCli } from '../../src/cli/run';
import { safeRm } from '../helpers/cleanup';

const addFormats = addFormatsModule.default;

// ─────────────────────────────────────────────────────────────────────────────
// Top-level regex patterns (performance optimization)
// ─────────────────────────────────────────────────────────────────────────────

const LINE_PROTOCOL_PATTERN = /#[a-f0-9]+,\d+\.\d+,gno:\/\//;
const LINE_NUMBER_PATTERN = /\d+:/;
const VECTOR_EMBED_PATTERN = /vector|embed|model|download/;

// ─────────────────────────────────────────────────────────────────────────────
// Setup / Teardown
// ─────────────────────────────────────────────────────────────────────────────

let stdoutData: string;
let stderrData: string;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);

function captureOutput() {
  stdoutData = '';
  stderrData = '';
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdoutData += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderrData += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  };
  console.log = (...args: unknown[]) => {
    stdoutData += `${args.join(' ')}\n`;
  };
  console.error = (...args: unknown[]) => {
    stderrData += `${args.join(' ')}\n`;
  };
}

function restoreOutput() {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
}

const TEST_ROOT = join(tmpdir(), 'gno-search-smoke');
let testCounter = 0;

function getTestDir(): string {
  const dir = join(TEST_ROOT, `test-${Date.now()}-${testCounter}`);
  testCounter += 1;
  return dir;
}

async function setupTestEnv(testDir: string) {
  await mkdir(testDir, { recursive: true });
  process.env.GNO_CONFIG_DIR = join(testDir, 'config');
  process.env.GNO_DATA_DIR = join(testDir, 'data');
  process.env.GNO_CACHE_DIR = join(testDir, 'cache');
}

async function cleanupTestEnv(testDir: string) {
  await safeRm(testDir);
  Reflect.deleteProperty(process.env, 'GNO_CONFIG_DIR');
  Reflect.deleteProperty(process.env, 'GNO_DATA_DIR');
  Reflect.deleteProperty(process.env, 'GNO_CACHE_DIR');
}

async function cli(
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  captureOutput();
  try {
    const code = await runCli(['node', 'gno', ...args]);
    return { code, stdout: stdoutData, stderr: stderrData };
  } finally {
    restoreOutput();
  }
}

async function setupTestWithContent(): Promise<string> {
  const testDir = getTestDir();
  await setupTestEnv(testDir);

  const docsDir = join(testDir, 'docs');
  await mkdir(docsDir, { recursive: true });
  await writeFile(
    join(docsDir, 'test.md'),
    '# Test Document\n\nThis is a test markdown file for search testing.\nLine 3 here.\nLine 4 here.'
  );

  await cli('init', docsDir, '--name', 'docs');
  await cli('update');

  return testDir;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema Validation
// ─────────────────────────────────────────────────────────────────────────────

const ajv = new Ajv();
addFormats(ajv);
const validateSearchResults = ajv.compile(searchResultsSchema);

// ─────────────────────────────────────────────────────────────────────────────
// gno search Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('gno search smoke tests', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await setupTestWithContent();
  });

  afterEach(async () => {
    await cleanupTestEnv(testDir);
  });

  test('search returns results from indexed content', async () => {
    const { code, stdout } = await cli('search', 'markdown');
    expect(code).toBe(0);
    expect(stdout).toContain('test.md');
    expect(stdout).toContain('result(s)');
  });

  test('search --json validates against schema', async () => {
    const { code, stdout } = await cli('search', 'markdown', '--json');
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    const valid = validateSearchResults(parsed);
    if (!valid) {
      console.error('Schema validation errors:', validateSearchResults.errors);
    }
    expect(valid).toBe(true);
    expect(parsed.meta.mode).toBe('bm25');
  });

  test('search --files outputs line protocol', async () => {
    const { code, stdout } = await cli('search', 'markdown', '--files');
    expect(code).toBe(0);
    // Spec: #docid,<score>,gno://...
    expect(stdout).toMatch(LINE_PROTOCOL_PATTERN);
  });

  test('search empty query exits 1', async () => {
    const { code, stderr } = await cli('search', '');
    expect(code).toBe(1);
    expect(stderr.toLowerCase()).toContain('cannot be empty');
  });

  test('search --min-score validates range', async () => {
    const { code, stderr } = await cli('search', 'test', '--min-score', '1.5');
    expect(code).toBe(1);
    expect(stderr).toContain('between 0 and 1');
  });

  test('search invalid collection exits 1', async () => {
    const { code } = await cli('search', 'test', '-c', 'nonexistent');
    // Collection filter not found should fail during init
    expect(code).not.toBe(0);
  });

  test('search no results returns exit 0', async () => {
    const { code, stdout } = await cli('search', 'xyznonexistent123');
    expect(code).toBe(0);
    expect(stdout).toContain('No results');
  });

  test('search --line-numbers shows line prefixes', async () => {
    const { code, stdout } = await cli('search', 'markdown', '--line-numbers');
    expect(code).toBe(0);
    // Line numbers should appear (format: N: text)
    expect(stdout).toMatch(LINE_NUMBER_PATTERN);
  });

  test('search --csv produces CSV with header', async () => {
    const { code, stdout } = await cli('search', 'markdown', '--csv');
    expect(code).toBe(0);
    expect(stdout).toContain('docid,score,uri,title,relPath');
  });

  test('search --md produces markdown', async () => {
    const { code, stdout } = await cli('search', 'markdown', '--md');
    expect(code).toBe(0);
    expect(stdout).toContain('# ');
    expect(stdout).toContain('**URI**');
  });

  test('search --xml produces XML', async () => {
    const { code, stdout } = await cli('search', 'markdown', '--xml');
    expect(code).toBe(0);
    expect(stdout).toContain('<?xml version');
    expect(stdout).toContain('<searchResults>');
  });

  test('search -n limits results', async () => {
    const { code, stdout } = await cli('search', 'test', '-n', '1', '--json');
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.results.length).toBeLessThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// gno vsearch Tests (Failure Modes Only - Deterministic)
// ─────────────────────────────────────────────────────────────────────────────

describe('gno vsearch smoke tests (failure modes)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await setupTestWithContent();
  });

  afterEach(async () => {
    await cleanupTestEnv(testDir);
  });

  test('vsearch empty query exits 1', async () => {
    const { code, stderr } = await cli('vsearch', '');
    expect(code).toBe(1);
    expect(stderr.toLowerCase()).toContain('cannot be empty');
  });

  test('vsearch --min-score validates range', async () => {
    const { code, stderr } = await cli(
      'vsearch',
      'test',
      '--min-score',
      '-0.5'
    );
    expect(code).toBe(1);
    expect(stderr).toContain('between 0 and 1');
  });

  test('vsearch without embeddings returns appropriate error', async () => {
    // This test uses content that was indexed but never embedded
    // The error should mention that vectors are unavailable
    const { code, stderr } = await cli('vsearch', 'test');
    // Should fail because no embeddings exist
    expect(code).not.toBe(0);
    // Error should mention vectors or embed
    expect(stderr.toLowerCase()).toMatch(VECTOR_EMBED_PATTERN);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Empty Index Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('search on empty index', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = getTestDir();
    await setupTestEnv(testDir);
    // Create empty docs dir and init with it
    const docsDir = join(testDir, 'docs');
    await mkdir(docsDir, { recursive: true });
    await cli('init', docsDir, '--name', 'docs');
    // Don't add any files, just update to have an empty but valid index
    await cli('update');
  });

  afterEach(async () => {
    await cleanupTestEnv(testDir);
  });

  test('search on empty index returns no results with exit 0', async () => {
    const { code, stdout } = await cli('search', 'anything');
    expect(code).toBe(0);
    expect(stdout).toContain('No results');
  });
});
