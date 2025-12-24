/**
 * gno doctor command implementation.
 * Diagnose configuration and dependencies.
 *
 * @module src/cli/commands/doctor
 */

import { stat } from 'node:fs/promises';
import { getIndexDbPath, getModelsCachePath } from '../../app/constants';
import { getConfigPaths, isInitialized, loadConfig } from '../../config';
import type { Config } from '../../config/types';
import { ModelCache } from '../../llm/cache';
import { getActivePreset } from '../../llm/registry';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type DoctorCheckStatus = 'ok' | 'warn' | 'error';

export type DoctorCheck = {
  name: string;
  status: DoctorCheckStatus;
  message: string;
};

export type DoctorOptions = {
  /** Override config path */
  configPath?: string;
  /** Output as JSON */
  json?: boolean;
  /** Output as Markdown */
  md?: boolean;
};

export type DoctorResult = {
  healthy: boolean;
  checks: DoctorCheck[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Checks
// ─────────────────────────────────────────────────────────────────────────────

async function checkConfig(configPath?: string): Promise<DoctorCheck> {
  const initialized = await isInitialized(configPath);
  if (!initialized) {
    return {
      name: 'config',
      status: 'error',
      message: 'Config not found. Run: gno init',
    };
  }

  const configResult = await loadConfig(configPath);
  if (!configResult.ok) {
    return {
      name: 'config',
      status: 'error',
      message: `Config invalid: ${configResult.error.message}`,
    };
  }

  const paths = getConfigPaths();
  return {
    name: 'config',
    status: 'ok',
    message: `Config loaded: ${paths.configFile}`,
  };
}

async function checkDatabase(): Promise<DoctorCheck> {
  const dbPath = getIndexDbPath();

  try {
    await stat(dbPath);
    return {
      name: 'database',
      status: 'ok',
      message: `Database found: ${dbPath}`,
    };
  } catch {
    return {
      name: 'database',
      status: 'warn',
      message: 'Database not found. Run: gno init',
    };
  }
}

async function checkModels(config: Config): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const cache = new ModelCache(getModelsCachePath());
  const preset = getActivePreset(config);

  for (const type of ['embed', 'rerank', 'gen'] as const) {
    const uri = preset[type];
    const cached = await cache.isCached(uri);

    checks.push({
      name: `${type}-model`,
      status: cached ? 'ok' : 'warn',
      message: cached
        ? `${type} model cached`
        : `${type} model not cached. Run: gno models pull --${type}`,
    });
  }

  return checks;
}

async function checkNodeLlamaCpp(): Promise<DoctorCheck> {
  try {
    const { getLlama } = await import('node-llama-cpp');
    // Just check that we can get the llama instance
    await getLlama();
    return {
      name: 'node-llama-cpp',
      status: 'ok',
      message: 'node-llama-cpp loaded successfully',
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      name: 'node-llama-cpp',
      status: 'error',
      message: `node-llama-cpp failed: ${message}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute gno doctor command.
 */
export async function doctor(
  options: DoctorOptions = {}
): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];

  // Config check
  checks.push(await checkConfig(options.configPath));

  // Database check
  checks.push(await checkDatabase());

  // Load config for model checks (if available)
  const { createDefaultConfig } = await import('../../config');
  const configResult = await loadConfig(options.configPath);
  const config = configResult.ok ? configResult.value : createDefaultConfig();

  // Model checks
  const modelChecks = await checkModels(config);
  checks.push(...modelChecks);

  // node-llama-cpp check
  checks.push(await checkNodeLlamaCpp());

  // Determine overall health
  const hasErrors = checks.some((c) => c.status === 'error');

  return {
    healthy: !hasErrors,
    checks,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

function statusIcon(status: DoctorCheckStatus): string {
  switch (status) {
    case 'ok':
      return '✓';
    case 'warn':
      return '!';
    case 'error':
      return '✗';
    default:
      return '?';
  }
}

function formatTerminal(result: DoctorResult): string {
  const lines: string[] = [];

  lines.push('GNO Health Check');
  lines.push('');

  for (const check of result.checks) {
    lines.push(`  ${statusIcon(check.status)} ${check.name}: ${check.message}`);
  }

  lines.push('');
  lines.push(`Overall: ${result.healthy ? 'HEALTHY' : 'UNHEALTHY'}`);

  return lines.join('\n');
}

function formatMarkdown(result: DoctorResult): string {
  const lines: string[] = [];

  lines.push('# GNO Health Check');
  lines.push('');
  lines.push(`**Status**: ${result.healthy ? '✓ Healthy' : '✗ Unhealthy'}`);
  lines.push('');
  lines.push('## Checks');
  lines.push('');
  lines.push('| Check | Status | Message |');
  lines.push('|-------|--------|---------|');

  for (const check of result.checks) {
    lines.push(
      `| ${check.name} | ${statusIcon(check.status)} | ${check.message} |`
    );
  }

  return lines.join('\n');
}

/**
 * Format doctor result for output.
 */
export function formatDoctor(
  result: DoctorResult,
  options: DoctorOptions
): string {
  if (options.json) {
    return JSON.stringify(result, null, 2);
  }

  if (options.md) {
    return formatMarkdown(result);
  }

  return formatTerminal(result);
}
