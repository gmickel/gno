/**
 * gno vec command implementation.
 * Vector index maintenance commands.
 *
 * @module src/cli/commands/vec
 */

import { getIndexDbPath } from "../../app/constants";
import { getConfigPaths, isInitialized, loadConfig } from "../../config";
import { getActivePreset } from "../../llm/registry";
import { SqliteAdapter } from "../../store/sqlite/adapter";
import {
  createVectorIndexPort,
  createVectorStatsPort,
} from "../../store/vector";
import {
  pruneLegacyVectors,
  rebuildPartitionIndexWithDetails,
  syncPartitionIndexWithDetails,
} from "../../store/vector/partition-index";
import {
  dropVectorPartition,
  storedVectorPartition,
  type VectorPartitionStatus,
} from "../../store/vector/status";
import { loadSqliteVec } from "../../store/vector/variants";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface VecOptions {
  configPath?: string;
  indexName?: string;
  json?: boolean;
}

export type VecSyncResult =
  | {
      success: true;
      added: number;
      removed: number;
      v2Added?: number;
      v2Removed?: number;
      checkRecall?: number | null;
      model: string;
    }
  | { success: false; error: string };

export type VecRebuildResult =
  | {
      success: true;
      count: number;
      v2Count?: number;
      checkRecall?: number | null;
      model: string;
    }
  | { success: false; error: string };

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Infer embedding dimensions from stored vectors for a specific model.
 * Returns dimensions or null if no vectors exist or data is invalid.
 */
