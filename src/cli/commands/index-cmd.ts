/**
 * gno index command implementation.
 * Build or update the index end-to-end (update + embed).
 *
 * @module src/cli/commands/indexCmd
 */

import { defaultSyncService, type SyncResult } from "../../ingestion";
import { formatSyncResultLines, initStore } from "./shared";

/**
 * Options for index command.
 */
export interface IndexOptions {
  /** Override config path */
  configPath?: string;
  /** Index name */
  indexName?: string;
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
}

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
    indexName: options.indexName,
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
      const { embed } = await import("./embed");
      const result = await embed({
        configPath: options.configPath,
        indexName: options.indexName,
        collection: options.collection,
        verbose: options.verbose,
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
  function formatDuration(seconds: number): string {
    if (seconds < 60) {
      return `${seconds.toFixed(1)}s`;
    }
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs.toFixed(0)}s`;
  }

  if (!result.success) {
    return `Error: ${result.error}`;
  }

  const { syncResult, embedSkipped } = result;
  const lines: string[] = ["Indexing complete.", ""];

  lines.push(...formatSyncResultLines(syncResult, options));

  if (embedSkipped) {
    lines.push("");
    lines.push("Embedding skipped (--no-embed)");
  } else if (result.embedResult) {
    lines.push("");
    const { embedded, errors, duration } = result.embedResult;
    lines.push(
      `Embedded ${embedded.toLocaleString()} chunks in ${formatDuration(duration)}`
    );
    if (errors > 0) {
      lines.push(`${errors.toLocaleString()} chunks failed to embed.`);
    }
  }

  return lines.join("\n");
}
