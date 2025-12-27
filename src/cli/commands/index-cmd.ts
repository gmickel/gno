/**
 * gno index command implementation.
 * Build or update the index end-to-end (update + embed).
 *
 * @module src/cli/commands/indexCmd
 */

import { defaultSyncService, type SyncResult } from '../../ingestion';
import { formatSyncResultLines, initStore } from './shared';

/**
 * Options for index command.
 */
export type IndexOptions = {
  /** Override config path */
  configPath?: string;
  /** Scope to single collection */
  collection?: string;
  /** Run ingestion only, skip embedding */
  noEmbed?: boolean;
  /** Download models if missing */
  modelsPull?: boolean;
  /** Run git pull in git repositories */
  gitPull?: boolean;
  /** Accept defaults, no prompts */
  yes?: boolean;
  /** Verbose output */
  verbose?: boolean;
};

/**
 * Result of index command.
 */
export type IndexResult =
  | {
      success: true;
      syncResult: SyncResult;
      embedSkipped: boolean;
      embedResult?: { embedded: number; errors: number; duration: number };
    }
  | { success: false; error: string };

/**
 * Execute gno index command.
 */
export async function index(options: IndexOptions = {}): Promise<IndexResult> {
  const initResult = await initStore({
    configPath: options.configPath,
    collection: options.collection,
  });
  if (!initResult.ok) {
    return { success: false, error: initResult.error };
  }

  const { store, collections } = initResult;

  try {
    // Run sync service (update phase)
    const syncResult = await defaultSyncService.syncAll(collections, store, {
      gitPull: options.gitPull,
      runUpdateCmd: true,
    });

    // Embedding phase
    const embedSkipped = options.noEmbed ?? false;
    let embedResult:
      | { embedded: number; errors: number; duration: number }
      | undefined;

    if (!embedSkipped) {
      const { embed } = await import('./embed');
      const result = await embed({
        configPath: options.configPath,
      });
      if (result.success) {
        embedResult = {
          embedded: result.embedded,
          errors: result.errors,
          duration: result.duration,
        };
      }
    }

    return { success: true, syncResult, embedSkipped, embedResult };
  } finally {
    await store.close();
  }
}

/**
 * Format index result for output.
 */
export function formatIndex(
  result: IndexResult,
  options: IndexOptions
): string {
  if (!result.success) {
    return `Error: ${result.error}`;
  }

  const { syncResult, embedSkipped } = result;
  const lines: string[] = ['Indexing complete.', ''];

  lines.push(...formatSyncResultLines(syncResult, options));

  if (embedSkipped) {
    lines.push('');
    lines.push('Embedding skipped (--no-embed)');
  } else if (result.embedResult) {
    lines.push('');
    const { embedded, errors, duration } = result.embedResult;
    const errPart = errors > 0 ? ` (${errors} errors)` : '';
    lines.push(
      `Embedded ${embedded} chunks in ${(duration / 1000).toFixed(1)}s${errPart}`
    );
  }

  return lines.join('\n');
}
