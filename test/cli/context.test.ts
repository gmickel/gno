/**
 * Tests for context CLI commands
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  contextAdd,
  contextCheck,
  contextList,
  contextRm,
} from '../../src/cli/commands/context';
import { loadConfigFromPath } from '../../src/config/loader';
import { saveConfigToPath } from '../../src/config/saver';
import type { Config } from '../../src/config/types';
import { safeRm } from '../helpers/cleanup';

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

let testDir: string;

const MINIMAL_CONFIG: Config = {
  version: '1.0',
  ftsTokenizer: 'unicode61',
  collections: [],
  contexts: [],
};

const CONFIG_WITH_COLLECTION: Config = {
  version: '1.0',
  ftsTokenizer: 'unicode61',
  collections: [
    {
      name: 'notes',
      path: '/test/notes',
      pattern: '**/*',
      include: [],
      exclude: ['.git', 'node_modules'],
    },
  ],
  contexts: [],
};

/**
 * Set up environment variables and create temp directories
 */
async function setupTest(): Promise<void> {
  testDir = await mkdtemp(join(tmpdir(), 'gno-test-'));
  process.env.GNO_CONFIG_DIR = join(testDir, 'config');
  process.env.GNO_DATA_DIR = join(testDir, 'data');
}

/**
 * Get config file path
 */
function getConfigPath(): string {
  return join(testDir, 'config', 'index.yml');
}

/**
 * Clean up test directories and env vars
 */
async function teardownTest(): Promise<void> {
  process.env.GNO_CONFIG_DIR = undefined;
  process.env.GNO_DATA_DIR = undefined;

  if (testDir) {
    await safeRm(testDir);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('contextAdd', () => {
  beforeEach(async () => {
    await setupTest();
    await saveConfigToPath(MINIMAL_CONFIG, getConfigPath());
  });

  afterEach(async () => {
    await teardownTest();
  });

  test('adds global context', async () => {
    const exitCode = await contextAdd('/', 'Global knowledge base');
    expect(exitCode).toBe(0);

    const result = await loadConfigFromPath(getConfigPath());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.contexts).toHaveLength(1);
    const ctx = result.value.contexts[0];
    expect(ctx?.scopeType).toBe('global');
    expect(ctx?.scopeKey).toBe('/');
    expect(ctx?.text).toBe('Global knowledge base');
  });

  test('adds collection context', async () => {
    await saveConfigToPath(CONFIG_WITH_COLLECTION, getConfigPath());

    const exitCode = await contextAdd('notes:', 'Daily notes');
    expect(exitCode).toBe(0);

    const result = await loadConfigFromPath(getConfigPath());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.contexts).toHaveLength(1);
    const ctx = result.value.contexts[0];
    expect(ctx?.scopeType).toBe('collection');
    expect(ctx?.scopeKey).toBe('notes:');
    expect(ctx?.text).toBe('Daily notes');
  });

  test('adds prefix context', async () => {
    await saveConfigToPath(CONFIG_WITH_COLLECTION, getConfigPath());

    const exitCode = await contextAdd(
      'gno://notes/projects',
      'Project documentation'
    );
    expect(exitCode).toBe(0);

    const result = await loadConfigFromPath(getConfigPath());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.contexts).toHaveLength(1);
    const ctx = result.value.contexts[0];
    expect(ctx?.scopeType).toBe('prefix');
    expect(ctx?.scopeKey).toBe('gno://notes/projects');
    expect(ctx?.text).toBe('Project documentation');
  });

  test('rejects invalid scope format', async () => {
    const exitCode = await contextAdd('invalid-scope', 'Some text');
    expect(exitCode).toBe(1);
  });

  test('rejects duplicate scope', async () => {
    const configWithContext: Config = {
      ...MINIMAL_CONFIG,
      contexts: [
        {
          scopeType: 'global',
          scopeKey: '/',
          text: 'Existing context',
        },
      ],
    };
    await saveConfigToPath(configWithContext, getConfigPath());

    const exitCode = await contextAdd('/', 'New context');
    expect(exitCode).toBe(1);
  });
});

describe('contextList', () => {
  beforeEach(async () => {
    await setupTest();
  });

  afterEach(async () => {
    await teardownTest();
  });

  test('lists contexts', async () => {
    const configWithContexts: Config = {
      ...MINIMAL_CONFIG,
      contexts: [
        { scopeType: 'global', scopeKey: '/', text: 'Global context' },
        { scopeType: 'collection', scopeKey: 'notes:', text: 'Notes context' },
      ],
    };
    await saveConfigToPath(configWithContexts, getConfigPath());

    const exitCode = await contextList('terminal');
    expect(exitCode).toBe(0);
  });

  test('handles empty contexts', async () => {
    await saveConfigToPath(MINIMAL_CONFIG, getConfigPath());

    const exitCode = await contextList('terminal');
    expect(exitCode).toBe(0);
  });
});

describe('contextCheck', () => {
  beforeEach(async () => {
    await setupTest();
  });

  afterEach(async () => {
    await teardownTest();
  });

  test('validates valid configuration', async () => {
    const configWithContexts: Config = {
      ...CONFIG_WITH_COLLECTION,
      contexts: [
        { scopeType: 'global', scopeKey: '/', text: 'Global context' },
        { scopeType: 'collection', scopeKey: 'notes:', text: 'Notes context' },
      ],
    };
    await saveConfigToPath(configWithContexts, getConfigPath());

    const exitCode = await contextCheck('terminal');
    expect(exitCode).toBe(0);
  });

  test('detects non-existent collection reference', async () => {
    const configWithBadContext: Config = {
      ...MINIMAL_CONFIG,
      contexts: [
        {
          scopeType: 'collection',
          scopeKey: 'missing:',
          text: 'Missing collection',
        },
      ],
    };
    await saveConfigToPath(configWithBadContext, getConfigPath());

    const exitCode = await contextCheck('json');
    expect(exitCode).toBe(0); // Doesn't fail, just reports errors
  });
});

describe('contextRm', () => {
  beforeEach(async () => {
    await setupTest();
  });

  afterEach(async () => {
    await teardownTest();
  });

  test('removes existing context', async () => {
    const configWithContexts: Config = {
      ...MINIMAL_CONFIG,
      contexts: [
        { scopeType: 'global', scopeKey: '/', text: 'Global context' },
        { scopeType: 'collection', scopeKey: 'notes:', text: 'Notes context' },
      ],
    };
    await saveConfigToPath(configWithContexts, getConfigPath());

    const exitCode = await contextRm('/');
    expect(exitCode).toBe(0);

    const result = await loadConfigFromPath(getConfigPath());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.contexts).toHaveLength(1);
    expect(result.value.contexts[0]?.scopeKey).toBe('notes:');
  });

  test('returns error for non-existent scope', async () => {
    await saveConfigToPath(MINIMAL_CONFIG, getConfigPath());

    const exitCode = await contextRm('/');
    expect(exitCode).toBe(1);
  });
});
