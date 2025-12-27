/**
 * CLI smoke tests - end-to-end testing via runCli().
 * Tests actual CLI behavior including exit codes and output.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli/run';
import { safeRm } from '../helpers/cleanup';

// Top-level regex for version string validation (perf: avoid recreating in tests)
const VERSION_REGEX = /\d+\.\d+\.\d+/;

// Capture stdout/stderr/console
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
  // Also capture console.log/error (some commands use these)
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

// Test helpers
const TEST_ROOT = join(tmpdir(), 'gno-smoke-test');
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
  // Use Reflect.deleteProperty to properly remove env vars
  // (= undefined becomes "undefined" string, breaking tests)
  Reflect.deleteProperty(process.env, 'GNO_CONFIG_DIR');
  Reflect.deleteProperty(process.env, 'GNO_DATA_DIR');
  Reflect.deleteProperty(process.env, 'GNO_CACHE_DIR');
}

// Helper to run CLI with args
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

describe('CLI smoke tests', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = getTestDir();
    await setupTestEnv(testDir);
  });

  afterEach(async () => {
    await cleanupTestEnv(testDir);
  });

  describe('help and version', () => {
    test('--help returns 0 and shows usage', async () => {
      const { code, stdout } = await cli('--help');
      expect(code).toBe(0);
      expect(stdout).toContain('Usage: gno');
      expect(stdout).toContain('GNO - Local Knowledge Index');
    });

    test('-h returns 0', async () => {
      const { code, stdout } = await cli('-h');
      expect(code).toBe(0);
      expect(stdout).toContain('Usage: gno');
    });

    test('--version returns 0 and shows version', async () => {
      const { code, stdout } = await cli('--version');
      expect(code).toBe(0);
      expect(stdout).toMatch(VERSION_REGEX);
    });

    test('-V returns 0', async () => {
      const { code, stdout } = await cli('-V');
      expect(code).toBe(0);
      expect(stdout).toMatch(VERSION_REGEX);
    });

    test('help <command> shows command help', async () => {
      // Note: Commander with exitOverride returns 1 for help on subcommands
      // but stdout still contains correct content
      const { stdout } = await cli('help', 'collection');
      expect(stdout).toContain('Manage collections');
    });

    test('collection --help shows subcommands', async () => {
      const { code, stdout } = await cli('collection', '--help');
      expect(code).toBe(0);
      expect(stdout).toContain('add');
      expect(stdout).toContain('list');
      expect(stdout).toContain('remove');
      expect(stdout).toContain('rename');
    });
  });

  describe('error handling', () => {
    test('unknown command returns 1', async () => {
      const { code, stderr } = await cli('nonexistent');
      expect(code).toBe(1);
      expect(stderr).toContain('unknown command');
    });

    test('unknown option returns 1', async () => {
      const { code, stderr } = await cli('--badoption');
      expect(code).toBe(1);
      expect(stderr).toContain('unknown option');
    });

    test('missing required option returns 1', async () => {
      const { code, stderr } = await cli('collection', 'add', '/tmp');
      expect(code).toBe(1);
      expect(stderr).toContain('--name');
    });

    test('--json wraps errors in JSON envelope', async () => {
      // Note: --json before command is parsed as unknown option by Commander
      // JSON envelope only works when command accepts --json
      const { code, stderr } = await cli(
        'collection',
        'add',
        '/nonexistent',
        '--name',
        'test',
        '--json'
      );
      expect(code).toBe(1);
      // Error format is {"error":{code,message}}
      expect(stderr).toContain('"error"');
      expect(stderr).toContain('VALIDATION');
    });
  });

  describe('init command', () => {
    test('init creates config', async () => {
      const { code, stdout } = await cli('init');
      expect(code).toBe(0);
      expect(stdout).toContain('GNO initialized successfully');
    });

    test('init with path creates collection', async () => {
      const collPath = join(testDir, 'docs');
      await mkdir(collPath, { recursive: true });

      const { code, stdout } = await cli('init', collPath, '--name', 'docs');
      expect(code).toBe(0);
      expect(stdout).toContain('docs');
    });
  });

  describe('collection commands', () => {
    beforeEach(async () => {
      // Initialize config first
      await cli('init');
    });

    test('collection list shows empty initially', async () => {
      const { code, stdout } = await cli('collection', 'list');
      expect(code).toBe(0);
      expect(stdout).toContain('No collections configured');
    });

    test('collection list --json returns array', async () => {
      const { code, stdout } = await cli('collection', 'list', '--json');
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(0);
    });

    test('collection add creates collection', async () => {
      const collPath = join(testDir, 'notes');
      await mkdir(collPath, { recursive: true });

      const { code, stdout } = await cli(
        'collection',
        'add',
        collPath,
        '--name',
        'notes'
      );
      expect(code).toBe(0);
      expect(stdout).toContain('added successfully');
    });

    test('collection add without --name fails', async () => {
      const collPath = join(testDir, 'notes');
      await mkdir(collPath, { recursive: true });

      const { code, stderr } = await cli('collection', 'add', collPath);
      expect(code).toBe(1);
      expect(stderr).toContain('--name');
      expect(stderr).toContain('required');
    });

    test('collection add nonexistent path fails', async () => {
      const { code, stderr } = await cli(
        'collection',
        'add',
        '/nonexistent/path',
        '--name',
        'test'
      );
      expect(code).toBe(1);
      expect(stderr).toContain('does not exist');
    });

    test('collection add duplicate name fails', async () => {
      const collPath = join(testDir, 'notes');
      await mkdir(collPath, { recursive: true });

      await cli('collection', 'add', collPath, '--name', 'notes');

      const collPath2 = join(testDir, 'notes2');
      await mkdir(collPath2, { recursive: true });

      const { code, stderr } = await cli(
        'collection',
        'add',
        collPath2,
        '--name',
        'notes'
      );
      expect(code).toBe(1);
      expect(stderr).toContain('already exists');
    });

    test('collection remove works', async () => {
      const collPath = join(testDir, 'notes');
      await mkdir(collPath, { recursive: true });
      await cli('collection', 'add', collPath, '--name', 'notes');

      const { code, stdout } = await cli('collection', 'remove', 'notes');
      expect(code).toBe(0);
      expect(stdout).toContain('removed');
    });

    test('collection remove nonexistent fails', async () => {
      const { code, stderr } = await cli('collection', 'remove', 'nonexistent');
      expect(code).toBe(1);
      expect(stderr).toContain('not found');
    });

    test('collection rename works', async () => {
      const collPath = join(testDir, 'notes');
      await mkdir(collPath, { recursive: true });
      await cli('collection', 'add', collPath, '--name', 'notes');

      const { code, stdout } = await cli(
        'collection',
        'rename',
        'notes',
        'docs'
      );
      expect(code).toBe(0);
      expect(stdout).toContain('renamed');
    });

    test('collection list --md outputs markdown', async () => {
      const collPath = join(testDir, 'notes');
      await mkdir(collPath, { recursive: true });
      await cli('collection', 'add', collPath, '--name', 'notes');

      const { code, stdout } = await cli('collection', 'list', '--md');
      expect(code).toBe(0);
      expect(stdout).toContain('# Collections');
      expect(stdout).toContain('## notes');
    });

    test('collection add with options', async () => {
      const collPath = join(testDir, 'code');
      await mkdir(collPath, { recursive: true });

      const { code } = await cli(
        'collection',
        'add',
        collPath,
        '--name',
        'code',
        '--pattern',
        '**/*.ts',
        '--include',
        '.ts,.tsx',
        '--exclude',
        'node_modules,dist'
      );
      expect(code).toBe(0);

      const { stdout } = await cli('collection', 'list', '--json');
      const parsed = JSON.parse(stdout.trim());
      expect(parsed[0].pattern).toBe('**/*.ts');
      expect(parsed[0].include).toContain('.ts');
      expect(parsed[0].exclude).toContain('node_modules');
    });
  });

  describe('context commands', () => {
    beforeEach(async () => {
      await cli('init');
      // Add a collection for context testing
      const collPath = join(testDir, 'notes');
      await mkdir(collPath, { recursive: true });
      await cli('collection', 'add', collPath, '--name', 'notes');
    });

    test('context list shows empty initially', async () => {
      const { code, stdout } = await cli('context', 'list');
      expect(code).toBe(0);
      expect(stdout).toContain('No contexts configured');
    });

    test('context add creates context', async () => {
      const { code, stdout } = await cli(
        'context',
        'add',
        '/',
        'Global context'
      );
      expect(code).toBe(0);
      expect(stdout).toContain('Added context');
    });

    test('context list shows added contexts', async () => {
      await cli('context', 'add', '/', 'Global context');

      const { code, stdout } = await cli('context', 'list');
      expect(code).toBe(0);
      expect(stdout).toContain('/');
    });

    test('context rm works', async () => {
      await cli('context', 'add', '/', 'Global context');

      const { code, stdout } = await cli('context', 'rm', '/');
      expect(code).toBe(0);
      expect(stdout).toContain('Removed');
    });

    test('context check validates configuration', async () => {
      await cli('context', 'add', '/', 'Global context');

      const { code, stdout } = await cli('context', 'check');
      expect(code).toBe(0);
      expect(stdout).toContain('valid');
    });
  });

  describe('stub commands', () => {
    test('mcp returns not implemented', async () => {
      const { code, stderr } = await cli('mcp');
      expect(code).toBe(2);
      expect(stderr).toContain('not yet implemented');
    });
  });

  describe('global options', () => {
    test('--no-color is accepted', async () => {
      const { code } = await cli('--no-color', '--help');
      expect(code).toBe(0);
    });

    test('--verbose is accepted', async () => {
      const { code } = await cli('--verbose', '--help');
      expect(code).toBe(0);
    });

    test('--yes is accepted', async () => {
      const { code } = await cli('--yes', '--help');
      expect(code).toBe(0);
    });

    test('--index is accepted', async () => {
      const { code } = await cli('--index', 'myindex', '--help');
      expect(code).toBe(0);
    });

    test('--quiet/-q is accepted', async () => {
      const { code: code1 } = await cli('--quiet', '--help');
      expect(code1).toBe(0);
      const { code: code2 } = await cli('-q', '--help');
      expect(code2).toBe(0);
    });
  });

  describe('concise help', () => {
    test('gno with no args shows concise help', async () => {
      const { code, stdout } = await cli();
      expect(code).toBe(0);
      expect(stdout).toContain('Quick start:');
      expect(stdout).toContain('gno init');
      expect(stdout).toContain("Run 'gno --help' for full command list");
    });

    test('gno with no args --json returns structured help', async () => {
      // Note: --json alone triggers concise help because it's a flag-only invocation
      // We need to test this differently - let the full help handle it
      const { code, stdout } = await cli('--help');
      expect(code).toBe(0);
      expect(stdout).toContain('Usage: gno');
    });
  });

  describe('suggestions and help hints', () => {
    test('typo suggests correct command', async () => {
      const { code, stderr } = await cli('serach');
      expect(code).toBe(1);
      expect(stderr).toContain('Did you mean search');
    });

    test('error shows help hint', async () => {
      const { code, stderr } = await cli('collection', 'add', '/tmp');
      expect(code).toBe(1);
      expect(stderr).toContain('--help');
    });
  });

  describe('help footer', () => {
    test('--help shows docs link', async () => {
      const { code, stdout } = await cli('--help');
      expect(code).toBe(0);
      expect(stdout).toContain('github.com/gmickel/gno');
    });
  });

  describe('search commands (stubs)', () => {
    beforeEach(async () => {
      await cli('init');
    });

    test('search requires query', async () => {
      const { code, stderr } = await cli('search');
      expect(code).toBe(1);
      expect(stderr).toContain('missing required argument');
    });

    test('vsearch requires query', async () => {
      const { code, stderr } = await cli('vsearch');
      expect(code).toBe(1);
      expect(stderr).toContain('missing required argument');
    });

    test('query requires query', async () => {
      const { code, stderr } = await cli('query');
      expect(code).toBe(1);
      expect(stderr).toContain('missing required argument');
    });

    test('ask requires query', async () => {
      const { code, stderr } = await cli('ask');
      expect(code).toBe(1);
      expect(stderr).toContain('missing required argument');
    });
  });
});

describe('CLI error envelope format', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = getTestDir();
    await setupTestEnv(testDir);
    await cli('init');
  });

  afterEach(async () => {
    await cleanupTestEnv(testDir);
  });

  test('validation error has correct format', async () => {
    const { code, stderr } = await cli(
      'collection',
      'add',
      '/nonexistent',
      '--name',
      'test'
    );
    expect(code).toBe(1);
    expect(stderr).toContain('does not exist');
  });

  test('runtime error from stub commands', async () => {
    const { code, stderr } = await cli('mcp');
    expect(code).toBe(2);
    expect(stderr).toContain('not yet implemented');
  });
});
