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
  | { success: true; syncResult: SyncResult; embedSkipped: boolean }
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

    // Embedding phase (EPIC 7 - stub for now)
    // TODO: EPIC 7 - Run embedding when implemented
    // For now, embedding is always skipped
    const embedSkipped = options.noEmbed ?? true;

    return { success: true, syncResult, embedSkipped };
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
    lines.push('Embedding skipped (--no-embed or not yet implemented)');
  }

  return lines.join('\n');
}
