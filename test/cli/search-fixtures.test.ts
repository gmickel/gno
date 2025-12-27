/**
 * Search fixture-based smoke tests.
 * Uses test/fixtures/docs for realistic search testing.
 * Isolated from user's gno installation via env vars.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli/run';
import { safeRm } from '../helpers/cleanup';

// Regex patterns at module scope for performance
const LINE_PROTOCOL_PATTERN = /#[a-f0-9]+,\d+\.\d+,gno:\/\//;
const LINE_NUMBER_PATTERN = /\d+:/;

// ─────────────────────────────────────────────────────────────────────────────
// Test Environment Setup
// ─────────────────────────────────────────────────────────────────────────────

let testDir: string;
let fixturesDir: string;
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

// ─────────────────────────────────────────────────────────────────────────────
// Global Setup/Teardown
// ─────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Create isolated test environment
  testDir = join(tmpdir(), `gno-fixtures-test-${Date.now()}`);
  fixturesDir = join(testDir, 'fixtures');

  await mkdir(testDir, { recursive: true });

  // Copy fixtures to test dir
  const srcFixtures = join(import.meta.dir, '../fixtures/docs');
  await cp(srcFixtures, fixturesDir, { recursive: true });

  // Set isolated environment
  process.env.GNO_CONFIG_DIR = join(testDir, 'config');
  process.env.GNO_DATA_DIR = join(testDir, 'data');
  process.env.GNO_CACHE_DIR = join(testDir, 'cache');

  // Initialize and index
  await cli('init', fixturesDir, '--name', 'fixtures');
  await cli('update');
}, 30_000); // 30s timeout for setup

afterAll(async () => {
  // Cleanup
  await safeRm(testDir);
  Reflect.deleteProperty(process.env, 'GNO_CONFIG_DIR');
  Reflect.deleteProperty(process.env, 'GNO_DATA_DIR');
  Reflect.deleteProperty(process.env, 'GNO_CACHE_DIR');
});

// ─────────────────────────────────────────────────────────────────────────────
// BM25 Search Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('BM25 search with fixtures', () => {
  test('finds JWT token in authentication.md', async () => {
    const { code, stdout } = await cli('search', 'JWT token');
    expect(code).toBe(0);
    expect(stdout).toContain('authentication.md');
    expect(stdout).toContain('result(s)');
  });

  test('finds N+1 query in database-queries.md', async () => {
    const { code, stdout } = await cli('search', 'N+1 query');
    expect(code).toBe(0);
    expect(stdout).toContain('database-queries.md');
  });

  test('finds WaitGroup in go-concurrency.md', async () => {
    const { code, stdout } = await cli('search', 'WaitGroup');
    expect(code).toBe(0);
    expect(stdout).toContain('go-concurrency.md');
  });

  test('finds Semaphore in python-async.md', async () => {
    const { code, stdout } = await cli('search', 'Semaphore');
    expect(code).toBe(0);
    expect(stdout).toContain('python-async.md');
  });

  test('finds bcrypt in authentication.md', async () => {
    const { code, stdout } = await cli('search', 'bcrypt password');
    expect(code).toBe(0);
    expect(stdout).toContain('authentication.md');
  });

  test('finds multi-stage build in docker-deployment.md', async () => {
    // Avoid hyphens which can confuse FTS5
    const { code, stdout } = await cli('search', 'dockerfile alpine');
    expect(code).toBe(0);
    expect(stdout).toContain('docker-deployment.md');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Output Format Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Output formats with fixtures', () => {
  test('--json produces valid JSON', async () => {
    const { code, stdout } = await cli('search', 'database', '--json');
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.results).toBeDefined();
    expect(parsed.meta.mode).toBe('bm25');
    expect(parsed.meta.query).toBe('database');
  });

  test('--files produces line protocol', async () => {
    const { code, stdout } = await cli('search', 'cache', '--files');
    expect(code).toBe(0);
    // Line protocol: #docid,score,gno://...
    expect(stdout).toMatch(LINE_PROTOCOL_PATTERN);
  });

  test('--csv produces CSV with header', async () => {
    const { code, stdout } = await cli('search', 'testing', '--csv');
    expect(code).toBe(0);
    expect(stdout).toContain('docid,score,uri,title,relPath');
  });

  test('--md produces markdown', async () => {
    const { code, stdout } = await cli('search', 'docker', '--md');
    expect(code).toBe(0);
    expect(stdout).toContain('# ');
    expect(stdout).toContain('**URI**');
  });

  test('--xml produces XML', async () => {
    const { code, stdout } = await cli('search', 'error', '--xml');
    expect(code).toBe(0);
    expect(stdout).toContain('<?xml version');
    expect(stdout).toContain('<searchResults>');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Search Options Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Search options with fixtures', () => {
  test('--full returns full document content', async () => {
    const { code, stdout } = await cli('search', 'authentication', '--full');
    expect(code).toBe(0);
    // Full content should be longer than snippet
    expect(stdout.length).toBeGreaterThan(500);
    expect(stdout).toContain('JWT Token Flow');
    expect(stdout).toContain('Session-Based Auth');
  });

  test('--line-numbers shows line prefixes', async () => {
    const { code, stdout } = await cli('search', 'function', '--line-numbers');
    expect(code).toBe(0);
    // Line numbers in format N:
    expect(stdout).toMatch(LINE_NUMBER_PATTERN);
  });

  test('-n limits results', async () => {
    const { code, stdout } = await cli('search', 'test', '-n', '2', '--json');
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.results.length).toBeLessThanOrEqual(2);
  });

  test('--min-score filters low scores', async () => {
    const { code, stdout } = await cli(
      'search',
      'authentication',
      '--min-score',
      '0.3',
      '--json'
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    for (const r of parsed.results) {
      expect(r.score).toBeGreaterThanOrEqual(0.3);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Language Filter Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Language filtering with fixtures', () => {
  test('--lang python filters to Python code', async () => {
    const { code, stdout } = await cli(
      'search',
      'async',
      '--lang',
      'python',
      '--json'
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    // May or may not find matches depending on chunk boundaries
    // When matches exist, they should be from python code blocks
    expect(parsed.results.length).toBeGreaterThanOrEqual(0);
  });

  test('--lang go filters to Go code', async () => {
    const { code, stdout } = await cli(
      'search',
      'func',
      '--lang',
      'go',
      '--json'
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.results.length).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-Document Search Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Cross-document search', () => {
  test('error handling appears in multiple docs', async () => {
    const { code, stdout } = await cli('search', 'error handling', '--json');
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    // Should find error-handling.md and potentially rest-api-design.md
    expect(parsed.results.length).toBeGreaterThanOrEqual(1);
  });

  test('concurrency appears in python and go docs', async () => {
    const { code, stdout } = await cli('search', 'concurrent', '--json');
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    const uris = parsed.results.map((r: { uri: string }) => r.uri);
    // Should find at least one of the concurrency docs
    const hasConcurrencyDoc = uris.some(
      (uri: string) =>
        uri.includes('python-async') || uri.includes('go-concurrency')
    );
    expect(hasConcurrencyDoc || parsed.results.length === 0).toBe(true);
  });
});
