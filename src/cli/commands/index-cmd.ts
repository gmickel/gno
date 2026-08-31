/**
 * gno index command implementation.
 * Build or update the index end-to-end (update + embed).
 *
 * @module src/cli/commands/indexCmd
 */

import {
  type CliWriteLeaseOptions,
  type WriteLeaseContention,
  withCliWriteLease,
} from "../../core/write-lease";
import {
  defaultSyncService,
  type SyncResult,
  withContentTypeRules,
} from "../../ingestion";
import { formatSyncResultLines, initStore } from "./shared";

/**
 * Options for index command.
 */
export interface IndexOptions extends CliWriteLeaseOptions {
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
  /** Emit the complete structured index receipt. */
  json?: boolean;
}

/**
 * Result of index command.
 */
export type IndexResult =
  | {
      success: true;
      syncResult: SyncResult;
      embedSkipped: boolean;
      embedResult?: {
        embedded: number;
        errors: number;
        contentionErrors: number;
        duration: number;
      };
    }
  | { success: false; error: string; contention?: WriteLeaseContention };

/**
 * Execute gno index command.
 */
export async function index(options: IndexOptions = {}): Promise<IndexResult> {
  return await withCliWriteLease(options, async () => {
    const initResult = await initStore({
      configPath: options.configPath,
      indexName: options.indexName,
      collection: options.collection,
    });
    if (!initResult.ok) {
      return { success: false, error: initResult.error };
    }

    const { store, collections, config } = initResult;

    try {
      // Run sync service (update phase)
      const syncResult = await defaultSyncService.syncAll(
        collections,
        store,
        withContentTypeRules(
          {
            gitPull: options.gitPull,
            runUpdateCmd: true,
          },
          config
        )
      );

      // Embedding phase
      const embedSkipped = options.noEmbed ?? false;
      let embedResult:
        | {
            embedded: number;
            errors: number;
            contentionErrors: number;
            duration: number;
          }
        | undefined;

      if (!embedSkipped) {
        const { embed } = await import("./embed");
        const result = await embed({
          configPath: options.configPath,
          indexName: options.indexName,
          collection: options.collection,
          verbose: options.verbose,
          skipWriteLease: true,
        });
        if (result.success) {
          embedResult = {
            embedded: result.embedded,
            errors: result.errors,
            contentionErrors: result.contentionErrors,
            duration: result.duration,
          };
        }
      }

      return { success: true, syncResult, embedSkipped, embedResult };
    } finally {
      await store.close();
    }
  });
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

  if (options.json) {
    return JSON.stringify(
      {
        syncResult: result.syncResult,
        embedSkipped: result.embedSkipped,
        ...(result.embedResult ? { embedResult: result.embedResult } : {}),
      },
      null,
      2
    );
  }
  const { syncResult, embedSkipped } = result;
  const lines: string[] = ["Indexing complete.", ""];

  lines.push(...formatSyncResultLines(syncResult, options));

  if (embedSkipped) {
    lines.push("");
    lines.push("Embedding skipped (--no-embed)");
  } else if (result.embedResult) {
    lines.push("");
    const { embedded, errors, contentionErrors, duration } = result.embedResult;
    lines.push(
      `Embedded ${embedded.toLocaleString()} chunks in ${formatDuration(duration)}`
    );
    if (errors > 0) {
      lines.push(`${errors.toLocaleString()} chunks failed to embed.`);
    }
    if (contentionErrors > 0) {
      lines.push(
        `${contentionErrors.toLocaleString()} chunks deferred by index contention (SQLITE_BUSY) — not embedding failures. Rerun \`gno embed\` when the other writer finishes.`
      );
    }
  }

  return lines.join("\n");
}