function inferDimensions(
  db: import("bun:sqlite").Database,
  model: string
): number | null {
  try {
    const row = db
      .prepare("SELECT embedding FROM content_vectors WHERE model = ? LIMIT 1")
      .get(model) as { embedding: Uint8Array } | undefined;

    if (!row || !row.embedding) {
      return null;
    }

    const byteLength = row.embedding.byteLength;

    // Validate: must be non-empty and aligned to 4 bytes (Float32)
    if (byteLength === 0 || byteLength % 4 !== 0) {
      return null;
    }

    // Float32Array: 4 bytes per dimension
    return byteLength / 4;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sync the vec0 index with stored vectors (add missing, remove orphans): the
 * active vector partition's variants, or legacy `content_vectors` on an
 * index that never activated a partition.
 */
export async function vecSync(
  options: VecOptions = {}
): Promise<VecSyncResult> {
  const initialized = await isInitialized(options.configPath);
  if (!initialized) {
    return { success: false, error: "GNO not initialized. Run: gno init" };
  }

  const configResult = await loadConfig(options.configPath);
  if (!configResult.ok) {
    return { success: false, error: configResult.error.message };
  }
  const config = configResult.value;

  const preset = getActivePreset(config);
  const modelUri = preset.embed;

  const store = new SqliteAdapter();
  const dbPath = getIndexDbPath(options.indexName);
  const paths = getConfigPaths();
  store.setConfigPath(paths.configFile);

  const openResult = await store.open(
    dbPath,
    config.ftsTokenizer,
    config.busyTimeoutMs
  );
  if (!openResult.ok) {
    return { success: false, error: openResult.error.message };
  }

  try {
    const db = store.getRawDb();

    const partition = storedVectorPartition(db, modelUri);
    if (partition) {
      if (!(await loadSqliteVec(db))) {
        return {
          success: false,
          error: "sqlite-vec not available. Cannot sync index.",
        };
      }
      return {
        success: true,
        ...syncPartitionIndexWithDetails(db, partition),
        model: modelUri,
      };
    }

    // Infer dimensions from stored vectors for this model
    const dimensions = inferDimensions(db, modelUri);
    if (dimensions === null) {
      return {
        success: false,
        error: `No embeddings found for model ${modelUri}. Run: gno embed`,
      };
    }

    const vectorResult = await createVectorIndexPort(db, {
      model: modelUri,
      dimensions,
    });
    if (!vectorResult.ok) {
      return { success: false, error: vectorResult.error.message };
    }

    const vectorIndex = vectorResult.value;
    if (!vectorIndex.searchAvailable) {
      return {
        success: false,
        error: "sqlite-vec not available. Cannot sync index.",
      };
    }

    const syncResult = await vectorIndex.syncVecIndex();
    if (!syncResult.ok) {
      return { success: false, error: syncResult.error.message };
    }

    return {
      success: true,
      added: syncResult.value.added,
      removed: syncResult.value.removed,
      model: modelUri,
    };
  } finally {
    await store.close();
  }
}

/**
 * Rebuild the vec0 index (drop + recreate + repopulate) from the active
 * vector partition's variants, or from legacy `content_vectors` on an index
 * that never activated a partition.
 */
export async function vecRebuild(
  options: VecOptions = {}
): Promise<VecRebuildResult> {
  const initialized = await isInitialized(options.configPath);
  if (!initialized) {
    return { success: false, error: "GNO not initialized. Run: gno init" };
  }

  const configResult = await loadConfig(options.configPath);
  if (!configResult.ok) {
    return { success: false, error: configResult.error.message };
  }
  const config = configResult.value;

  const preset = getActivePreset(config);
  const modelUri = preset.embed;

  const store = new SqliteAdapter();
  const dbPath = getIndexDbPath(options.indexName);
  const paths = getConfigPaths();
  store.setConfigPath(paths.configFile);

  const openResult = await store.open(
    dbPath,
    config.ftsTokenizer,
    config.busyTimeoutMs
  );
  if (!openResult.ok) {
    return { success: false, error: openResult.error.message };
  }

  try {
    const db = store.getRawDb();

    const partition = storedVectorPartition(db, modelUri);
    if (partition) {
      if (!(await loadSqliteVec(db))) {
        return {
          success: false,
          error: "sqlite-vec not available. Cannot rebuild index.",
        };
      }
      const rebuilt = rebuildPartitionIndexWithDetails(db, partition);
      return {
        success: true,
        count: rebuilt.count,
        ...(rebuilt.v2Count !== undefined ? { v2Count: rebuilt.v2Count } : {}),
        ...(rebuilt.checkRecall !== undefined
          ? { checkRecall: rebuilt.checkRecall }
          : {}),
        model: modelUri,
      };
    }

    // Infer dimensions from stored vectors for this model
    const dimensions = inferDimensions(db, modelUri);
    if (dimensions === null) {
      return {
        success: false,
        error: `No embeddings found for model ${modelUri}. Run: gno embed`,
      };
    }

    // Get vector count before rebuild for reporting
    const stats = createVectorStatsPort(db);
    const countResult = await stats.countVectors(modelUri);
    const count = countResult.ok ? countResult.value : 0;

    const vectorResult = await createVectorIndexPort(db, {
      model: modelUri,
      dimensions,
    });
    if (!vectorResult.ok) {
      return { success: false, error: vectorResult.error.message };
    }

    const vectorIndex = vectorResult.value;
    if (!vectorIndex.searchAvailable) {
      return {
        success: false,
        error: "sqlite-vec not available. Cannot rebuild index.",
      };
    }

    const rebuildResult = await vectorIndex.rebuildVecIndex();
    if (!rebuildResult.ok) {
      return { success: false, error: rebuildResult.error.message };
    }

    return {
      success: true,
      count,
      model: modelUri,
    };
  } finally {
    await store.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Format
// ─────────────────────────────────────────────────────────────────────────────

export function formatVecSync(
  result: VecSyncResult,
  options: VecOptions
): string {
  if (!result.success) {
    return options.json
      ? JSON.stringify({ error: { code: "RUNTIME", message: result.error } })
      : `Error: ${result.error}`;
  }

  if (options.json) {
    return JSON.stringify(
      {
        added: result.added,
        removed: result.removed,
        ...(result.v2Added !== undefined ? { v2Added: result.v2Added } : {}),
        ...(result.v2Removed !== undefined
          ? { v2Removed: result.v2Removed }
          : {}),
        ...(result.checkRecall !== undefined
          ? { checkRecall: result.checkRecall }
          : {}),
        model: result.model,
      },
      null,
      2
    );
  }

  const v2Changed = (result.v2Added ?? 0) > 0 || (result.v2Removed ?? 0) > 0;
  if (result.added === 0 && result.removed === 0 && !v2Changed) {
    return "Vec index already in sync.";
  }

  const parts: string[] = [];
  if (result.added > 0) {
    parts.push(`+${result.added} added`);
  }
  if (result.removed > 0) {
    parts.push(`-${result.removed} removed`);
  }
  if (v2Changed) {
    const v2Parts: string[] = [];
    if ((result.v2Added ?? 0) > 0) v2Parts.push(`+${result.v2Added}`);
    if ((result.v2Removed ?? 0) > 0) v2Parts.push(`-${result.v2Removed}`);
    parts.push(`coarse mirror ${v2Parts.join("/")}`);
  }
  if (result.checkRecall !== undefined && result.checkRecall !== null) {
    parts.push(`recall@10=${(result.checkRecall * 100).toFixed(1)}%`);
  }
  return `Vec index synced: ${parts.join(", ")}`;
}

export function formatVecRebuild(
  result: VecRebuildResult,
  options: VecOptions
): string {
  if (!result.success) {
    return options.json
      ? JSON.stringify({ error: { code: "RUNTIME", message: result.error } })
      : `Error: ${result.error}`;
  }

  if (options.json) {
    return JSON.stringify(
      {
        count: result.count,
        ...(result.v2Count !== undefined ? { v2Count: result.v2Count } : {}),
        ...(result.checkRecall !== undefined
          ? { checkRecall: result.checkRecall }
          : {}),
        model: result.model,
      },
      null,
      2
    );
  }

  const extras: string[] = [];
  if (result.v2Count !== undefined) {
    extras.push(`coarse mirror ${result.v2Count.toLocaleString()} rows`);
  }
  if (result.checkRecall !== undefined && result.checkRecall !== null) {
    extras.push(`recall@10=${(result.checkRecall * 100).toFixed(1)}%`);
  }
  const suffix = extras.length > 0 ? ` (${extras.join(", ")})` : "";
  return `Vec index rebuilt: ${result.count.toLocaleString()} vectors${suffix}`;
}

export type VecDropResult =
  | { success: true; partition: VectorPartitionStatus }
  | { success: false; error: string };

/**
 * Drop an abandoned vector partition (shadow or legacy). Active partitions
 * that retrieval uses are refused.
 */
export async function vecDrop(
  partition: string,
  options: VecOptions = {}
): Promise<VecDropResult> {
  if (!(await isInitialized(options.configPath)))
    return { success: false, error: "GNO not initialized. Run: gno init" };
  const configResult = await loadConfig(options.configPath);
  if (!configResult.ok)
    return { success: false, error: configResult.error.message };
  const store = new SqliteAdapter();
  const openResult = await store.open(
    getIndexDbPath(options.indexName),
    configResult.value.ftsTokenizer,
    configResult.value.busyTimeoutMs
  );
  if (!openResult.ok)
    return { success: false, error: openResult.error.message };
  try {
    const dropped = await dropVectorPartition(store.getRawDb(), partition);
    return dropped.ok
      ? { success: true, partition: dropped.partition }
      : { success: false, error: dropped.error };
  } finally {
    await store.close();
  }
}

export function formatVecDrop(
  result: VecDropResult,
  options: { json?: boolean }
): string {
  if (!result.success) {
    return options.json
      ? JSON.stringify({ error: { code: "RUNTIME", message: result.error } })
      : `Error: ${result.error}`;
  }
  const { partition } = result;
  return options.json
    ? JSON.stringify({ dropped: partition }, null, 2)
    : `Dropped ${partition.state} partition ${partition.id.slice(0, 12)} (${partition.provenance}, ${partition.owners} chunks)`;
}

export interface VecPruneOptions extends VecOptions {
  /** Run SQLite VACUUM after pruning to reclaim disk space in-place. */
  vacuum?: boolean;
}

export type VecPruneResult =
  | {
      success: true;
      droppedTables: string[];
      removedRows: number;
      vacuumed: boolean;
    }
  | { success: false; error: string };

/**
 * Drop superseded legacy `vec_<hash>` tables and delete legacy `content_vectors`
 * rows for models that already have an activated v1 partition, plus any
 * orphaned `vec_v1_*` tables absent from `vector_partitions`.
 */
export async function vecPrune(
  options: VecPruneOptions = {}
): Promise<VecPruneResult> {
  if (!(await isInitialized(options.configPath))) {
    return { success: false, error: "GNO not initialized. Run: gno init" };
  }
  const configResult = await loadConfig(options.configPath);
  if (!configResult.ok) {
    return { success: false, error: configResult.error.message };
  }
  const config = configResult.value;

  const store = new SqliteAdapter();
  const dbPath = getIndexDbPath(options.indexName);
  const paths = getConfigPaths();
  store.setConfigPath(paths.configFile);

  const openResult = await store.open(
    dbPath,
    config.ftsTokenizer,
    config.busyTimeoutMs
  );
  if (!openResult.ok) {
    return { success: false, error: openResult.error.message };
  }

  try {
    const db = store.getRawDb();
    const pruned = await pruneLegacyVectors(db);
    if (!pruned.ok) {
      return { success: false, error: pruned.error };
    }
    if (options.vacuum) {
      try {
        db.exec("VACUUM");
      } catch (vacuumCause) {
        const vacuumMsg =
          vacuumCause instanceof Error
            ? vacuumCause.message
            : String(vacuumCause);
        return {
          success: false,
          error: `Pruned ${pruned.droppedTables.length} legacy table(s) and ${pruned.removedRows.toLocaleString()} legacy row(s), but VACUUM failed: ${vacuumMsg}. The prune already committed; reclaim disk space with VACUUM INTO or retry gno vec prune --vacuum.`,
        };
      }
    }
    return {
      success: true,
      droppedTables: pruned.droppedTables,
      removedRows: pruned.removedRows,
      vacuumed: Boolean(options.vacuum),
    };
  } catch (cause) {
    return {
      success: false,
      error:
        cause instanceof Error
          ? cause.message
          : "Failed to prune legacy vector tables",
    };
  } finally {
    await store.close();
  }
}

export function formatVecPrune(
  result: VecPruneResult,
  options: { json?: boolean }
): string {
  if (!result.success) {
    return options.json
      ? JSON.stringify({ error: { code: "RUNTIME", message: result.error } })
      : `Error: ${result.error}`;
  }
  if (options.json) {
    return JSON.stringify(
      {
        droppedTables: result.droppedTables,
        removedRows: result.removedRows,
        vacuumed: result.vacuumed,
      },
      null,
      2
    );
  }
  if (result.droppedTables.length === 0 && result.removedRows === 0) {
    return result.vacuumed
      ? "No legacy vector tables or rows to prune. Database vacuumed."
      : "No legacy vector tables or rows to prune.";
  }
  const lines = [
    `Pruned ${result.droppedTables.length} legacy table(s) and ${result.removedRows.toLocaleString()} legacy row(s)${result.vacuumed ? "; database vacuumed." : "."}`,
  ];
  if (result.droppedTables.length > 0) {
    lines.push(`Dropped tables: ${result.droppedTables.join(", ")}`);
  }
  if (!result.vacuumed) {
    lines.push(
      "Disk space is reclaimed only after vacuuming (for large indexes, run SQLite VACUUM INTO a new file and swap it in, or rerun with --vacuum)."
    );
  }
  return lines.join("\n");
}
