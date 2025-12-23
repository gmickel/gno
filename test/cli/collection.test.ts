import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  collectionAdd,
  collectionList,
  collectionRemove,
  collectionRename,
} from '../../src/cli/commands/collection';
import {
  createDefaultConfig,
  loadConfigFromPath,
  saveConfigToPath,
} from '../../src/config';

// Temp directory for tests
const TEST_DIR = join(import.meta.dir, '.temp-collection-tests');
const TEST_CONFIG_PATH = join(TEST_DIR, 'config', 'index.yml');
const TEST_COLLECTION_PATH = join(TEST_DIR, 'collections', 'test-coll');

// Mock process.exit to prevent actual exits
const originalExit = process.exit;
let exitCode: number | null = null;
const mockExit = (code: number) => {
  exitCode = code;
  throw new Error(`EXIT:${code}`);
};

// Capture console output
let consoleOutput: string[] = [];
let consoleErrors: string[] = [];
const originalLog = console.log;
const originalError = console.error;
const mockLog = (...args: unknown[]) => {
  consoleOutput.push(args.join(' '));
};
const mockError = (...args: unknown[]) => {
  consoleErrors.push(args.join(' '));
};

describe('collection CLI commands', () => {
  beforeEach(async () => {
    // Set up mocks
    process.exit = mockExit as never;
    console.log = mockLog as never;
    console.error = mockError as never;
    exitCode = null;
    consoleOutput = [];
    consoleErrors = [];

    // Set up temp directories
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(join(TEST_DIR, 'config'), { recursive: true });
    await mkdir(TEST_COLLECTION_PATH, { recursive: true });

    // Create minimal config
    const config = createDefaultConfig();
    await saveConfigToPath(config, TEST_CONFIG_PATH);

    // Override config path env var
    process.env.GNO_CONFIG_DIR = join(TEST_DIR, 'config');
  });

  afterEach(async () => {
    // Restore mocks
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    process.env.GNO_CONFIG_DIR = undefined;

    // Clean up temp dir
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe('collectionAdd', () => {
    test('adds collection with required name', async () => {
      try {
        await collectionAdd(TEST_COLLECTION_PATH, {
          name: 'test-coll',
        });
      } catch {
        // Ignore exit error
      }

      expect(exitCode).toBe(0);
      expect(consoleOutput.join('\n')).toContain('added successfully');

      // Verify config was updated
      const result = await loadConfigFromPath(TEST_CONFIG_PATH);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(result.value.collections).toHaveLength(1);
      expect(result.value.collections[0]?.name).toBe('test-coll');
      expect(result.value.collections[0]?.path).toBe(TEST_COLLECTION_PATH);
    });

    test('converts name to lowercase', async () => {
      try {
        await collectionAdd(TEST_COLLECTION_PATH, {
          name: 'Test-COLL',
        });
      } catch {
        // Ignore exit error
      }

      const result = await loadConfigFromPath(TEST_CONFIG_PATH);
      if (!result.ok) {
        return;
      }

      expect(result.value.collections[0]?.name).toBe('test-coll');
    });

    test('errors if name missing', async () => {
      try {
        await collectionAdd(TEST_COLLECTION_PATH, {});
      } catch {
        // Ignore exit error
      }

      expect(exitCode).toBe(1);
      expect(consoleErrors.join('\n')).toContain('--name is required');
    });

    test('errors if path does not exist', async () => {
      try {
        await collectionAdd('/nonexistent/path', {
          name: 'test',
        });
      } catch {
        // Ignore exit error
      }

      expect(exitCode).toBe(1);
      expect(consoleErrors.join('\n')).toContain('does not exist');
    });

    test('errors on duplicate name', async () => {
      // Add first collection
      try {
        await collectionAdd(TEST_COLLECTION_PATH, {
          name: 'test-coll',
        });
      } catch {
        // Ignore exit error
      }

      // Reset for second attempt
      exitCode = null;
      consoleErrors = [];

      // Try to add duplicate
      try {
        await collectionAdd(TEST_COLLECTION_PATH, {
          name: 'test-coll',
        });
      } catch {
        // Ignore exit error
      }

      expect(exitCode).toBe(1);
      expect(consoleErrors.join('\n')).toContain('already exists');
    });

    test('accepts custom pattern', async () => {
      try {
        await collectionAdd(TEST_COLLECTION_PATH, {
          name: 'test',
          pattern: '**/*.md',
        });
      } catch {
        // Ignore exit error
      }

      const result = await loadConfigFromPath(TEST_CONFIG_PATH);
      if (!result.ok) {
        return;
      }

      expect(result.value.collections[0]?.pattern).toBe('**/*.md');
    });

    test('parses include extensions', async () => {
      try {
        await collectionAdd(TEST_COLLECTION_PATH, {
          name: 'test',
          include: '.md,.txt,.pdf',
        });
      } catch {
        // Ignore exit error
      }

      const result = await loadConfigFromPath(TEST_CONFIG_PATH);
      if (!result.ok) {
        return;
      }

      expect(result.value.collections[0]?.include).toEqual([
        '.md',
        '.txt',
        '.pdf',
      ]);
    });

    test('parses exclude patterns', async () => {
      try {
        await collectionAdd(TEST_COLLECTION_PATH, {
          name: 'test',
          exclude: '.git,node_modules,dist',
        });
      } catch {
        // Ignore exit error
      }

      const result = await loadConfigFromPath(TEST_CONFIG_PATH);
      if (!result.ok) {
        return;
      }

      expect(result.value.collections[0]?.exclude).toEqual([
        '.git',
        'node_modules',
        'dist',
      ]);
    });

    test('sets update command', async () => {
      try {
        await collectionAdd(TEST_COLLECTION_PATH, {
          name: 'test',
          update: 'git pull',
        });
      } catch {
        // Ignore exit error
      }

      const result = await loadConfigFromPath(TEST_CONFIG_PATH);
      if (!result.ok) {
        return;
      }

      expect(result.value.collections[0]?.updateCmd).toBe('git pull');
    });
  });

  describe('collectionList', () => {
    beforeEach(async () => {
      // Add some test collections
      const config = await loadConfigFromPath(TEST_CONFIG_PATH);
      if (!config.ok) {
        return;
      }

      config.value.collections = [
        {
          name: 'notes',
          path: '/test/notes',
          pattern: '**/*.md',
          include: [],
          exclude: ['.git'],
        },
        {
          name: 'work',
          path: '/test/work',
          pattern: '**/*',
          include: ['.pdf', '.docx'],
          exclude: ['.git', 'node_modules'],
          updateCmd: 'git pull',
        },
      ];
      await saveConfigToPath(config.value, TEST_CONFIG_PATH);
    });

    test('lists collections in terminal format', async () => {
      try {
        await collectionList({});
      } catch {
        // Ignore exit error
      }

      expect(exitCode).toBe(0);
      const output = consoleOutput.join('\n');
      expect(output).toContain('notes');
      expect(output).toContain('work');
      expect(output).toContain('/test/notes');
      expect(output).toContain('/test/work');
    });

    test('lists collections in JSON format', async () => {
      try {
        await collectionList({ json: true });
      } catch {
        // Ignore exit error
      }

      expect(exitCode).toBe(0);
      const output = consoleOutput.join('\n');
      const parsed = JSON.parse(output);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]?.name).toBe('notes');
      expect(parsed[1]?.name).toBe('work');
    });

    test('lists collections in Markdown format', async () => {
      try {
        await collectionList({ md: true });
      } catch {
        // Ignore exit error
      }

      expect(exitCode).toBe(0);
      const output = consoleOutput.join('\n');
      expect(output).toContain('# Collections');
      expect(output).toContain('## notes');
      expect(output).toContain('## work');
      expect(output).toContain('**Path:**');
      expect(output).toContain('**Pattern:**');
    });

    test('handles empty collections list', async () => {
      const config = await loadConfigFromPath(TEST_CONFIG_PATH);
      if (!config.ok) {
        return;
      }

      config.value.collections = [];
      await saveConfigToPath(config.value, TEST_CONFIG_PATH);

      try {
        await collectionList({});
      } catch {
        // Ignore exit error
      }

      expect(exitCode).toBe(0);
      expect(consoleOutput.join('\n')).toContain('No collections');
    });
  });

  describe('collectionRemove', () => {
    beforeEach(async () => {
      // Add test collection
      const config = await loadConfigFromPath(TEST_CONFIG_PATH);
      if (!config.ok) {
        return;
      }

      config.value.collections = [
        {
          name: 'notes',
          path: '/test/notes',
          pattern: '**/*.md',
          include: [],
          exclude: ['.git'],
        },
      ];
      await saveConfigToPath(config.value, TEST_CONFIG_PATH);
    });

    test('removes existing collection', async () => {
      try {
        await collectionRemove('notes');
      } catch {
        // Ignore exit error
      }

      expect(exitCode).toBe(0);
      expect(consoleOutput.join('\n')).toContain('removed successfully');

      const result = await loadConfigFromPath(TEST_CONFIG_PATH);
      if (!result.ok) {
        return;
      }

      expect(result.value.collections).toHaveLength(0);
    });

    test('errors if collection not found', async () => {
      try {
        await collectionRemove('nonexistent');
      } catch {
        // Ignore exit error
      }

      expect(exitCode).toBe(1);
      expect(consoleErrors.join('\n')).toContain('not found');
    });

    test('errors if collection referenced by context', async () => {
      const config = await loadConfigFromPath(TEST_CONFIG_PATH);
      if (!config.ok) {
        return;
      }

      // Add context referencing the collection
      config.value.contexts = [
        {
          scopeType: 'collection',
          scopeKey: 'notes:',
          text: 'Test context',
        },
      ];
      await saveConfigToPath(config.value, TEST_CONFIG_PATH);

      try {
        await collectionRemove('notes');
      } catch {
        // Ignore exit error
      }

      expect(exitCode).toBe(1);
      expect(consoleErrors.join('\n')).toContain('referenced by contexts');
    });

    test('converts name to lowercase', async () => {
      try {
        await collectionRemove('NOTES');
      } catch {
        // Ignore exit error
      }

      expect(exitCode).toBe(0);
    });
  });

  describe('collectionRename', () => {
    beforeEach(async () => {
      // Add test collection
      const config = await loadConfigFromPath(TEST_CONFIG_PATH);
      if (!config.ok) {
        return;
      }

      config.value.collections = [
        {
          name: 'notes',
          path: '/test/notes',
          pattern: '**/*.md',
          include: [],
          exclude: ['.git'],
        },
      ];
      await saveConfigToPath(config.value, TEST_CONFIG_PATH);
    });

    test('renames existing collection', async () => {
      try {
        await collectionRename('notes', 'documents');
      } catch {
        // Ignore exit error
      }

      expect(exitCode).toBe(0);
      expect(consoleOutput.join('\n')).toContain('renamed to');

      const result = await loadConfigFromPath(TEST_CONFIG_PATH);
      if (!result.ok) {
        return;
      }

      expect(result.value.collections).toHaveLength(1);
      expect(result.value.collections[0]?.name).toBe('documents');
    });

    test('errors if old name not found', async () => {
      try {
        await collectionRename('nonexistent', 'newname');
      } catch {
        // Ignore exit error
      }

      expect(exitCode).toBe(1);
      expect(consoleErrors.join('\n')).toContain('not found');
    });

    test('errors if new name already exists', async () => {
      const config = await loadConfigFromPath(TEST_CONFIG_PATH);
      if (!config.ok) {
        return;
      }

      config.value.collections.push({
        name: 'work',
        path: '/test/work',
        pattern: '**/*',
        include: [],
        exclude: ['.git'],
      });
      await saveConfigToPath(config.value, TEST_CONFIG_PATH);

      try {
        await collectionRename('notes', 'work');
      } catch {
        // Ignore exit error
      }

      expect(exitCode).toBe(1);
      expect(consoleErrors.join('\n')).toContain('already exists');
    });

    test('updates collection scope contexts', async () => {
      const config = await loadConfigFromPath(TEST_CONFIG_PATH);
      if (!config.ok) {
        return;
      }

      config.value.contexts = [
        {
          scopeType: 'collection',
          scopeKey: 'notes:',
          text: 'Test context',
        },
      ];
      await saveConfigToPath(config.value, TEST_CONFIG_PATH);

      try {
        await collectionRename('notes', 'documents');
      } catch {
        // Ignore exit error
      }

      const result = await loadConfigFromPath(TEST_CONFIG_PATH);
      if (!result.ok) {
        return;
      }

      expect(result.value.contexts[0]?.scopeKey).toBe('documents:');
    });

    test('updates prefix scope contexts', async () => {
      const config = await loadConfigFromPath(TEST_CONFIG_PATH);
      if (!config.ok) {
        return;
      }

      config.value.contexts = [
        {
          scopeType: 'prefix',
          scopeKey: 'gno://notes/projects',
          text: 'Test context',
        },
      ];
      await saveConfigToPath(config.value, TEST_CONFIG_PATH);

      try {
        await collectionRename('notes', 'documents');
      } catch {
        // Ignore exit error
      }

      const result = await loadConfigFromPath(TEST_CONFIG_PATH);
      if (!result.ok) {
        return;
      }

      expect(result.value.contexts[0]?.scopeKey).toBe(
        'gno://documents/projects'
      );
    });

    test('converts names to lowercase', async () => {
      try {
        await collectionRename('NOTES', 'Documents');
      } catch {
        // Ignore exit error
      }

      const result = await loadConfigFromPath(TEST_CONFIG_PATH);
      if (!result.ok) {
        return;
      }

      expect(result.value.collections[0]?.name).toBe('documents');
    });

    test('validates new name format', async () => {
      try {
        await collectionRename('notes', 'Invalid Name!');
      } catch {
        // Ignore exit error
      }

      expect(exitCode).toBe(1);
      expect(consoleErrors.join('\n')).toContain('Invalid collection name');
    });
  });
});
