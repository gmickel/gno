/**
 * Tests for gno init command.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init } from '../../src/cli/commands/init';
import { loadConfigFromPath } from '../../src/config/loader';
import { safeRm } from '../helpers/cleanup';

// Use temp directory for isolated tests
const TEST_ROOT = join(tmpdir(), 'gno-test-init');
let testCounter = 0;

function getTestDir(): string {
  const dir = join(TEST_ROOT, `test-${Date.now()}-${testCounter}`);
  testCounter += 1;
  return dir;
}

async function setupTestEnv(testDir: string) {
  await mkdir(testDir, { recursive: true });

  // Override env vars for this test
  process.env.GNO_CONFIG_DIR = join(testDir, 'config');
  process.env.GNO_DATA_DIR = join(testDir, 'data');
  process.env.GNO_CACHE_DIR = join(testDir, 'cache');
}

async function cleanupTestEnv(testDir: string) {
  // Clean up test directory
  await safeRm(testDir);

  // Restore env vars
  process.env.GNO_CONFIG_DIR = undefined;
  process.env.GNO_DATA_DIR = undefined;
  process.env.GNO_CACHE_DIR = undefined;
}

describe('init command', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = getTestDir();
    await setupTestEnv(testDir);
  });

  afterEach(async () => {
    await cleanupTestEnv(testDir);
  });

  describe('basic initialization', () => {
    test('creates directories and config', async () => {
      const result = await init();

      expect(result.success).toBe(true);
      expect(result.alreadyInitialized).toBeUndefined();
      expect(result.configPath).toContain('index.yml');
      expect(result.dataDir).toBeDefined();
      expect(result.dbPath).toContain('.sqlite');

      // Verify config file was created
      const configFile = Bun.file(result.configPath);
      expect(await configFile.exists()).toBe(true);

      // Verify config content
      const loadResult = await loadConfigFromPath(result.configPath);
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) {
        return;
      }

      expect(loadResult.value.version).toBe('1.0');
      expect(loadResult.value.collections).toEqual([]);
      expect(loadResult.value.contexts).toEqual([]);

      // Verify DB file was created
      const dbFile = Bun.file(result.dbPath);
      expect(await dbFile.exists()).toBe(true);
    });

    test('is idempotent - running twice succeeds', async () => {
      const result1 = await init();
      expect(result1.success).toBe(true);
      expect(result1.alreadyInitialized).toBeUndefined();

      const result2 = await init();
      expect(result2.success).toBe(true);
      expect(result2.alreadyInitialized).toBe(true);
      expect(result2.configPath).toBe(result1.configPath);
      expect(result2.dbPath).toBe(result1.dbPath);
    });
  });

  describe('initialization with collection', () => {
    test('creates config and adds collection', async () => {
      // Create test directory to use as collection path
      const collectionPath = join(testDir, 'test-collection');
      await mkdir(collectionPath, { recursive: true });

      const result = await init({
        path: collectionPath,
        name: 'test',
      });

      expect(result.success).toBe(true);
      expect(result.collectionAdded).toBe('test');

      // Verify config has the collection
      const loadResult = await loadConfigFromPath(result.configPath);
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) {
        return;
      }

      expect(loadResult.value.collections).toHaveLength(1);
      const collection = loadResult.value.collections[0];
      expect(collection?.name).toBe('test');
      expect(collection?.path).toBe(collectionPath);
      expect(collection?.pattern).toBe('**/*');
    });

    test('uses directory basename as name if not provided', async () => {
      const collectionPath = join(testDir, 'MyNotes');
      await mkdir(collectionPath, { recursive: true });

      const result = await init({
        path: collectionPath,
      });

      expect(result.success).toBe(true);
      expect(result.collectionAdded).toBe('mynotes');

      const loadResult = await loadConfigFromPath(result.configPath);
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) {
        return;
      }

      const collection = loadResult.value.collections[0];
      expect(collection?.name).toBe('mynotes');
    });

    test('adds collection with custom options', async () => {
      const collectionPath = join(testDir, 'docs');
      await mkdir(collectionPath, { recursive: true });

      const result = await init({
        path: collectionPath,
        name: 'work-docs',
        pattern: '**/*.md',
        include: '.md,.txt',
        exclude: '.git,temp',
        update: 'git pull',
      });

      expect(result.success).toBe(true);
      expect(result.collectionAdded).toBe('work-docs');

      const loadResult = await loadConfigFromPath(result.configPath);
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) {
        return;
      }

      const collection = loadResult.value.collections[0];
      expect(collection?.name).toBe('work-docs');
      expect(collection?.pattern).toBe('**/*.md');
      expect(collection?.include).toEqual(['.md', '.txt']);
      expect(collection?.exclude).toEqual(['.git', 'temp']);
      expect(collection?.updateCmd).toBe('git pull');
    });

    test('adds collection to existing initialized config', async () => {
      // First init without collection
      const result1 = await init();
      expect(result1.success).toBe(true);

      // Create collection directory
      const collectionPath = join(testDir, 'notes');
      await mkdir(collectionPath, { recursive: true });

      // Init again with collection
      const result2 = await init({
        path: collectionPath,
        name: 'notes',
      });

      expect(result2.success).toBe(true);
      expect(result2.alreadyInitialized).toBe(true);
      expect(result2.collectionAdded).toBe('notes');

      const loadResult = await loadConfigFromPath(result2.configPath);
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) {
        return;
      }

      expect(loadResult.value.collections).toHaveLength(1);
      expect(loadResult.value.collections[0]?.name).toBe('notes');
    });
  });

  describe('error cases', () => {
    test('fails when path does not exist', async () => {
      const result = await init({
        path: join(testDir, 'nonexistent'),
        name: 'test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');
    });

    test('fails when duplicate collection name', async () => {
      const collectionPath = join(testDir, 'docs');
      await mkdir(collectionPath, { recursive: true });

      // First init with collection
      const result1 = await init({
        path: collectionPath,
        name: 'docs',
      });
      expect(result1.success).toBe(true);

      // Try to add same name again
      const anotherPath = join(testDir, 'other');
      await mkdir(anotherPath, { recursive: true });

      const result2 = await init({
        path: anotherPath,
        name: 'docs',
      });

      expect(result2.success).toBe(false);
      expect(result2.error).toContain('already exists');
    });
  });

  describe('multilingual config (T2.5)', () => {
    test('sets ftsTokenizer when provided', async () => {
      const result = await init({
        tokenizer: 'porter',
      });

      expect(result.success).toBe(true);

      const loadResult = await loadConfigFromPath(result.configPath);
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) {
        return;
      }

      expect(loadResult.value.ftsTokenizer).toBe('porter');
    });

    test('defaults to snowball english tokenizer', async () => {
      const result = await init();

      expect(result.success).toBe(true);

      const loadResult = await loadConfigFromPath(result.configPath);
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) {
        return;
      }

      // Default changed from unicode61 to snowball english for multilingual stemming
      expect(loadResult.value.ftsTokenizer).toBe('snowball english');
    });

    test('rejects invalid tokenizer', async () => {
      const result = await init({
        tokenizer: 'invalid' as 'porter',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid tokenizer');
    });

    test('sets languageHint on collection', async () => {
      const collectionPath = join(testDir, 'german-docs');
      await mkdir(collectionPath, { recursive: true });

      const result = await init({
        path: collectionPath,
        name: 'german',
        language: 'de',
      });

      expect(result.success).toBe(true);
      expect(result.collectionAdded).toBe('german');

      const loadResult = await loadConfigFromPath(result.configPath);
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) {
        return;
      }

      const collection = loadResult.value.collections[0];
      expect(collection?.languageHint).toBe('de');
    });

    test('accepts valid BCP-47 language codes', async () => {
      const collectionPath = join(testDir, 'chinese-docs');
      await mkdir(collectionPath, { recursive: true });

      const result = await init({
        path: collectionPath,
        name: 'chinese',
        language: 'zh-CN',
      });

      expect(result.success).toBe(true);

      const loadResult = await loadConfigFromPath(result.configPath);
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) {
        return;
      }

      expect(loadResult.value.collections[0]?.languageHint).toBe('zh-CN');
    });

    test('rejects invalid language hint', async () => {
      const collectionPath = join(testDir, 'docs');
      await mkdir(collectionPath, { recursive: true });

      const result = await init({
        path: collectionPath,
        name: 'docs',
        language: 'invalid-language-code',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid language hint');
    });
  });
});
