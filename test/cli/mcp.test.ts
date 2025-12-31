import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { installMcp } from '../../src/cli/commands/mcp/install';
import {
  MCP_SERVER_NAME,
  MCP_TARGETS,
  resolveAllMcpPaths,
  resolveMcpConfigPath,
  TARGETS_WITH_PROJECT_SCOPE,
} from '../../src/cli/commands/mcp/paths';
import { statusMcp } from '../../src/cli/commands/mcp/status';
import { uninstallMcp } from '../../src/cli/commands/mcp/uninstall';
import { CliError } from '../../src/cli/errors';
import { resetGlobals } from '../../src/cli/program';
import { safeRm } from '../helpers/cleanup';

// Temp directory for tests
const TEST_DIR = join(import.meta.dir, '.temp-mcp-tests');
const FAKE_HOME = join(TEST_DIR, 'home');
const FAKE_CWD = join(TEST_DIR, 'project');

// Capture stdout output
let stdoutOutput: string[] = [];
const originalWrite = process.stdout.write.bind(process.stdout);
const mockWrite = (chunk: string | Uint8Array): boolean => {
  stdoutOutput.push(String(chunk));
  return true;
};

describe('MCP CLI commands', () => {
  beforeEach(async () => {
    // Set up mocks
    process.stdout.write = mockWrite as typeof process.stdout.write;
    stdoutOutput = [];
    resetGlobals();

    // Set up temp directories
    await safeRm(TEST_DIR);
    await mkdir(FAKE_HOME, { recursive: true });
    await mkdir(FAKE_CWD, { recursive: true });
  });

  afterEach(async () => {
    // Restore mocks
    process.stdout.write = originalWrite;

    // Clean up temp dir
    await safeRm(TEST_DIR);
  });

  describe('resolveMcpConfigPath', () => {
    test('resolves claude-desktop path (macOS)', () => {
      const result = resolveMcpConfigPath({
        target: 'claude-desktop',
        homeDir: FAKE_HOME,
      });

      // On macOS this is Library/Application Support/Claude
      expect(result.configPath).toContain('Claude');
      expect(result.configPath).toContain('claude_desktop_config.json');
      expect(result.supportsProjectScope).toBe(false);
    });

    test('resolves claude-code user path', () => {
      const result = resolveMcpConfigPath({
        target: 'claude-code',
        scope: 'user',
        homeDir: FAKE_HOME,
      });

      expect(result.configPath).toBe(join(FAKE_HOME, '.claude.json'));
      expect(result.supportsProjectScope).toBe(true);
    });

    test('resolves claude-code project path', () => {
      const result = resolveMcpConfigPath({
        target: 'claude-code',
        scope: 'project',
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      expect(result.configPath).toBe(join(FAKE_CWD, '.mcp.json'));
    });

    test('resolves codex user path', () => {
      const result = resolveMcpConfigPath({
        target: 'codex',
        scope: 'user',
        homeDir: FAKE_HOME,
      });

      expect(result.configPath).toBe(join(FAKE_HOME, '.codex.json'));
    });

    test('resolves codex project path', () => {
      const result = resolveMcpConfigPath({
        target: 'codex',
        scope: 'project',
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      expect(result.configPath).toBe(join(FAKE_CWD, '.codex/.mcp.json'));
    });
  });

  describe('resolveAllMcpPaths', () => {
    test('returns 13 entries for all/all', () => {
      const results = resolveAllMcpPaths('all', 'all', {
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      // User-only targets (1 each): claude-desktop, zed, windsurf, amp, lmstudio = 5
      // User+project targets (2 each): claude-code, codex, cursor, opencode, librechat = 10
      // Total: 15
      expect(results).toHaveLength(15);

      const targets = results.map((r) => r.target);
      expect(targets.filter((t) => t === 'claude-desktop')).toHaveLength(1);
      expect(targets.filter((t) => t === 'claude-code')).toHaveLength(2);
      expect(targets.filter((t) => t === 'codex')).toHaveLength(2);
      expect(targets.filter((t) => t === 'cursor')).toHaveLength(2);
      expect(targets.filter((t) => t === 'zed')).toHaveLength(1);
      expect(targets.filter((t) => t === 'windsurf')).toHaveLength(1);
      expect(targets.filter((t) => t === 'opencode')).toHaveLength(2);
      expect(targets.filter((t) => t === 'amp')).toHaveLength(1);
      expect(targets.filter((t) => t === 'lmstudio')).toHaveLength(1);
      expect(targets.filter((t) => t === 'librechat')).toHaveLength(2);
    });

    test('filters by target', () => {
      const results = resolveAllMcpPaths('all', 'claude-code', {
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.target === 'claude-code')).toBe(true);
    });

    test('filters by scope', () => {
      const results = resolveAllMcpPaths('project', 'all', {
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      // claude-code, codex, cursor, opencode, librechat support project scope
      expect(results).toHaveLength(5);
      expect(results.every((r) => r.scope === 'project')).toBe(true);
    });
  });

  describe('installMcp', () => {
    test('installs to claude-code (user scope)', async () => {
      await installMcp({
        target: 'claude-code',
        scope: 'user',
        homeDir: FAKE_HOME,
        cwd: FAKE_CWD,
      });

      const configPath = join(FAKE_HOME, '.claude.json');
      const config = await Bun.file(configPath).json();

      expect(config.mcpServers).toBeDefined();
      expect(config.mcpServers[MCP_SERVER_NAME]).toBeDefined();
      expect(config.mcpServers[MCP_SERVER_NAME].command).toBeTruthy();
      expect(stdoutOutput.join('')).toContain('Installed');
    });

    test('installs to claude-code (project scope)', async () => {
      await installMcp({
        target: 'claude-code',
        scope: 'project',
        homeDir: FAKE_HOME,
        cwd: FAKE_CWD,
      });

      const configPath = join(FAKE_CWD, '.mcp.json');
      const config = await Bun.file(configPath).json();

      expect(config.mcpServers[MCP_SERVER_NAME]).toBeDefined();
    });

    test('errors on duplicate without --force', async () => {
      // First install
      await installMcp({
        target: 'claude-code',
        scope: 'user',
        homeDir: FAKE_HOME,
        cwd: FAKE_CWD,
      });

      // Second install should fail
      let error: CliError | undefined;
      try {
        await installMcp({
          target: 'claude-code',
          scope: 'user',
          homeDir: FAKE_HOME,
          cwd: FAKE_CWD,
        });
      } catch (e) {
        error = e as CliError;
      }

      expect(error).toBeInstanceOf(CliError);
      expect(error?.code).toBe('VALIDATION');
      expect(error?.message).toContain('already has gno configured');
    });

    test('overwrites with --force', async () => {
      // First install
      await installMcp({
        target: 'claude-code',
        scope: 'user',
        homeDir: FAKE_HOME,
        cwd: FAKE_CWD,
      });

      // Second install with force
      stdoutOutput = [];
      await installMcp({
        target: 'claude-code',
        scope: 'user',
        force: true,
        homeDir: FAKE_HOME,
        cwd: FAKE_CWD,
      });

      expect(stdoutOutput.join('')).toContain('Updated');
    });

    test('dry-run does not modify files and reports create', async () => {
      await installMcp({
        target: 'claude-code',
        scope: 'user',
        dryRun: true,
        homeDir: FAKE_HOME,
        cwd: FAKE_CWD,
      });

      const configPath = join(FAKE_HOME, '.claude.json');
      expect(await Bun.file(configPath).exists()).toBe(false);
      expect(stdoutOutput.join('')).toContain('Dry run');
      expect(stdoutOutput.join('')).toContain('Would create');
    });

    test('dry-run reports update when config exists', async () => {
      // Create existing config with gno
      const configPath = join(FAKE_HOME, '.claude.json');
      await mkdir(FAKE_HOME, { recursive: true });
      await Bun.write(
        configPath,
        JSON.stringify({
          mcpServers: { [MCP_SERVER_NAME]: { command: 'old', args: [] } },
        })
      );

      stdoutOutput = [];
      await installMcp({
        target: 'claude-code',
        scope: 'user',
        dryRun: true,
        force: true,
        homeDir: FAKE_HOME,
        cwd: FAKE_CWD,
      });

      expect(stdoutOutput.join('')).toContain('Would update');
    });

    test('errors on project scope for claude-desktop', async () => {
      let error: CliError | undefined;
      try {
        await installMcp({
          target: 'claude-desktop',
          scope: 'project',
          homeDir: FAKE_HOME,
          cwd: FAKE_CWD,
        });
      } catch (e) {
        error = e as CliError;
      }

      expect(error).toBeInstanceOf(CliError);
      expect(error?.code).toBe('VALIDATION');
      expect(error?.message).toContain('does not support project scope');
    });

    test('preserves other mcpServers entries', async () => {
      // Create config with existing server
      const configPath = join(FAKE_HOME, '.claude.json');
      await mkdir(FAKE_HOME, { recursive: true });
      await Bun.write(
        configPath,
        JSON.stringify({
          mcpServers: {
            other: { command: 'other-cmd', args: ['arg1'] },
          },
        })
      );

      // Install gno
      await installMcp({
        target: 'claude-code',
        scope: 'user',
        homeDir: FAKE_HOME,
        cwd: FAKE_CWD,
      });

      const config = await Bun.file(configPath).json();
      expect(config.mcpServers.other).toBeDefined();
      expect(config.mcpServers.other.command).toBe('other-cmd');
      expect(config.mcpServers[MCP_SERVER_NAME]).toBeDefined();
    });

    test('errors on malformed JSON config', async () => {
      // Create malformed JSON file
      const configPath = join(FAKE_HOME, '.claude.json');
      await mkdir(FAKE_HOME, { recursive: true });
      await Bun.write(configPath, '{ "invalid json');

      let error: CliError | undefined;
      try {
        await installMcp({
          target: 'claude-code',
          scope: 'user',
          homeDir: FAKE_HOME,
          cwd: FAKE_CWD,
        });
      } catch (e) {
        error = e as CliError;
      }

      expect(error).toBeInstanceOf(CliError);
      expect(error?.code).toBe('RUNTIME');
      expect(error?.message).toContain('Malformed JSON');
    });

    test('creates backup before modifying existing config', async () => {
      // Create initial config
      const configPath = join(FAKE_HOME, '.claude.json');
      const backupPath = `${configPath}.bak`;
      const originalContent = JSON.stringify({ existing: 'data' });
      await mkdir(FAKE_HOME, { recursive: true });
      await Bun.write(configPath, originalContent);

      // Install gno (modifies config)
      await installMcp({
        target: 'claude-code',
        scope: 'user',
        homeDir: FAKE_HOME,
        cwd: FAKE_CWD,
      });

      // Verify backup was created with original content
      const backupFile = Bun.file(backupPath);
      expect(await backupFile.exists()).toBe(true);
      expect(await backupFile.text()).toBe(originalContent);
    });
  });

  describe('uninstallMcp', () => {
    test('removes gno entry', async () => {
      // First install
      await installMcp({
        target: 'claude-code',
        scope: 'user',
        homeDir: FAKE_HOME,
        cwd: FAKE_CWD,
      });

      // Then uninstall
      stdoutOutput = [];
      await uninstallMcp({
        target: 'claude-code',
        scope: 'user',
        homeDir: FAKE_HOME,
        cwd: FAKE_CWD,
      });

      const configPath = join(FAKE_HOME, '.claude.json');
      const config = await Bun.file(configPath).json();

      expect(config.mcpServers?.[MCP_SERVER_NAME]).toBeUndefined();
      expect(stdoutOutput.join('')).toContain('Removed');
    });

    test('preserves other mcpServers entries', async () => {
      // Create config with gno and another server
      const configPath = join(FAKE_HOME, '.claude.json');
      await mkdir(FAKE_HOME, { recursive: true });
      await Bun.write(
        configPath,
        JSON.stringify({
          mcpServers: {
            [MCP_SERVER_NAME]: { command: 'gno', args: ['mcp'] },
            other: { command: 'other-cmd', args: ['arg1'] },
          },
        })
      );

      // Uninstall gno
      await uninstallMcp({
        target: 'claude-code',
        scope: 'user',
        homeDir: FAKE_HOME,
        cwd: FAKE_CWD,
      });

      const config = await Bun.file(configPath).json();
      expect(config.mcpServers?.[MCP_SERVER_NAME]).toBeUndefined();
      expect(config.mcpServers?.other).toBeDefined();
    });

    test('handles not found gracefully', async () => {
      await uninstallMcp({
        target: 'claude-code',
        scope: 'user',
        homeDir: FAKE_HOME,
        cwd: FAKE_CWD,
      });

      expect(stdoutOutput.join('')).toContain('not configured');
    });

    test('cleans up empty mcpServers object', async () => {
      // Create config with only gno
      const configPath = join(FAKE_HOME, '.claude.json');
      await mkdir(FAKE_HOME, { recursive: true });
      await Bun.write(
        configPath,
        JSON.stringify({
          mcpServers: {
            [MCP_SERVER_NAME]: { command: 'gno', args: ['mcp'] },
          },
          otherKey: 'preserved',
        })
      );

      await uninstallMcp({
        target: 'claude-code',
        scope: 'user',
        homeDir: FAKE_HOME,
        cwd: FAKE_CWD,
      });

      const config = await Bun.file(configPath).json();
      expect(config.mcpServers).toBeUndefined();
      expect(config.otherKey).toBe('preserved');
    });
  });

  describe('statusMcp', () => {
    test('shows not configured for empty targets', async () => {
      await statusMcp({
        target: 'claude-code',
        scope: 'user',
        homeDir: FAKE_HOME,
        cwd: FAKE_CWD,
      });

      expect(stdoutOutput.join('')).toContain('not configured');
    });

    test('shows configured after install', async () => {
      // Install first
      await installMcp({
        target: 'claude-code',
        scope: 'user',
        homeDir: FAKE_HOME,
        cwd: FAKE_CWD,
      });

      stdoutOutput = [];
      await statusMcp({
        target: 'claude-code',
        scope: 'user',
        homeDir: FAKE_HOME,
        cwd: FAKE_CWD,
      });

      expect(stdoutOutput.join('')).toContain('configured');
      expect(stdoutOutput.join('')).toContain('1/1');
    });

    test('shows all targets with target=all', async () => {
      await statusMcp({
        target: 'all',
        scope: 'all',
        homeDir: FAKE_HOME,
        cwd: FAKE_CWD,
      });

      const output = stdoutOutput.join('');
      expect(output).toContain('Claude Desktop');
      expect(output).toContain('Claude Code');
      expect(output).toContain('Codex');
    });

    test('JSON output includes all targets', async () => {
      await statusMcp({
        target: 'all',
        scope: 'all',
        json: true,
        homeDir: FAKE_HOME,
        cwd: FAKE_CWD,
      });

      const output = JSON.parse(stdoutOutput.join(''));
      expect(output.targets).toHaveLength(15);
      expect(output.summary.total).toBe(15);
    });
  });

  describe('constants', () => {
    test('MCP_SERVER_NAME is gno', () => {
      expect(MCP_SERVER_NAME).toBe('gno');
    });

    test('MCP_TARGETS includes all expected targets', () => {
      expect(MCP_TARGETS).toContain('claude-desktop');
      expect(MCP_TARGETS).toContain('claude-code');
      expect(MCP_TARGETS).toContain('codex');
      expect(MCP_TARGETS).toContain('cursor');
      expect(MCP_TARGETS).toContain('zed');
      expect(MCP_TARGETS).toContain('windsurf');
      expect(MCP_TARGETS).toContain('opencode');
      expect(MCP_TARGETS).toContain('amp');
      expect(MCP_TARGETS).toContain('lmstudio');
      expect(MCP_TARGETS).toContain('librechat');
      expect(MCP_TARGETS).toHaveLength(10);
    });

    test('TARGETS_WITH_PROJECT_SCOPE includes correct targets', () => {
      expect(TARGETS_WITH_PROJECT_SCOPE).toContain('claude-code');
      expect(TARGETS_WITH_PROJECT_SCOPE).toContain('codex');
      expect(TARGETS_WITH_PROJECT_SCOPE).toContain('cursor');
      expect(TARGETS_WITH_PROJECT_SCOPE).toContain('opencode');
      expect(TARGETS_WITH_PROJECT_SCOPE).toContain('librechat');
      // User-only targets
      expect(TARGETS_WITH_PROJECT_SCOPE).not.toContain('claude-desktop');
      expect(TARGETS_WITH_PROJECT_SCOPE).not.toContain('zed');
      expect(TARGETS_WITH_PROJECT_SCOPE).not.toContain('windsurf');
      expect(TARGETS_WITH_PROJECT_SCOPE).not.toContain('amp');
      expect(TARGETS_WITH_PROJECT_SCOPE).not.toContain('lmstudio');
      expect(TARGETS_WITH_PROJECT_SCOPE).toHaveLength(5);
    });
  });
});
