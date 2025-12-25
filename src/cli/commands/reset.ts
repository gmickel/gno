/**
 * gno reset - Reset GNO to fresh state
 *
 * Deletes all config, data, and cache directories.
 */

import { rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, normalize, sep } from 'node:path';
import { resolveDirs } from '../../app/constants';
import { CliError } from '../errors';

type ResetOptions = {
  confirm?: boolean;
  keepConfig?: boolean;
  keepCache?: boolean;
};

type DirResult = {
  path: string;
  status: 'deleted' | 'missing' | 'kept';
  error?: string;
};

type ResetResult = {
  results: DirResult[];
  errors: string[];
};

// Forbidden paths that should never be deleted
const FORBIDDEN_PATHS = new Set([
  '/',
  '/Users',
  '/home',
  '/var',
  '/etc',
  '/tmp',
]);

/**
 * Validate a path is safe to delete.
 * Must be absolute, under home directory, and not a system path.
 */
function assertSafePath(path: string, label: string): void {
  const normalized = normalize(path);

  // Must be absolute
  if (!isAbsolute(normalized)) {
    throw new CliError('VALIDATION', `${label} path must be absolute: ${path}`);
  }

  // Must not be a forbidden system path
  if (
    FORBIDDEN_PATHS.has(normalized) ||
    FORBIDDEN_PATHS.has(`${normalized}${sep}`)
  ) {
    throw new CliError('VALIDATION', `Refusing to delete system path: ${path}`);
  }

  // Must be under home directory (for user safety)
  const home = homedir();
  if (!normalized.startsWith(home + sep) && normalized !== home) {
    throw new CliError(
      'VALIDATION',
      `${label} path must be under home directory: ${path}`
    );
  }

  // Must not be home directory itself
  if (normalized === home || normalized === home + sep) {
    throw new CliError(
      'VALIDATION',
      `Refusing to delete home directory: ${path}`
    );
  }
}

/**
 * Reset GNO by deleting directories.
 */
export async function reset(options: ResetOptions): Promise<ResetResult> {
  if (!options.confirm) {
    throw new CliError(
      'VALIDATION',
      'Reset requires --confirm flag to prevent accidental data loss'
    );
  }

  const dirs = resolveDirs();
  const results: DirResult[] = [];
  const errors: string[] = [];

  // Validate all paths before deleting anything
  assertSafePath(dirs.data, 'Data');
  if (!options.keepConfig) {
    assertSafePath(dirs.config, 'Config');
  }
  if (!options.keepCache) {
    assertSafePath(dirs.cache, 'Cache');
  }

  // Delete data directory (always, contains index DB)
  results.push(await rmDir(dirs.data));

  // Delete config unless --keep-config
  if (options.keepConfig) {
    results.push({ path: dirs.config, status: 'kept' });
  } else {
    results.push(await rmDir(dirs.config));
  }

  // Delete cache unless --keep-cache
  if (options.keepCache) {
    results.push({ path: dirs.cache, status: 'kept' });
  } else {
    results.push(await rmDir(dirs.cache));
  }

  // Collect errors
  for (const r of results) {
    if (r.error) {
      errors.push(`${r.path}: ${r.error}`);
    }
  }

  if (errors.length > 0) {
    throw new CliError('RUNTIME', `Reset failed:\n${errors.join('\n')}`);
  }

  return { results, errors };
}

async function rmDir(path: string): Promise<DirResult> {
  try {
    // Check if exists first
    await stat(path);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return { path, status: 'missing' };
    }
    return { path, status: 'missing', error: err.message };
  }

  try {
    await rm(path, { recursive: true, force: true });
    return { path, status: 'deleted' };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return { path, status: 'missing', error: err.message };
  }
}

/**
 * Format reset result for terminal output.
 */
export function formatReset(result: ResetResult): string {
  const deleted = result.results.filter((r) => r.status === 'deleted');
  const missing = result.results.filter((r) => r.status === 'missing');
  const kept = result.results.filter((r) => r.status === 'kept');

  const lines: string[] = ['GNO reset complete.', ''];

  if (deleted.length > 0) {
    lines.push('Deleted:');
    for (const r of deleted) {
      lines.push(`  ${r.path}`);
    }
  }

  if (missing.length > 0) {
    lines.push('');
    lines.push('Already missing:');
    for (const r of missing) {
      lines.push(`  ${r.path}`);
    }
  }

  if (kept.length > 0) {
    lines.push('');
    lines.push('Kept:');
    for (const r of kept) {
      lines.push(`  ${r.path}`);
    }
  }

  return lines.join('\n');
}
