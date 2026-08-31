/**
 * gno update command implementation.
 * Sync files from disk into the index (ingestion without embedding).
 *
 * @module src/cli/commands/update
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
 * Options for update command.
 */
export interface UpdateOptions extends CliWriteLeaseOptions {
  /** Override config path */
  configPath?: string;
  /** Index name */
  indexName?: string;
  /** Run git pull in git repositories before scanning */
  gitPull?: boolean;
  /** Verbose output */
  verbose?: boolean;
  /** Emit the complete structured sync receipt. */
  json?: boolean;
}

/**
 * Result of update command.
 */
export type UpdateResult =
  | { success: true; result: SyncResult }
  | { success: false; error: string; contention?: WriteLeaseContention };

/**
 * Execute gno update command.
 */
export async function update(
  options: UpdateOptions = {}
): Promise<UpdateResult> {
  return await withCliWriteLease(options, async () => {
    const initResult = await initStore({
      configPath: options.configPath,
      indexName: options.indexName,
    });
    if (!initResult.ok) {
      return { success: false, error: initResult.error };
    }

    const { store, collections, config } = initResult;

    try {
      // Run sync service
      const result = await defaultSyncService.syncAll(
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

      return { success: true, result };
    } finally {
      await store.close();
    }
  });
}

/**
 * Format update result for output.
 */
export function formatUpdate(
  result: UpdateResult,
  options: UpdateOptions
): string {
  if (!result.success) {
    return `Error: ${result.error}`;
  }

  if (options.json) {
    return JSON.stringify(result.result, null, 2);
  }
  return formatSyncResultLines(result.result, options).join("\n");
}
