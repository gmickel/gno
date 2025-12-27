/**
 * gno get command smoke tests.
 * Tests CLI behavior via runCli().
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv';
// biome-ignore lint/performance/noNamespaceImport: ajv-formats requires namespace for .default
import * as addFormatsModule from 'ajv-formats';
import getSchema from '../../spec/output-schemas/get.schema.json';
import { runCli } from '../../src/cli/run';
import { safeRm } from '../helpers/cleanup';

const addFormats = addFormatsModule.default;

// ─────────────────────────────────────────────────────────────────────────────
// Top-level regex patterns
// ─────────────────────────────────────────────────────────────────────────────

const DOCID_PATTERN = /^#[a-f0-9]{6,8}$/;
const URI_PATTERN = /^gno:\/\//;
const LINE_NUMBER_PATTERN = /^\d+:/m;

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

const TEST_ROOT = join(tmpdir(), 'gno-get-smoke');
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
    '# Test Document\n\nThis is line 2.\nLine 3 here.\nLine 4 here.\nLine 5 here.'
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
const validateGet = ajv.compile(getSchema);

// ─────────────────────────────────────────────────────────────────────────────
// gno get Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('gno get smoke tests', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await setupTestWithContent();
  });

  afterEach(async () => {
    await cleanupTestEnv(testDir);
  });

  test('retrieves by collection/path', async () => {
    const { code, stdout } = await cli('get', 'docs/test.md');
    expect(code).toBe(0);
    expect(stdout).toContain('Test Document');
  });

  test('retrieves by URI', async () => {
    const { code, stdout } = await cli('get', 'gno://docs/test.md');
    expect(code).toBe(0);
    expect(stdout).toContain('Test Document');
  });

  test('--json validates against schema', async () => {
    const { code, stdout } = await cli('get', 'docs/test.md', '--json');
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    const valid = validateGet(parsed);
    if (!valid) {
      console.error('Schema validation errors:', validateGet.errors);
    }
    expect(valid).toBe(true);
    expect(parsed.docid).toMatch(DOCID_PATTERN);
    expect(parsed.uri).toMatch(URI_PATTERN);
  });

  test('--from and -l apply line range', async () => {
    const { code, stdout } = await cli(
      'get',
      'docs/test.md',
      '--from',
      '2',
      '-l',
      '2',
      '--json'
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.returnedLines).toEqual({ start: 2, end: 3 });
    // Content should only have lines 2-3
    expect(parsed.content).not.toContain('# Test Document');
    expect(parsed.content).toContain('line 2');
  });

  test('--line-numbers shows line prefixes', async () => {
    const { code, stdout } = await cli('get', 'docs/test.md', '--line-numbers');
    expect(code).toBe(0);
    expect(stdout).toMatch(LINE_NUMBER_PATTERN);
  });

  test('--md produces markdown output', async () => {
    const { code, stdout } = await cli('get', 'docs/test.md', '--md');
    expect(code).toBe(0);
    expect(stdout).toContain('# ');
    expect(stdout).toContain('**URI**');
    expect(stdout).toContain('```');
  });

  test('exits 1 for invalid ref format', async () => {
    const { code, stderr } = await cli('get', 'invalid');
    expect(code).toBe(1);
    expect(stderr).toContain('Invalid ref');
  });

  test('exits 2 for not found', async () => {
    const { code, stderr } = await cli('get', 'docs/nonexistent.md');
    expect(code).toBe(2);
    expect(stderr).toContain('not found');
  });

  test(':line suffix applies starting line', async () => {
    const { code, stdout } = await cli('get', 'docs/test.md:3', '--json');
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.returnedLines.start).toBe(3);
  });

  test('--from overrides :line suffix', async () => {
    const { code, stdout } = await cli(
      'get',
      'docs/test.md:5',
      '--from',
      '2',
      '--json'
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.returnedLines.start).toBe(2);
  });
});

describe('gno get by docid', () => {
  let testDir: string;
  let docid: string;

  beforeEach(async () => {
    testDir = await setupTestWithContent();
    // Get docid from ls
    const { stdout } = await cli('ls', '--json');
    const parsed = JSON.parse(stdout);
    docid = parsed.documents[0].docid;
  });

  afterEach(async () => {
    await cleanupTestEnv(testDir);
  });

  test('retrieves by docid', async () => {
    const { code, stdout } = await cli('get', docid);
    expect(code).toBe(0);
    expect(stdout).toContain('Test Document');
  });

  test('docid with :line suffix fails', async () => {
    const { code, stderr } = await cli('get', `${docid}:5`);
    expect(code).toBe(1);
    expect(stderr).toContain(':line suffix');
  });
});
