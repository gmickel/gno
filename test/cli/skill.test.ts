import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { installSkill } from '../../src/cli/commands/skill/install';
import {
  resolveAllPaths,
  resolveSkillPaths,
  validatePathForDeletion,
} from '../../src/cli/commands/skill/paths';
import { showPaths } from '../../src/cli/commands/skill/paths-cmd';
import { showSkill } from '../../src/cli/commands/skill/show';
import { uninstallSkill } from '../../src/cli/commands/skill/uninstall';
import { CliError } from '../../src/cli/errors';
import { resetGlobals } from '../../src/cli/program';
import { safeRm } from '../helpers/cleanup';

// Temp directory for tests
const TEST_DIR = join(import.meta.dir, '.temp-skill-tests');
const FAKE_HOME = join(TEST_DIR, 'home');
const FAKE_CWD = join(TEST_DIR, 'project');

// Capture stdout output
let stdoutOutput: string[] = [];
const originalWrite = process.stdout.write.bind(process.stdout);
const mockWrite = (chunk: string | Uint8Array): boolean => {
  stdoutOutput.push(String(chunk));
  return true;
};

describe('skill CLI commands', () => {
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

  describe('resolveSkillPaths', () => {
    test('resolves project/claude paths', () => {
      const paths = resolveSkillPaths({
        scope: 'project',
        target: 'claude',
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      // base is the .claude directory
      expect(paths.base).toBe(join(FAKE_CWD, '.claude'));
      expect(paths.skillsDir).toBe(join(FAKE_CWD, '.claude', 'skills'));
      expect(paths.gnoDir).toBe(join(FAKE_CWD, '.claude', 'skills', 'gno'));
    });

    test('resolves user/claude paths', () => {
      const paths = resolveSkillPaths({
        scope: 'user',
        target: 'claude',
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      // base is the .claude directory
      expect(paths.base).toBe(join(FAKE_HOME, '.claude'));
      expect(paths.skillsDir).toBe(join(FAKE_HOME, '.claude', 'skills'));
      expect(paths.gnoDir).toBe(join(FAKE_HOME, '.claude', 'skills', 'gno'));
    });

    test('resolves project/codex paths', () => {
      const paths = resolveSkillPaths({
        scope: 'project',
        target: 'codex',
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      expect(paths.skillsDir).toBe(join(FAKE_CWD, '.codex', 'skills'));
      expect(paths.gnoDir).toBe(join(FAKE_CWD, '.codex', 'skills', 'gno'));
    });

    test('resolves user/codex paths', () => {
      const paths = resolveSkillPaths({
        scope: 'user',
        target: 'codex',
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      expect(paths.skillsDir).toBe(join(FAKE_HOME, '.codex', 'skills'));
      expect(paths.gnoDir).toBe(join(FAKE_HOME, '.codex', 'skills', 'gno'));
    });
  });

  describe('resolveAllPaths', () => {
    test('returns all 4 combinations for scope=all, target=all', () => {
      const results = resolveAllPaths('all', 'all', {
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      expect(results).toHaveLength(4);
      const combos = results.map((r) => `${r.scope}/${r.target}`);
      expect(combos).toContain('project/claude');
      expect(combos).toContain('project/codex');
      expect(combos).toContain('user/claude');
      expect(combos).toContain('user/codex');
    });

    test('filters by scope', () => {
      const results = resolveAllPaths('project', 'all', {
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.scope === 'project')).toBe(true);
    });

    test('filters by target', () => {
      const results = resolveAllPaths('all', 'claude', {
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.target === 'claude')).toBe(true);
    });
  });

  describe('validatePathForDeletion', () => {
    test('accepts valid gno skill path', () => {
      const base = '/home/user';
      const destDir = '/home/user/.claude/skills/gno';
      expect(validatePathForDeletion(destDir, base)).toBeNull();
    });

    test('rejects path not ending in /gno', () => {
      const base = '/home/user';
      const destDir = '/home/user/.claude/skills/other';
      const error = validatePathForDeletion(destDir, base);
      expect(error).toContain('gno');
    });

    test('rejects path not under base', () => {
      const base = '/home/user';
      const destDir = '/other/path/.claude/skills/gno';
      const error = validatePathForDeletion(destDir, base);
      expect(error).toContain('base');
    });

    test('rejects path not ending in /skills/gno', () => {
      const base = '/home/user';
      const destDir = '/home/user/gno';
      const error = validatePathForDeletion(destDir, base);
      expect(error).toContain('suffix');
    });
  });

  describe('installSkill', () => {
    test('installs skill to project/claude', async () => {
      await installSkill({
        scope: 'project',
        target: 'claude',
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      const skillDir = join(FAKE_CWD, '.claude', 'skills', 'gno');
      const files = await readdir(skillDir);
      expect(files).toContain('SKILL.md');
      expect(stdoutOutput.join('')).toContain('Installed');
    });

    test('installs skill to all targets', async () => {
      await installSkill({
        scope: 'project',
        target: 'all',
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      const claudeDir = join(FAKE_CWD, '.claude', 'skills', 'gno');
      const codexDir = join(FAKE_CWD, '.codex', 'skills', 'gno');

      expect(await Bun.file(join(claudeDir, 'SKILL.md')).exists()).toBe(true);
      expect(await Bun.file(join(codexDir, 'SKILL.md')).exists()).toBe(true);
    });

    test('errors on duplicate without --force', async () => {
      // First install
      await installSkill({
        scope: 'project',
        target: 'claude',
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      // Second install should fail
      let error: CliError | undefined;
      try {
        await installSkill({
          scope: 'project',
          target: 'claude',
          cwd: FAKE_CWD,
          homeDir: FAKE_HOME,
        });
      } catch (e) {
        error = e as CliError;
      }

      expect(error).toBeInstanceOf(CliError);
      expect(error?.code).toBe('VALIDATION');
      expect(error?.message).toContain('already installed');
    });

    test('overwrites with --force', async () => {
      // First install
      await installSkill({
        scope: 'project',
        target: 'claude',
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      // Second install with force
      await installSkill({
        scope: 'project',
        target: 'claude',
        force: true,
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      // Should succeed
      const skillDir = join(FAKE_CWD, '.claude', 'skills', 'gno');
      expect(await Bun.file(join(skillDir, 'SKILL.md')).exists()).toBe(true);
    });
  });

  describe('uninstallSkill', () => {
    test('uninstalls existing skill', async () => {
      // First install
      await installSkill({
        scope: 'project',
        target: 'claude',
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      // Then uninstall
      stdoutOutput = [];
      await uninstallSkill({
        scope: 'project',
        target: 'claude',
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      const skillDir = join(FAKE_CWD, '.claude', 'skills', 'gno');
      expect(await Bun.file(join(skillDir, 'SKILL.md')).exists()).toBe(false);
      expect(stdoutOutput.join('')).toContain('Uninstalled');
    });

    test('errors if skill not found', async () => {
      let error: CliError | undefined;
      try {
        await uninstallSkill({
          scope: 'project',
          target: 'claude',
          cwd: FAKE_CWD,
          homeDir: FAKE_HOME,
        });
      } catch (e) {
        error = e as CliError;
      }

      expect(error).toBeInstanceOf(CliError);
      expect(error?.code).toBe('VALIDATION');
      expect(error?.message).toContain('not found');
    });
  });

  describe('showSkill', () => {
    test('shows SKILL.md by default', async () => {
      await showSkill({});

      const output = stdoutOutput.join('');
      expect(output).toContain('name: gno');
      expect(output).toContain('description:');
    });

    test('shows specific file', async () => {
      await showSkill({ file: 'cli-reference.md' });

      const output = stdoutOutput.join('');
      expect(output).toContain('CLI Reference');
    });

    test('shows all files with --all', async () => {
      await showSkill({ all: true });

      const output = stdoutOutput.join('');
      expect(output).toContain('--- SKILL.md ---');
      expect(output).toContain('--- cli-reference.md ---');
    });

    test('errors on unknown file', async () => {
      let error: CliError | undefined;
      try {
        await showSkill({ file: 'nonexistent.md' });
      } catch (e) {
        error = e as CliError;
      }

      expect(error).toBeInstanceOf(CliError);
      expect(error?.code).toBe('VALIDATION');
      expect(error?.message).toContain('Unknown file');
    });
  });

  describe('showPaths', () => {
    test('shows all paths', async () => {
      await showPaths({
        scope: 'all',
        target: 'all',
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      const output = stdoutOutput.join('');
      expect(output).toContain('claude/project');
      expect(output).toContain('claude/user');
      expect(output).toContain('codex/project');
      expect(output).toContain('codex/user');
    });

    test('shows installed status', async () => {
      // Install first
      await installSkill({
        scope: 'project',
        target: 'claude',
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      stdoutOutput = [];
      await showPaths({
        scope: 'all',
        target: 'all',
        cwd: FAKE_CWD,
        homeDir: FAKE_HOME,
      });

      const output = stdoutOutput.join('');
      expect(output).toContain('(installed)');
      expect(output).toContain('(not installed)');
    });
  });
});
