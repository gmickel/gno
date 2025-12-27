/**
 * gno multi-get command smoke tests.
 * Tests CLI behavior via runCli().
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv';
// biome-ignore lint/performance/noNamespaceImport: ajv-formats requires namespace for .default
import * as addFormatsModule from 'ajv-formats';
import multiGetSchema from '../../spec/output-schemas/multi-get.schema.json';
import { runCli } from '../../src/cli/run';
import { safeRm } from '../helpers/cleanup';

const addFormats = addFormatsModule.default;

// ─────────────────────────────────────────────────────────────────────────────
// Top-level regex patterns
// ─────────────────────────────────────────────────────────────────────────────

const FILE_PROTOCOL_PATTERN = /#[a-f0-9]+,gno:\/\//;

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

const TEST_ROOT = join(tmpdir(), 'gno-multi-get-smoke');
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
  await writeFile(join(docsDir, 'doc1.md'), '# Document 1\n\nContent 1.');
  await writeFile(join(docsDir, 'doc2.md'), '# Document 2\n\nContent 2.');
  await writeFile(join(docsDir, 'doc3.md'), '# Document 3\n\nContent 3.');
  // Large doc for truncation test
  await writeFile(
    join(docsDir, 'large.md'),
    `# Large Document\n\n${'Line of content here.\n'.repeat(1000)}`
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
const validateMultiGet = ajv.compile(multiGetSchema);

// ─────────────────────────────────────────────────────────────────────────────
// gno multi-get Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('gno multi-get smoke tests', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await setupTestWithContent();
  });

  afterEach(async () => {
    await cleanupTestEnv(testDir);
  });

  test('retrieves multiple documents', async () => {
    const { code, stdout } = await cli(
      'multi-get',
      'docs/doc1.md',
      'docs/doc2.md'
    );
    expect(code).toBe(0);
    expect(stdout).toContain('Document 1');
    expect(stdout).toContain('Document 2');
    expect(stdout).toContain('2/2 documents');
  });

  test('accepts comma-separated refs', async () => {
    const { code, stdout } = await cli(
      'multi-get',
      'docs/doc1.md,docs/doc2.md'
    );
    expect(code).toBe(0);
    expect(stdout).toContain('2/2 documents');
  });

  test('--json validates against schema', async () => {
    const { code, stdout } = await cli(
      'multi-get',
      'docs/doc1.md',
      'docs/doc2.md',
      '--json'
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    const valid = validateMultiGet(parsed);
    if (!valid) {
      console.error('Schema validation errors:', validateMultiGet.errors);
    }
    expect(valid).toBe(true);
    expect(parsed.documents).toHaveLength(2);
    expect(parsed.meta.returned).toBe(2);
  });

  test('--files outputs file protocol', async () => {
    const { code, stdout } = await cli('multi-get', 'docs/doc1.md', '--files');
    expect(code).toBe(0);
    expect(stdout).toMatch(FILE_PROTOCOL_PATTERN);
  });

  test('--md produces markdown output', async () => {
    const { code, stdout } = await cli(
      'multi-get',
      'docs/doc1.md',
      'docs/doc2.md',
      '--md'
    );
    expect(code).toBe(0);
    expect(stdout).toContain('# Multi-Get Results');
    expect(stdout).toContain('**URI**');
  });

  test('handles glob patterns', async () => {
    const { code, stdout } = await cli('multi-get', 'docs/*.md', '--json');
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    // Should match all 4 docs
    expect(parsed.documents.length).toBeGreaterThanOrEqual(4);
  });

  test('tracks skipped documents', async () => {
    const { code, stdout } = await cli(
      'multi-get',
      'docs/doc1.md',
      'docs/nonexistent.md',
      '--json'
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.documents).toHaveLength(1);
    expect(parsed.skipped).toHaveLength(1);
    expect(parsed.skipped[0].reason).toBe('not_found');
  });

  test('truncates large documents with --max-bytes', async () => {
    const { code, stdout } = await cli(
      'multi-get',
      'docs/large.md',
      '--max-bytes',
      '500',
      '--json'
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.documents[0].truncated).toBe(true);
    expect(parsed.documents[0].content.length).toBeLessThan(500);
  });

  test('exit 0 even with partial failures', async () => {
    const { code, stdout } = await cli(
      'multi-get',
      'docs/nonexistent1.md',
      'docs/nonexistent2.md',
      '--json'
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.documents).toHaveLength(0);
    expect(parsed.skipped.length).toBeGreaterThan(0);
  });
});
