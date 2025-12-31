/**
 * Incremental sync tests.
 * Verifies that gno update/index only processes new or changed files.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type UpdateResult, update } from '../../src/cli/commands/update';
import { safeRm } from '../helpers/cleanup';

// ─────────────────────────────────────────────────────────────────────────────
// Setup / Teardown
// ─────────────────────────────────────────────────────────────────────────────

const TEST_ROOT = join(tmpdir(), 'gno-incremental-sync');
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

// Use direct function import instead of CLI to get sync stats
function runUpdate(configPath?: string): Promise<UpdateResult> {
  return update({ configPath });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper to init via CLI (needed for collection setup)
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

async function cli(
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { runCli } = await import('../../src/cli/run');
  captureOutput();
  try {
    const code = await runCli(['node', 'gno', ...args]);
    return { code, stdout: stdoutData, stderr: stderrData };
  } finally {
    restoreOutput();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Incremental Sync Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('incremental sync', () => {
  let testDir: string;
  let docsDir: string;

  beforeEach(async () => {
    testDir = getTestDir();
    docsDir = join(testDir, 'docs');
    await setupTestEnv(testDir);
    await mkdir(docsDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTestEnv(testDir);
  });

  test('first sync processes all files', async () => {
    // Create initial files
    await writeFile(join(docsDir, 'alpha.md'), '# Alpha\nFirst file');
    await writeFile(join(docsDir, 'beta.md'), '# Beta\nSecond file');

    // Initialize collection
    const initResult = await cli('init', docsDir, '--name', 'docs');
    expect(initResult.code).toBe(0);

    // First sync - should process all files
    const result = await runUpdate();
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.result.totalFilesAdded).toBe(2);
    expect(result.result.totalFilesSkipped).toBe(0);
  });

  test('second sync skips unchanged files', async () => {
    // Create initial files
    await writeFile(join(docsDir, 'alpha.md'), '# Alpha\nFirst file');
    await writeFile(join(docsDir, 'beta.md'), '# Beta\nSecond file');

    // Initialize and first sync
    await cli('init', docsDir, '--name', 'docs');
    const first = await runUpdate();
    expect(first.success).toBe(true);
    if (!first.success) {
      return;
    }
    expect(first.result.totalFilesAdded).toBe(2);

    // Second sync without changes - should skip all
    const second = await runUpdate();
    expect(second.success).toBe(true);
    if (!second.success) {
      return;
    }

    // filesUnchanged is per-collection, totalFilesSkipped is for walker-level skips (TOO_LARGE)
    const coll = second.result.collections[0];
    expect(coll?.filesUnchanged).toBe(2);
    expect(second.result.totalFilesAdded).toBe(0);
    expect(second.result.totalFilesUpdated).toBe(0);
  });

  test('adding new file only processes the new file', async () => {
    // Create initial file
    await writeFile(join(docsDir, 'alpha.md'), '# Alpha\nFirst file');

    // Initialize and first sync
    await cli('init', docsDir, '--name', 'docs');
    const first = await runUpdate();
    expect(first.success).toBe(true);
    if (!first.success) {
      return;
    }
    expect(first.result.totalFilesAdded).toBe(1);

    // Add new file
    await writeFile(join(docsDir, 'beta.md'), '# Beta\nNew file');

    // Second sync - should only process new file
    const second = await runUpdate();
    expect(second.success).toBe(true);
    if (!second.success) {
      return;
    }

    const coll = second.result.collections[0];
    expect(second.result.totalFilesAdded).toBe(1);
    expect(coll?.filesUnchanged).toBe(1);
    expect(second.result.totalFilesUpdated).toBe(0);
  });

  test('modifying file reprocesses only modified file', async () => {
    // Create initial files
    await writeFile(join(docsDir, 'alpha.md'), '# Alpha\nOriginal content');
    await writeFile(join(docsDir, 'beta.md'), '# Beta\nOriginal content');

    // Initialize and first sync
    await cli('init', docsDir, '--name', 'docs');
    const first = await runUpdate();
    expect(first.success).toBe(true);
    if (!first.success) {
      return;
    }
    expect(first.result.totalFilesAdded).toBe(2);

    // Modify one file
    await writeFile(join(docsDir, 'alpha.md'), '# Alpha\nModified content');

    // Second sync - should update only modified file
    const second = await runUpdate();
    expect(second.success).toBe(true);
    if (!second.success) {
      return;
    }

    const coll = second.result.collections[0];
    expect(second.result.totalFilesUpdated).toBe(1);
    expect(coll?.filesUnchanged).toBe(1);
    expect(second.result.totalFilesAdded).toBe(0);
  });

  test('combined: add new + modify existing + unchanged', async () => {
    // Create initial files
    await writeFile(join(docsDir, 'unchanged.md'), '# Unchanged');
    await writeFile(join(docsDir, 'will-modify.md'), '# Will Modify');

    // Initialize and first sync
    await cli('init', docsDir, '--name', 'docs');
    const first = await runUpdate();
    expect(first.success).toBe(true);
    if (!first.success) {
      return;
    }
    expect(first.result.totalFilesAdded).toBe(2);

    // Add new file and modify existing
    await writeFile(join(docsDir, 'new-file.md'), '# New File');
    await writeFile(join(docsDir, 'will-modify.md'), '# Modified');

    // Second sync
    const second = await runUpdate();
    expect(second.success).toBe(true);
    if (!second.success) {
      return;
    }

    const coll = second.result.collections[0];
    expect(second.result.totalFilesAdded).toBe(1); // new-file.md
    expect(second.result.totalFilesUpdated).toBe(1); // will-modify.md
    expect(coll?.filesUnchanged).toBe(1); // unchanged.md
  });
});
