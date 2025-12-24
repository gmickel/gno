/**
 * gno models clear command implementation.
 * Remove cached models.
 *
 * @module src/cli/commands/models/clear
 */

import { getModelsCachePath } from '../../../app/constants';
import { ModelCache } from '../../../llm/cache';
import type { ModelType } from '../../../llm/types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ModelsClearOptions = {
  /** Clear all models */
  all?: boolean;
  /** Clear embedding model */
  embed?: boolean;
  /** Clear reranker model */
  rerank?: boolean;
  /** Clear generation model */
  gen?: boolean;
  /** Skip confirmation */
  yes?: boolean;
};

export type ModelsClearResult = {
  cleared: ModelType[];
  sizeBefore: number;
  sizeAfter: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute gno models clear command.
 */
export async function modelsClear(
  options: ModelsClearOptions = {}
): Promise<ModelsClearResult> {
  const cache = new ModelCache(getModelsCachePath());

  // Determine which models to clear
  let types: ModelType[] | undefined;

  if (options.all) {
    types = undefined; // Clear all
  } else if (options.embed || options.rerank || options.gen) {
    types = [];
    if (options.embed) {
      types.push('embed');
    }
    if (options.rerank) {
      types.push('rerank');
    }
    if (options.gen) {
      types.push('gen');
    }
  } else {
    // Default: clear all
    types = undefined;
  }

  const sizeBefore = await cache.totalSize();
  await cache.clear(types);
  const sizeAfter = await cache.totalSize();

  return {
    cleared: types ?? ['embed', 'rerank', 'gen'],
    sizeBefore,
    sizeAfter,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return '0 B';
  }
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
}

/**
 * Format models clear result for output.
 */
export function formatModelsClear(result: ModelsClearResult): string {
  const lines: string[] = [];

  lines.push(`Cleared: ${result.cleared.join(', ')}`);
  lines.push(`Freed: ${formatBytes(result.sizeBefore - result.sizeAfter)}`);

  return lines.join('\n');
}
