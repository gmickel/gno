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

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface VecOptions {
  configPath?: string;
  indexName?: string;
  json?: boolean;
}

export type VecSyncResult =
  | { success: true; added: number; removed: number; model: string }
  | { success: false; error: string };

export type VecRebuildResult =
  | { success: true; count: number; model: string }
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
 * Sync vec0 index with content_vectors (add missing, remove orphans).
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
 * Rebuild vec0 index from content_vectors (drop + recreate + repopulate).
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
        model: result.model,
      },
      null,
      2
    );
  }

  if (result.added === 0 && result.removed === 0) {
    return "Vec index already in sync.";
  }

  const parts: string[] = [];
  if (result.added > 0) {
    parts.push(`+${result.added} added`);
  }
  if (result.removed > 0) {
    parts.push(`-${result.removed} removed`);
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
        model: result.model,
      },
      null,
      2
    );
  }

  return `Vec index rebuilt: ${result.count.toLocaleString()} vectors`;
}
