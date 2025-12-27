import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultConfig } from '../../src/config/defaults';
import { loadConfigFromPath } from '../../src/config/loader';
import { saveConfigToPath } from '../../src/config/saver';
import type { Config } from '../../src/config/types';
import { safeRm } from '../helpers/cleanup';

describe('saveConfigToPath', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `gno-test-${Date.now()}`);
  });

  afterEach(async () => {
    await safeRm(tempDir);
  });

  test('saves default config and loads it back', async () => {
    const config = createDefaultConfig();
    const filePath = join(tempDir, 'config', 'index.yml');

    // Save
    const saveResult = await saveConfigToPath(config, filePath);
    expect(saveResult.ok).toBe(true);
    if (saveResult.ok) {
      expect(saveResult.path).toBe(filePath);
    }

    // Load back
    const loadResult = await loadConfigFromPath(filePath);
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(loadResult.value).toEqual(config);
    }
  });

  test('saves full config and preserves all fields', async () => {
    const config: Config = {
      version: '1.0',
      ftsTokenizer: 'porter',
      collections: [
        {
          name: 'notes',
          path: '/home/user/notes',
          pattern: '**/*.md',
          include: [],
          exclude: ['.git', 'node_modules'],
          updateCmd: 'git pull',
          languageHint: 'en',
        },
      ],
      contexts: [
        {
          scopeType: 'global',
          scopeKey: '/',
          text: 'Global context',
        },
        {
          scopeType: 'collection',
          scopeKey: 'notes:',
          text: 'Notes context',
        },
      ],
    };

    const filePath = join(tempDir, 'full-config.yml');

    // Save
    const saveResult = await saveConfigToPath(config, filePath);
    expect(saveResult.ok).toBe(true);

    // Load back
    const loadResult = await loadConfigFromPath(filePath);
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(loadResult.value.version).toBe('1.0');
      expect(loadResult.value.ftsTokenizer).toBe('porter');
      expect(loadResult.value.collections).toHaveLength(1);
      expect(loadResult.value.collections[0]?.name).toBe('notes');
      expect(loadResult.value.collections[0]?.updateCmd).toBe('git pull');
      expect(loadResult.value.contexts).toHaveLength(2);
    }
  });

  test('creates parent directories if missing', async () => {
    const config = createDefaultConfig();
    const deepPath = join(tempDir, 'deep', 'nested', 'path', 'config.yml');

    const result = await saveConfigToPath(config, deepPath);

    expect(result.ok).toBe(true);

    const file = Bun.file(deepPath);
    expect(await file.exists()).toBe(true);
  });

  test('rejects invalid config', async () => {
    const invalidConfig = {
      version: '1.0',
      ftsTokenizer: 'invalid-tokenizer', // Invalid value
      collections: [],
      contexts: [],
    } as unknown as Config;

    const filePath = join(tempDir, 'invalid.yml');
    const result = await saveConfigToPath(invalidConfig, filePath);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
    }
  });

  test('overwrites existing file', async () => {
    const filePath = join(tempDir, 'overwrite.yml');

    // Save initial config
    const config1 = createDefaultConfig();
    config1.ftsTokenizer = 'unicode61';
    await saveConfigToPath(config1, filePath);

    // Overwrite with different config
    const config2 = createDefaultConfig();
    config2.ftsTokenizer = 'porter';
    const result = await saveConfigToPath(config2, filePath);

    expect(result.ok).toBe(true);

    // Verify overwrite
    const loadResult = await loadConfigFromPath(filePath);
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(loadResult.value.ftsTokenizer).toBe('porter');
    }
  });
});
