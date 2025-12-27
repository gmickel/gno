import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  collectionAdd,
  collectionList,
  collectionRemove,
  collectionRename,
} from '../../src/cli/commands/collection';
import { CliError } from '../../src/cli/errors';
import {
  createDefaultConfig,
  loadConfigFromPath,
  saveConfigToPath,
} from '../../src/config';
import { safeRm } from '../helpers/cleanup';

// Temp directory for tests
const TEST_DIR = join(import.meta.dir, '.temp-collection-tests');
const TEST_CONFIG_PATH = join(TEST_DIR, 'config', 'index.yml');
const TEST_COLLECTION_PATH = join(TEST_DIR, 'collections', 'test-coll');

// Capture stdout output
let stdoutOutput: string[] = [];
const originalWrite = process.stdout.write.bind(process.stdout);
const mockWrite = (chunk: string | Uint8Array): boolean => {
  stdoutOutput.push(String(chunk));
  return true;
};

describe('collection CLI commands', () => {
  beforeEach(async () => {
    // Set up mocks
    process.stdout.write = mockWrite as typeof process.stdout.write;
    stdoutOutput = [];

    // Set up temp directories
    await safeRm(TEST_DIR);
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
    process.stdout.write = originalWrite;
    process.env.GNO_CONFIG_DIR = undefined;

    // Clean up temp dir
    await safeRm(TEST_DIR);
  });

  describe('collectionAdd', () => {
    test('adds collection with required name', async () => {
      await collectionAdd(TEST_COLLECTION_PATH, {
        name: 'test-coll',
      });

      expect(stdoutOutput.join('')).toContain('added successfully');

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
      await collectionAdd(TEST_COLLECTION_PATH, {
        name: 'Test-COLL',
      });

      const result = await loadConfigFromPath(TEST_CONFIG_PATH);
      if (!result.ok) {
        return;
      }

      expect(result.value.collections[0]?.name).toBe('test-coll');
    });

    test('errors if name missing', async () => {
      let error: CliError | undefined;
      try {
        await collectionAdd(TEST_COLLECTION_PATH, {});
      } catch (e) {
        error = e as CliError;
      }

      expect(error).toBeInstanceOf(CliError);
      expect(error?.code).toBe('VALIDATION');
      expect(error?.message).toContain('--name is required');
    });

    test('errors if path does not exist', async () => {
      let error: CliError | undefined;
      try {
        await collectionAdd('/nonexistent/path', {
          name: 'test',
        });
      } catch (e) {
        error = e as CliError;
      }

      expect(error).toBeInstanceOf(CliError);
      expect(error?.code).toBe('VALIDATION');
      expect(error?.message).toContain('does not exist');
    });

    test('errors on duplicate name', async () => {
      // Add first collection
      await collectionAdd(TEST_COLLECTION_PATH, {
        name: 'test-coll',
      });

      // Try to add duplicate
      let error: CliError | undefined;
      try {
        await collectionAdd(TEST_COLLECTION_PATH, {
          name: 'test-coll',
        });
      } catch (e) {
        error = e as CliError;
      }

      expect(error).toBeInstanceOf(CliError);
      expect(error?.code).toBe('VALIDATION');
      expect(error?.message).toContain('already exists');
    });

    test('accepts custom pattern', async () => {
      await collectionAdd(TEST_COLLECTION_PATH, {
        name: 'test',
        pattern: '**/*.md',
      });

      const result = await loadConfigFromPath(TEST_CONFIG_PATH);
      if (!result.ok) {
        return;
      }

      expect(result.value.collections[0]?.pattern).toBe('**/*.md');
    });

    test('parses include extensions', async () => {
      await collectionAdd(TEST_COLLECTION_PATH, {
        name: 'test',
        include: '.md,.txt,.pdf',
      });

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
      await collectionAdd(TEST_COLLECTION_PATH, {
        name: 'test',
        exclude: '.git,node_modules,dist',
      });

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
      await collectionAdd(TEST_COLLECTION_PATH, {
        name: 'test',
        update: 'git pull',
      });

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
      await collectionList({});

      const output = stdoutOutput.join('');
      expect(output).toContain('notes');
      expect(output).toContain('work');
      expect(output).toContain('/test/notes');
      expect(output).toContain('/test/work');
    });

    test('lists collections in JSON format', async () => {
      await collectionList({ json: true });

      const output = stdoutOutput.join('');
      const parsed = JSON.parse(output);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]?.name).toBe('notes');
      expect(parsed[1]?.name).toBe('work');
    });

    test('lists collections in Markdown format', async () => {
      await collectionList({ md: true });

      const output = stdoutOutput.join('');
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

      await collectionList({});

      expect(stdoutOutput.join('')).toContain('No collections');
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
      await collectionRemove('notes');

      expect(stdoutOutput.join('')).toContain('removed successfully');

      const result = await loadConfigFromPath(TEST_CONFIG_PATH);
      if (!result.ok) {
        return;
      }

      expect(result.value.collections).toHaveLength(0);
    });

    test('errors if collection not found', async () => {
      let error: CliError | undefined;
      try {
        await collectionRemove('nonexistent');
      } catch (e) {
        error = e as CliError;
      }

      expect(error).toBeInstanceOf(CliError);
      expect(error?.code).toBe('VALIDATION');
      expect(error?.message).toContain('not found');
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

      let error: CliError | undefined;
      try {
        await collectionRemove('notes');
      } catch (e) {
        error = e as CliError;
      }

      expect(error).toBeInstanceOf(CliError);
      expect(error?.code).toBe('VALIDATION');
      expect(error?.message).toContain('referenced by contexts');
    });

    test('converts name to lowercase', async () => {
      await collectionRemove('NOTES');

      expect(stdoutOutput.join('')).toContain('removed successfully');
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
      await collectionRename('notes', 'documents');

      expect(stdoutOutput.join('')).toContain('renamed to');

      const result = await loadConfigFromPath(TEST_CONFIG_PATH);
      if (!result.ok) {
        return;
      }

      expect(result.value.collections).toHaveLength(1);
      expect(result.value.collections[0]?.name).toBe('documents');
    });

    test('errors if old name not found', async () => {
      let error: CliError | undefined;
      try {
        await collectionRename('nonexistent', 'newname');
      } catch (e) {
        error = e as CliError;
      }

      expect(error).toBeInstanceOf(CliError);
      expect(error?.code).toBe('VALIDATION');
      expect(error?.message).toContain('not found');
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

      let error: CliError | undefined;
      try {
        await collectionRename('notes', 'work');
      } catch (e) {
        error = e as CliError;
      }

      expect(error).toBeInstanceOf(CliError);
      expect(error?.code).toBe('VALIDATION');
      expect(error?.message).toContain('already exists');
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

      await collectionRename('notes', 'documents');

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

      await collectionRename('notes', 'documents');

      const result = await loadConfigFromPath(TEST_CONFIG_PATH);
      if (!result.ok) {
        return;
      }

      expect(result.value.contexts[0]?.scopeKey).toBe(
        'gno://documents/projects'
      );
    });

    test('converts names to lowercase', async () => {
      await collectionRename('NOTES', 'Documents');

      const result = await loadConfigFromPath(TEST_CONFIG_PATH);
      if (!result.ok) {
        return;
      }

      expect(result.value.collections[0]?.name).toBe('documents');
    });

    test('validates new name format', async () => {
      let error: CliError | undefined;
      try {
        await collectionRename('notes', 'Invalid Name!');
      } catch (e) {
        error = e as CliError;
      }

      expect(error).toBeInstanceOf(CliError);
      expect(error?.code).toBe('VALIDATION');
      expect(error?.message).toContain('Invalid collection name');
    });
  });
});
