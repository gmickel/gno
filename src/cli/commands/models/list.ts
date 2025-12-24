/**
 * gno models list command implementation.
 * List configured and available models.
 *
 * @module src/cli/commands/models/list
 */

import { getModelsCachePath } from '../../../app/constants';
import { loadConfig } from '../../../config';
import { ModelCache } from '../../../llm/cache';
import { getActivePreset } from '../../../llm/registry';
import type { ModelStatus } from '../../../llm/types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ModelsListOptions = {
  /** Override config path */
  configPath?: string;
  /** Output as JSON */
  json?: boolean;
  /** Output as Markdown */
  md?: boolean;
};

export type ModelsListResult = {
  embed: ModelStatus;
  rerank: ModelStatus;
  gen: ModelStatus;
  cacheDir: string;
  totalSize: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

async function getModelStatus(
  cache: ModelCache,
  uri: string
): Promise<ModelStatus> {
  const cached = await cache.getCachedPath(uri);
  if (cached) {
    const entries = await cache.list();
    const entry = entries.find((e) => e.uri === uri);
    return {
      uri,
      cached: true,
      path: cached,
      size: entry?.size,
    };
  }
  return {
    uri,
    cached: false,
    path: null,
  };
}

/**
 * Execute gno models list command.
 */
export async function modelsList(
  options: ModelsListOptions = {}
): Promise<ModelsListResult> {
  // Load config (use defaults if not initialized)
  const { createDefaultConfig } = await import('../../../config');
  const configResult = await loadConfig(options.configPath);
  const config = configResult.ok ? configResult.value : createDefaultConfig();

  const preset = getActivePreset(config);
  const cache = new ModelCache(getModelsCachePath());

  const [embed, rerank, gen] = await Promise.all([
    getModelStatus(cache, preset.embed),
    getModelStatus(cache, preset.rerank),
    getModelStatus(cache, preset.gen),
  ]);

  return {
    embed,
    rerank,
    gen,
    cacheDir: cache.dir,
    totalSize: await cache.totalSize(),
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
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(k)),
    sizes.length - 1
  );
  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
}

function formatTerminal(result: ModelsListResult): string {
  const lines: string[] = [];

  lines.push('Models:');

  const statusIcon = (s: ModelStatus) => (s.cached ? '✓' : '✗');

  lines.push(
    `  embed:  ${statusIcon(result.embed)} ${result.embed.uri}` +
      (result.embed.size ? ` (${formatBytes(result.embed.size)})` : '')
  );
  lines.push(
    `  rerank: ${statusIcon(result.rerank)} ${result.rerank.uri}` +
      (result.rerank.size ? ` (${formatBytes(result.rerank.size)})` : '')
  );
  lines.push(
    `  gen:    ${statusIcon(result.gen)} ${result.gen.uri}` +
      (result.gen.size ? ` (${formatBytes(result.gen.size)})` : '')
  );

  lines.push('');
  lines.push(`Cache: ${result.cacheDir}`);
  lines.push(`Total size: ${formatBytes(result.totalSize)}`);

  const allCached =
    result.embed.cached && result.rerank.cached && result.gen.cached;
  if (!allCached) {
    lines.push('');
    lines.push('Run: gno models pull --all');
  }

  return lines.join('\n');
}

function formatMarkdown(result: ModelsListResult): string {
  const lines: string[] = [];

  lines.push('# Models');
  lines.push('');
  lines.push('| Type | URI | Cached | Size |');
  lines.push('|------|-----|--------|------|');

  const status = (s: ModelStatus) => (s.cached ? '✓' : '✗');
  const size = (s: ModelStatus) => (s.size ? formatBytes(s.size) : '-');

  lines.push(
    `| embed | ${result.embed.uri} | ${status(result.embed)} | ${size(result.embed)} |`
  );
  lines.push(
    `| rerank | ${result.rerank.uri} | ${status(result.rerank)} | ${size(result.rerank)} |`
  );
  lines.push(
    `| gen | ${result.gen.uri} | ${status(result.gen)} | ${size(result.gen)} |`
  );

  lines.push('');
  lines.push(`**Cache**: ${result.cacheDir}`);
  lines.push(`**Total size**: ${formatBytes(result.totalSize)}`);

  return lines.join('\n');
}

/**
 * Format models list result for output.
 */
export function formatModelsList(
  result: ModelsListResult,
  options: ModelsListOptions
): string {
  if (options.json) {
    return JSON.stringify(result, null, 2);
  }

  if (options.md) {
    return formatMarkdown(result);
  }

  return formatTerminal(result);
}
