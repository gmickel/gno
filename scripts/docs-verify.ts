#!/usr/bin/env bun
/**
 * Documentation verification harness.
 * Validates that quickstart commands work as documented.
 *
 * Requirements:
 * - BM25-only (no vsearch/hybrid unless sqlite-vec confirmed)
 * - No --answer (avoids model dependency)
 * - Isolated: uses temp dirs (no user state mutation)
 * - Fixture config has NO updateCmd (security + determinism)
 *
 * Run: bun run docs:verify
 */

import { cp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli/run';
import { safeRm } from '../test/helpers/cleanup';

// ANSI colors
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

// Top-level regex for version validation (perf: avoid recreating in tests)
const VERSION_REGEX = /\d+\.\d+\.\d+/;

// Test state
let testDir: string;
let fixturesDir: string;
let passCount = 0;
let failCount = 0;
let skipCount = 0;

// Capabilities from doctor
interface Capabilities {
  bm25: boolean;
  sqliteVec: boolean;
  embedModel: boolean;
  rerankModel: boolean;
  genModel: boolean;
}

// Output capture
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

function log(msg: string) {
  originalConsoleLog(msg);
}

function pass(name: string) {
  passCount++;
  log(`${GREEN}✓${RESET} ${name}`);
}

function fail(name: string, reason: string) {
  failCount++;
  log(`${RED}✗${RESET} ${name}`);
  log(`  ${RED}${reason}${RESET}`);
}

function skip(name: string, reason: string) {
  skipCount++;
  log(`${YELLOW}○${RESET} ${name} (skipped: ${reason})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Capability Detection
// ─────────────────────────────────────────────────────────────────────────────

async function detectCapabilities(): Promise<Capabilities> {
  const { stdout } = await cli('doctor', '--json');
  const caps: Capabilities = {
    bm25: true, // Always available
    sqliteVec: false,
    embedModel: false,
    rerankModel: false,
    genModel: false,
  };

  try {
    const result = JSON.parse(stdout);
    for (const check of result.checks || []) {
      if (check.name === 'sqlite-vec' && check.status === 'ok') {
        caps.sqliteVec = true;
      }
      if (check.name === 'embed-model' && check.status === 'ok') {
        caps.embedModel = true;
      }
      if (check.name === 'rerank-model' && check.status === 'ok') {
        caps.rerankModel = true;
      }
      if (check.name === 'gen-model' && check.status === 'ok') {
        caps.genModel = true;
      }
    }
  } catch {
    // If doctor fails, assume minimal caps
  }

  return caps;
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup & Teardown
// ─────────────────────────────────────────────────────────────────────────────

async function setup() {
  testDir = join(tmpdir(), `gno-docs-verify-${Date.now()}`);
  fixturesDir = join(testDir, 'corpus');

  await mkdir(testDir, { recursive: true });

  // Copy corpus from test/fixtures/docs-corpus or create minimal
  const corpusSrc = join(import.meta.dir, '../test/fixtures/docs-corpus');
  const corpusExists = await Bun.file(join(corpusSrc, 'README.md')).exists();

  if (corpusExists) {
    await cp(corpusSrc, fixturesDir, { recursive: true });
  } else {
    // Fallback to test/fixtures/docs
    const fallbackSrc = join(import.meta.dir, '../test/fixtures/docs');
    await cp(fallbackSrc, fixturesDir, { recursive: true });
  }

  // Set isolated environment
  process.env.GNO_CONFIG_DIR = join(testDir, 'config');
  process.env.GNO_DATA_DIR = join(testDir, 'data');
  process.env.GNO_CACHE_DIR = join(testDir, 'cache');
}

async function teardown() {
  await safeRm(testDir);
  Reflect.deleteProperty(process.env, 'GNO_CONFIG_DIR');
  Reflect.deleteProperty(process.env, 'GNO_DATA_DIR');
  Reflect.deleteProperty(process.env, 'GNO_CACHE_DIR');
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Suites
// ─────────────────────────────────────────────────────────────────────────────

async function testHelp() {
  log(`\n${BOLD}Help & Version${RESET}`);

  // gno --help
  {
    const { code, stdout } = await cli('--help');
    if (code === 0 && stdout.includes('Usage: gno')) {
      pass('gno --help');
    } else {
      fail('gno --help', `exit ${code}`);
    }
  }

  // gno --version
  {
    const { code, stdout } = await cli('--version');
    if (code === 0 && VERSION_REGEX.test(stdout)) {
      pass('gno --version');
    } else {
      fail('gno --version', `exit ${code}`);
    }
  }
}

async function testInit() {
  log(`\n${BOLD}Init & Collection${RESET}`);

  // gno init <path> --name <name>
  {
    const { code } = await cli('init', fixturesDir, '--name', 'docs-corpus');
    if (code === 0) {
      pass('gno init <path> --name <name>');
    } else {
      fail('gno init', `exit ${code}`);
    }
  }

  // gno collection list
  {
    const { code, stdout } = await cli('collection', 'list', '--json');
    if (code === 0) {
      try {
        const list = JSON.parse(stdout);
        if (Array.isArray(list) && list.length > 0) {
          pass('gno collection list --json');
        } else {
          fail('gno collection list', 'empty list');
        }
      } catch {
        fail('gno collection list', 'invalid JSON');
      }
    } else {
      fail('gno collection list', `exit ${code}`);
    }
  }
}

async function testIndex() {
  log(`\n${BOLD}Indexing${RESET}`);

  // gno update (index all)
  {
    const { code } = await cli('update', '--yes');
    if (code === 0) {
      pass('gno update --yes');
    } else {
      fail('gno update', `exit ${code}`);
    }
  }

  // gno ls
  {
    const { code, stdout } = await cli('ls', '--json');
    if (code === 0) {
      try {
        const result = JSON.parse(stdout);
        if (result.documents?.length > 0) {
          pass(`gno ls (${result.documents.length} docs)`);
        } else {
          fail('gno ls', 'no documents indexed');
        }
      } catch {
        fail('gno ls', 'invalid JSON');
      }
    } else {
      fail('gno ls', `exit ${code}`);
    }
  }
}

async function testBm25Search() {
  log(`\n${BOLD}BM25 Search${RESET}`);

  // Basic search
  {
    const { code, stdout } = await cli('search', 'authentication', '--json');
    if (code === 0) {
      try {
        const result = JSON.parse(stdout);
        if (result.results?.length > 0) {
          pass('gno search <query> --json');
        } else {
          fail('gno search', 'no results');
        }
      } catch {
        fail('gno search', 'invalid JSON');
      }
    } else {
      fail('gno search', `exit ${code}`);
    }
  }

  // Search with -n limit
  {
    const { code, stdout } = await cli('search', 'test', '-n', '3', '--json');
    if (code === 0) {
      try {
        const result = JSON.parse(stdout);
        if (result.results?.length <= 3) {
          pass('gno search -n <limit>');
        } else {
          fail('gno search -n', `returned ${result.results?.length} > 3`);
        }
      } catch {
        fail('gno search -n', 'invalid JSON');
      }
    } else {
      fail('gno search -n', `exit ${code}`);
    }
  }

  // Search --files output
  {
    const { code, stdout } = await cli('search', 'error', '--files');
    if (code === 0 && stdout.includes('gno://')) {
      pass('gno search --files');
    } else {
      fail('gno search --files', `exit ${code}`);
    }
  }
}

async function testVectorSearch(caps: Capabilities) {
  log(`\n${BOLD}Vector Search${RESET}`);

  if (!caps.sqliteVec) {
    skip('gno vsearch', 'sqlite-vec not available');
    skip('gno query (hybrid)', 'sqlite-vec not available');
    return;
  }

  if (!caps.embedModel) {
    skip('gno vsearch', 'embed model not cached');
    skip('gno query (hybrid)', 'embed model not cached');
    return;
  }

  // vsearch
  {
    const { code } = await cli('vsearch', 'authentication', '--json');
    if (code === 0) {
      pass('gno vsearch');
    } else {
      fail('gno vsearch', `exit ${code}`);
    }
  }

  // query (hybrid)
  {
    const { code } = await cli('query', 'authentication', '--json');
    if (code === 0) {
      pass('gno query (hybrid)');
    } else {
      fail('gno query', `exit ${code}`);
    }
  }
}

async function testGet() {
  log(`\n${BOLD}Document Retrieval${RESET}`);

  // First get a docid from search
  const { stdout: searchOut } = await cli(
    'search',
    'test',
    '-n',
    '1',
    '--json'
  );
  let docid: string | undefined;
  try {
    const result = JSON.parse(searchOut);
    docid = result.results?.[0]?.docid;
  } catch {
    // ignore
  }

  if (!docid) {
    skip('gno get <docid>', 'no docid from search');
    return;
  }

  // gno get <docid>
  {
    const { code, stdout } = await cli('get', docid);
    if (code === 0 && stdout.length > 0) {
      pass('gno get <docid>');
    } else {
      fail('gno get', `exit ${code}`);
    }
  }
}

async function testDoctor() {
  log(`\n${BOLD}Diagnostics${RESET}`);

  const { code, stdout } = await cli('doctor', '--json');
  if (code === 0) {
    try {
      const result = JSON.parse(stdout);
      if (typeof result.healthy === 'boolean') {
        pass('gno doctor --json');
      } else {
        fail('gno doctor', 'missing healthy field');
      }
    } catch {
      fail('gno doctor', 'invalid JSON');
    }
  } else {
    fail('gno doctor', `exit ${code}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  log(`${BOLD}GNO Documentation Verification${RESET}`);
  log('Verifying that documented commands work as expected.\n');

  try {
    // Setup isolated environment
    await setup();

    // Detect capabilities
    const caps = await detectCapabilities();
    log(`${BOLD}Capabilities:${RESET}`);
    log(`  BM25: ${caps.bm25 ? `${GREEN}yes${RESET}` : `${RED}no${RESET}`}`);
    log(
      `  sqlite-vec: ${caps.sqliteVec ? `${GREEN}yes${RESET}` : `${YELLOW}no${RESET}`}`
    );
    log(
      `  Embed model: ${caps.embedModel ? `${GREEN}yes${RESET}` : `${YELLOW}no${RESET}`}`
    );
    log(
      `  Rerank model: ${caps.rerankModel ? `${GREEN}yes${RESET}` : `${YELLOW}no${RESET}`}`
    );
    log(
      `  Gen model: ${caps.genModel ? `${GREEN}yes${RESET}` : `${YELLOW}no${RESET}`}`
    );

    // Run test suites
    await testHelp();
    await testInit();
    await testIndex();
    await testBm25Search();
    await testVectorSearch(caps);
    await testGet();
    await testDoctor();

    // Summary
    log(`\n${BOLD}Summary${RESET}`);
    log(
      `  ${GREEN}${passCount} passed${RESET}, ${failCount > 0 ? RED : ''}${failCount} failed${RESET}, ${YELLOW}${skipCount} skipped${RESET}`
    );

    if (failCount > 0) {
      log(`\n${RED}Documentation verification failed!${RESET}`);
      process.exit(1);
    }

    log(`\n${GREEN}Documentation verification passed!${RESET}`);
  } finally {
    await teardown();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
