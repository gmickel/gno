/**
 * gno models pull command implementation.
 * Download models to local cache.
 *
 * @module src/cli/commands/models/pull
 */

import { getModelsCachePath } from '../../../app/constants';
import { loadConfig } from '../../../config';
import { ModelCache } from '../../../llm/cache';
import { getActivePreset } from '../../../llm/registry';
import type { DownloadProgress, ModelType } from '../../../llm/types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ModelsPullOptions = {
  /** Override config path */
  configPath?: string;
  /** Pull all models */
  all?: boolean;
  /** Pull embedding model */
  embed?: boolean;
  /** Pull reranker model */
  rerank?: boolean;
  /** Pull generation model */
  gen?: boolean;
  /** Force re-download */
  force?: boolean;
  /** Quiet mode (no progress) */
  quiet?: boolean;
  /** Progress callback for UI */
  onProgress?: (type: ModelType, progress: DownloadProgress) => void;
};

export type ModelPullResult = {
  type: ModelType;
  uri: string;
  ok: boolean;
  error?: string;
  path?: string;
  skipped?: boolean;
};

export type ModelsPullResult = {
  results: ModelPullResult[];
  failed: number;
  skipped: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine which model types to pull based on options.
 */
function getTypesToPull(options: ModelsPullOptions): ModelType[] {
  if (options.all) {
    return ['embed', 'rerank', 'gen'];
  }
  if (options.embed || options.rerank || options.gen) {
    const types: ModelType[] = [];
    if (options.embed) {
      types.push('embed');
    }
    if (options.rerank) {
      types.push('rerank');
    }
    if (options.gen) {
      types.push('gen');
    }
    return types;
  }
  // Default: pull all
  return ['embed', 'rerank', 'gen'];
}

/**
 * Execute gno models pull command.
 */
export async function modelsPull(
  options: ModelsPullOptions = {}
): Promise<ModelsPullResult> {
  // Load config (use defaults if not initialized)
  const { createDefaultConfig } = await import('../../../config');
  const configResult = await loadConfig(options.configPath);
  const config = configResult.ok ? configResult.value : createDefaultConfig();

  const preset = getActivePreset(config);
  const cache = new ModelCache(getModelsCachePath());
  const types = getTypesToPull(options);

  const results: ModelPullResult[] = [];
  let failed = 0;
  let skipped = 0;

  for (const type of types) {
    const uri = preset[type];

    // Check if already cached (skip unless --force)
    if (!options.force) {
      const isCached = await cache.isCached(uri);
      if (isCached) {
        const path = await cache.getCachedPath(uri);
        results.push({
          type,
          uri,
          ok: true,
          path: path ?? undefined,
          skipped: true,
        });
        skipped += 1;
        continue;
      }
    }

    // Download the model
    const result = await cache.download(uri, type, (progress) => {
      if (!options.quiet && options.onProgress) {
        options.onProgress(type, progress);
      }
    });

    if (result.ok) {
      results.push({
        type,
        uri,
        ok: true,
        path: result.value,
      });
    } else {
      results.push({
        type,
        uri,
        ok: false,
        error: result.error.message,
      });
      failed += 1;
    }
  }

  return { results, failed, skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format models pull result for output.
 */
export function formatModelsPull(result: ModelsPullResult): string {
  const lines: string[] = [];

  for (const r of result.results) {
    if (r.ok) {
      if (r.skipped) {
        lines.push(`${r.type}: skipped (already cached)`);
      } else {
        lines.push(`${r.type}: downloaded`);
      }
    } else {
      lines.push(`${r.type}: failed - ${r.error}`);
    }
  }

  if (result.failed > 0) {
    lines.push('');
    lines.push(`${result.failed} model(s) failed to download.`);
  } else if (result.skipped === result.results.length) {
    lines.push('');
    lines.push('All models already cached. Use --force to re-download.');
  } else {
    lines.push('');
    lines.push('All models downloaded successfully.');
  }

  return lines.join('\n');
}

/**
 * Create a terminal progress renderer.
 */
export function createProgressRenderer(): (
  type: ModelType,
  progress: DownloadProgress
) => void {
  return (type, progress) => {
    const percent = progress.percent.toFixed(1);
    const downloaded = (progress.downloadedBytes / 1024 / 1024).toFixed(1);
    const total = (progress.totalBytes / 1024 / 1024).toFixed(1);
    process.stderr.write(
      `\r${type}: ${percent}% (${downloaded}/${total} MB)    `
    );
  };
}
