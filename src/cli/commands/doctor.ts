/**
 * gno doctor command implementation.
 * Diagnose configuration and dependencies.
 *
 * @module src/cli/commands/doctor
 */

import { Database } from 'bun:sqlite';
import { stat } from 'node:fs/promises';
// node:os: arch/platform detection (no Bun equivalent)
import { arch, platform } from 'node:os';
import { getIndexDbPath, getModelsCachePath } from '../../app/constants';
import { getConfigPaths, isInitialized, loadConfig } from '../../config';
import type { Config } from '../../config/types';
import { ModelCache } from '../../llm/cache';
import { getActivePreset } from '../../llm/registry';
import {
  getCustomSqlitePath,
  getExtensionLoadingMode,
  getLoadAttempts,
} from '../../store/sqlite/setup';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type DoctorCheckStatus = 'ok' | 'warn' | 'error';

export interface DoctorCheck {
  name: string;
  status: DoctorCheckStatus;
  message: string;
  /** Additional diagnostic details (shown in verbose/json output) */
  details?: string[];
}

export interface DoctorOptions {
  /** Override config path */
  configPath?: string;
  /** Output as JSON */
  json?: boolean;
  /** Output as Markdown */
  md?: boolean;
}

export interface DoctorResult {
  healthy: boolean;
  checks: DoctorCheck[];
}

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

/**
 * Check SQLite extension support (FTS5, sqlite-vec).
 * Uses runtime capability probes instead of compile_options strings.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: diagnostic checks with platform-specific handling
async function checkSqliteExtensions(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const plat = platform();
  const archName = arch();
  const mode = getExtensionLoadingMode();
  const customPath = getCustomSqlitePath();
  const attempts = getLoadAttempts();

  // Platform/mode info
  let modeDesc = 'unavailable';
  if (mode === 'native') {
    modeDesc = 'native (bundled SQLite supports extensions)';
  } else if (mode === 'custom') {
    modeDesc = `custom (${customPath})`;
  }

  const details: string[] = [
    `Platform: ${plat}-${archName}`,
    `Mode: ${modeDesc}`,
  ];

  // Add load attempt details if there were failures
  if (attempts.length > 0) {
    details.push('Load attempts:');
    for (const attempt of attempts) {
      details.push(`  ${attempt.path}: ${attempt.error}`);
    }
  }

  // Create in-memory DB for probes
  const db = new Database(':memory:');
  let version = 'unknown';

  try {
    const row = db.query('SELECT sqlite_version() as v').get() as { v: string };
    version = row.v;
    details.push(`SQLite version: ${version}`);
  } catch {
    // Continue with unknown version
  }

  // Probe FTS5 capability
  let fts5Available = false;
  try {
    db.exec('CREATE VIRTUAL TABLE _fts5_probe USING fts5(x)');
    db.exec('DROP TABLE _fts5_probe');
    fts5Available = true;
  } catch {
    // FTS5 not available
  }

  checks.push({
    name: 'sqlite-fts5',
    status: fts5Available ? 'ok' : 'error',
    message: fts5Available ? 'FTS5 available' : 'FTS5 not available (required)',
    details: fts5Available
      ? undefined
      : ['Full-text search requires FTS5 support'],
  });

  // Probe JSON capability
  let jsonAvailable = false;
  try {
    db.query("SELECT json_valid('{}')").get();
    jsonAvailable = true;
  } catch {
    // JSON not available
  }

  checks.push({
    name: 'sqlite-json',
    status: jsonAvailable ? 'ok' : 'warn',
    message: jsonAvailable ? 'JSON1 available' : 'JSON1 not available',
  });

  // Probe sqlite-vec extension
  let sqliteVecAvailable = false;
  let sqliteVecVersion = '';
  let sqliteVecError = '';
  try {
    const sqliteVec = await import('sqlite-vec');
    sqliteVec.load(db);
    sqliteVecAvailable = true;
    // Try to get version
    try {
      const vrow = db.query('SELECT vec_version() as v').get() as { v: string };
      sqliteVecVersion = vrow.v;
    } catch {
      // No version available
    }
  } catch (e) {
    sqliteVecError = e instanceof Error ? e.message : String(e);
  }

  let vecMessage: string;
  if (sqliteVecAvailable) {
    vecMessage = sqliteVecVersion
      ? `sqlite-vec loaded (v${sqliteVecVersion})`
      : 'sqlite-vec loaded';
  } else if (mode === 'unavailable') {
    vecMessage =
      'sqlite-vec unavailable (no extension support on macOS without Homebrew)';
  } else {
    vecMessage = sqliteVecError
      ? `sqlite-vec failed: ${sqliteVecError}`
      : 'sqlite-vec failed to load';
  }

  const vecDetails = [...details];
  if (!sqliteVecAvailable && plat === 'darwin' && mode === 'unavailable') {
    vecDetails.push('Install Homebrew SQLite: brew install sqlite3');
  }
  if (sqliteVecError) {
    vecDetails.push(`Load error: ${sqliteVecError}`);
  }

  checks.push({
    name: 'sqlite-vec',
    status: sqliteVecAvailable ? 'ok' : 'warn',
    message: vecMessage,
    details: vecDetails,
  });

  db.close();
  return checks;
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

  // SQLite extension checks
  const sqliteChecks = await checkSqliteExtensions();
  checks.push(...sqliteChecks);

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
    // Show details for non-ok checks
    if (check.details && check.status !== 'ok') {
      for (const detail of check.details) {
        lines.push(`      ${detail}`);
      }
    }
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
