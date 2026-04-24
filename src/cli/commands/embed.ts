/**
 * gno embed command implementation.
 * Batch embed chunks into vector storage.
 *
 * @module src/cli/commands/embed
 */

import type { Database } from "bun:sqlite";

import type { EmbeddingPort } from "../../llm/types";
import type { StoreResult } from "../../store/types";

import { getIndexDbPath } from "../../app/constants";
import {
  type Config,
  getConfigPaths,
  isInitialized,
  loadConfig,
} from "../../config";
import { embedTextsWithRecovery } from "../../embed/batch";
import { LlmAdapter } from "../../llm/nodeLlamaCpp/adapter";
import { resolveDownloadPolicy } from "../../llm/policy";
import { resolveModelUri } from "../../llm/registry";
import { formatDocForEmbedding } from "../../pipeline/contextual";
import { SqliteAdapter } from "../../store/sqlite/adapter";
import { err, ok } from "../../store/types";
import {
  type BacklogItem,
  createVectorIndexPort,
  createVectorStatsPort,
  type VectorIndexPort,
  type VectorRow,
  type VectorStatsPort,
} from "../../store/vector";
import { getGlobals } from "../program";
import {
  createProgressRenderer,
  createThrottledProgressRenderer,
} from "../progress";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EmbedOptions {
  /** Override config path */
  configPath?: string;
  /** Index name */
  indexName?: string;
  /** Restrict embedding work to a single collection */
  collection?: string;
  /** Override model URI */
  model?: string;
  /** Batch size for embedding */
  batchSize?: number;
  /** Re-embed all chunks (not just backlog) */
  force?: boolean;
  /** Show what would be done without embedding */
  dryRun?: boolean;
  /** Skip confirmation prompts */
  yes?: boolean;
  /** Output as JSON */
  json?: boolean;
  /** Verbose error logging */
  verbose?: boolean;
}

export type EmbedResult =
  | {
      success: true;
      embedded: number;
      errors: number;
      duration: number;
      model: string;
      searchAvailable: boolean;
      errorSamples?: string[];
      suggestion?: string;
      syncError?: string;
    }
  | { success: false; error: string };

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs.toFixed(0)}s`;
}

function formatLlmFailure(
  error: { message: string; cause?: unknown } | undefined
): string {
  if (!error) {
    return "Unknown embedding failure";
  }
  const cause =
    error.cause &&
    typeof error.cause === "object" &&
    "message" in error.cause &&
    typeof error.cause.message === "string"
      ? error.cause.message
      : typeof error.cause === "string"
        ? error.cause
        : "";
  return cause && cause !== error.message
    ? `${error.message} - ${cause}`
    : error.message;
}

function isDisposedBatchError(message: string): boolean {
  return message.toLowerCase().includes("object is disposed");
}

async function checkVecAvailable(
  db: import("bun:sqlite").Database
): Promise<boolean> {
  try {
    const sqliteVec = await import("sqlite-vec");
    sqliteVec.load(db);
    return true;
  } catch {
    return false;
  }
}

interface BatchContext {
  db: import("bun:sqlite").Database;
  stats: VectorStatsPort;
  embedPort: EmbeddingPort;
  vectorIndex: VectorIndexPort;
  modelUri: string;
  collection?: string;
  batchSize: number;
  force: boolean;
  showProgress: boolean;
  totalToEmbed: number;
  verbose: boolean;
  recreateEmbedPort?: () => Promise<
    { ok: true; value: EmbeddingPort } | { ok: false; error: string }
  >;
}

type BatchResult =
  | {
      ok: true;
      embedded: number;
      errors: number;
      duration: number;
      errorSamples: string[];
      suggestion?: string;
    }
  | { ok: false; error: string };

interface Cursor {
  mirrorHash: string;
  seq: number;
}

async function processBatches(ctx: BatchContext): Promise<BatchResult> {
  const startTime = Date.now();
  let embedded = 0;
  let errors = 0;
  const errorSamples: string[] = [];
  let suggestion: string | undefined;
  let cursor: Cursor | undefined;

  const pushErrorSamples = (samples: string[]): void => {
    for (const sample of samples) {
      if (errorSamples.length >= 5) {
        break;
      }
      if (!errorSamples.includes(sample)) {
        errorSamples.push(sample);
      }
    }
  };

  while (embedded + errors < ctx.totalToEmbed) {
    // Get next batch using seek pagination (cursor-based)
    const batchResult = ctx.force
      ? await getActiveChunks(ctx.db, ctx.batchSize, cursor, ctx.collection)
      : await ctx.stats.getBacklog(ctx.modelUri, {
          limit: ctx.batchSize,
          after: cursor,
          collection: ctx.collection,
        });

    if (!batchResult.ok) {
      return { ok: false, error: batchResult.error.message };
    }

    const batch = batchResult.value;
    if (batch.length === 0) {
      break;
    }

    // Advance cursor to last item (even on failure, to avoid infinite loops)
    const lastItem = batch.at(-1);
    if (lastItem) {
      cursor = { mirrorHash: lastItem.mirrorHash, seq: lastItem.seq };
    }

    // Embed batch with contextual formatting (title prefix)
    const batchEmbedResult = await embedTextsWithRecovery(
      ctx.embedPort,
      batch.map((b) =>
        formatDocForEmbedding(b.text, b.title ?? undefined, ctx.modelUri)
      )
    );
    if (!batchEmbedResult.ok) {
      const formattedError = formatLlmFailure(batchEmbedResult.error);
      if (ctx.recreateEmbedPort && isDisposedBatchError(formattedError)) {
        if (ctx.verbose) {
          process.stderr.write(
            "\n[embed] Embedding port disposed; recreating model/contexts and retrying batch once\n"
          );
        }
        const recreated = await ctx.recreateEmbedPort();
        if (recreated.ok) {
          ctx.embedPort = recreated.value;
          const retryResult = await embedTextsWithRecovery(
            ctx.embedPort,
            batch.map((b) =>
              formatDocForEmbedding(b.text, b.title ?? undefined, ctx.modelUri)
            )
          );
          if (retryResult.ok) {
            if (ctx.verbose) {
              process.stderr.write(
                "\n[embed] Retry after port reset succeeded\n"
              );
            }
            pushErrorSamples(retryResult.value.failureSamples);
            suggestion ||= retryResult.value.retrySuggestion;

            const retryVectors: VectorRow[] = [];
            for (const [idx, item] of batch.entries()) {
              const embedding = retryResult.value.vectors[idx];
              if (!embedding) {
                errors += 1;
                continue;
              }
              retryVectors.push({
                mirrorHash: item.mirrorHash,
                seq: item.seq,
                model: ctx.modelUri,
                embedding: new Float32Array(embedding),
              });
            }

            if (retryVectors.length === 0) {
              if (ctx.verbose) {
                process.stderr.write(
                  "\n[embed] No recoverable embeddings in retry batch\n"
                );
              }
              continue;
            }

            const retryStoreResult =
              await ctx.vectorIndex.upsertVectors(retryVectors);
            if (!retryStoreResult.ok) {
              if (ctx.verbose) {
                process.stderr.write(
                  `\n[embed] Store failed: ${retryStoreResult.error.message}\n`
                );
              }
              pushErrorSamples([retryStoreResult.error.message]);
              suggestion ??=
                "Store write failed. Rerun `gno embed` once more; if it repeats, run `gno doctor` and `gno vec sync`.";
              errors += retryVectors.length;
              continue;
            }

            embedded += retryVectors.length;
            if (ctx.showProgress) {
              const embeddedDisplay = Math.min(embedded, ctx.totalToEmbed);
              const completed = Math.min(embedded + errors, ctx.totalToEmbed);
              const pct = (completed / ctx.totalToEmbed) * 100;
              const elapsed = (Date.now() - startTime) / 1000;
              const rate = embedded / Math.max(elapsed, 0.001);
              const eta =
                Math.max(0, ctx.totalToEmbed - completed) /
                Math.max(rate, 0.001);
              process.stdout.write(
                `\rEmbedding: ${embeddedDisplay.toLocaleString()}/${ctx.totalToEmbed.toLocaleString()} (${pct.toFixed(1)}%) | ${rate.toFixed(1)} chunks/s | ETA ${formatDuration(eta)}`
              );
            }
            continue;
          }
        }
      }

      if (ctx.verbose) {
        const err = batchEmbedResult.error;
        const cause = err.cause;
        const causeMsg =
          cause && typeof cause === "object" && "message" in cause
            ? (cause as { message: string }).message
            : typeof cause === "string"
              ? cause
              : "";
        const titles = batch
          .slice(0, 3)
          .map((b) => b.title ?? b.mirrorHash.slice(0, 8))
          .join(", ");
        process.stderr.write(
          `\n[embed] Batch failed (${batch.length} chunks: ${titles}${batch.length > 3 ? "..." : ""}): ${err.message}${causeMsg ? ` - ${causeMsg}` : ""}\n`
        );
      }
      pushErrorSamples([formattedError]);
      suggestion =
        "Try rerunning the same command. If failures persist, rerun with `gno --verbose embed --batch-size 1` to isolate failing chunks.";
      errors += batch.length;
      continue;
    }

    if (ctx.verbose && batchEmbedResult.value.batchFailed) {
      const titles = batch
        .slice(0, 3)
        .map((b) => b.title ?? b.mirrorHash.slice(0, 8))
        .join(", ");
      process.stderr.write(
        `\n[embed] Batch fallback (${batch.length} chunks: ${titles}${batch.length > 3 ? "..." : ""}): ${batchEmbedResult.value.batchError ?? "unknown batch error"}\n`
      );
    }
    pushErrorSamples(batchEmbedResult.value.failureSamples);
    suggestion ||= batchEmbedResult.value.retrySuggestion;
    if (ctx.verbose && batchEmbedResult.value.failureSamples.length > 0) {
      for (const sample of batchEmbedResult.value.failureSamples) {
        process.stderr.write(`\n[embed] Sample failure: ${sample}\n`);
      }
    }

    const vectors: VectorRow[] = [];
    for (const [idx, item] of batch.entries()) {
      const embedding = batchEmbedResult.value.vectors[idx];
      if (!embedding) {
        errors += 1;
        continue;
      }
      vectors.push({
        mirrorHash: item.mirrorHash,
        seq: item.seq,
        model: ctx.modelUri,
        embedding: new Float32Array(embedding),
      });
    }

    if (vectors.length === 0) {
      if (ctx.verbose) {
        process.stderr.write("\n[embed] No recoverable embeddings in batch\n");
      }
      continue;
    }

    const storeResult = await ctx.vectorIndex.upsertVectors(vectors);
    if (!storeResult.ok) {
      if (ctx.verbose) {
        process.stderr.write(
          `\n[embed] Store failed: ${storeResult.error.message}\n`
        );
      }
      pushErrorSamples([storeResult.error.message]);
      suggestion ??=
        "Store write failed. Rerun `gno embed` once more; if it repeats, run `gno doctor` and `gno vec sync`.";
      errors += vectors.length;
      continue;
    }

    embedded += vectors.length;

    // Progress output
    if (ctx.showProgress) {
      const embeddedDisplay = Math.min(embedded, ctx.totalToEmbed);
      const completed = Math.min(embedded + errors, ctx.totalToEmbed);
      const pct = (completed / ctx.totalToEmbed) * 100;
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = embedded / Math.max(elapsed, 0.001);
      const eta =
        Math.max(0, ctx.totalToEmbed - completed) / Math.max(rate, 0.001);
      process.stdout.write(
        `\rEmbedding: ${embeddedDisplay.toLocaleString()}/${ctx.totalToEmbed.toLocaleString()} (${pct.toFixed(1)}%) | ${rate.toFixed(1)} chunks/s | ETA ${formatDuration(eta)}`
      );
    }
  }

  if (ctx.showProgress) {
    process.stdout.write("\n");
  }

  return {
    ok: true,
    embedded,
    errors,
    duration: (Date.now() - startTime) / 1000,
    errorSamples,
    suggestion,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface EmbedContext {
  config: Config;
  modelUri: string;
  store: SqliteAdapter;
}

/**
 * Initialize embed context: check init, load config, open store.
 */
async function initEmbedContext(
  configPath?: string,
  indexName?: string,
  collection?: string,
  model?: string
): Promise<({ ok: true } & EmbedContext) | { ok: false; error: string }> {
  const initialized = await isInitialized(configPath);
  if (!initialized) {
    return { ok: false, error: "GNO not initialized. Run: gno init" };
  }

  const configResult = await loadConfig(configPath);
  if (!configResult.ok) {
    return { ok: false, error: configResult.error.message };
  }
  const config = configResult.value;
  if (
    collection &&
    !config.collections.some((candidate) => candidate.name === collection)
  ) {
    return { ok: false, error: `Collection not found: ${collection}` };
  }

  const modelUri = resolveModelUri(config, "embed", model, collection);

  const store = new SqliteAdapter();
  const dbPath = getIndexDbPath(indexName);
  const paths = getConfigPaths();
  store.setConfigPath(configPath ?? paths.configFile);

  const openResult = await store.open(dbPath, config.ftsTokenizer);
  if (!openResult.ok) {
    return { ok: false, error: openResult.error.message };
  }

  return { ok: true, config, modelUri, store };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Command
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute gno embed command.
 */
export async function embed(options: EmbedOptions = {}): Promise<EmbedResult> {
  const batchSize = options.batchSize ?? 32;
  const force = options.force ?? false;
  const dryRun = options.dryRun ?? false;

  // Initialize config and store
  const initResult = await initEmbedContext(
    options.configPath,
    options.indexName,
    options.collection,
    options.model
  );
  if (!initResult.ok) {
    return { success: false, error: initResult.error };
  }
  const { config, modelUri, store } = initResult;

  // Get raw DB for vector ops (SqliteAdapter always implements SqliteDbProvider)
  const db = store.getRawDb();
  let embedPort: EmbeddingPort | null = null;
  let vectorIndex: VectorIndexPort | null = null;

  try {
    // Create stats port for backlog detection
    const stats: VectorStatsPort = createVectorStatsPort(db);

    // Get backlog count first (before loading model)
    const backlogResult = force
      ? await getActiveChunkCount(db, options.collection)
      : await stats.countBacklog(modelUri, { collection: options.collection });

    if (!backlogResult.ok) {
      return { success: false, error: backlogResult.error.message };
    }

    const totalToEmbed = backlogResult.value;

    if (totalToEmbed === 0) {
      const vecAvailable = await checkVecAvailable(db);
      return {
        success: true,
        embedded: 0,
        errors: 0,
        duration: 0,
        model: modelUri,
        searchAvailable: vecAvailable,
        errorSamples: [],
      };
    }

    if (dryRun) {
      const vecAvailable = await checkVecAvailable(db);
      return {
        success: true,
        embedded: totalToEmbed,
        errors: 0,
        duration: 0,
        model: modelUri,
        searchAvailable: vecAvailable,
        errorSamples: [],
      };
    }

    // Create LLM adapter and embedding port with auto-download
    const globals = getGlobals();
    const policy = resolveDownloadPolicy(process.env, {
      offline: globals.offline,
    });

    // Create progress renderer for model download (throttled to avoid spam)
    const showDownloadProgress = !options.json && process.stderr.isTTY;
    const downloadProgress = showDownloadProgress
      ? createThrottledProgressRenderer(createProgressRenderer())
      : undefined;

    const llm = new LlmAdapter(config);
    const recreateEmbedPort = async () => {
      if (embedPort) {
        await embedPort.dispose();
      }
      await llm.getManager().dispose(modelUri);
      const recreated = await llm.createEmbeddingPort(modelUri, {
        policy,
        onProgress: downloadProgress
          ? (progress) => downloadProgress("embed", progress)
          : undefined,
      });
      if (!recreated.ok) {
        return { ok: false as const, error: recreated.error.message };
      }
      const initResult = await recreated.value.init();
      if (!initResult.ok) {
        await recreated.value.dispose();
        return { ok: false as const, error: initResult.error.message };
      }
      return { ok: true as const, value: recreated.value };
    };
    const embedResult = await llm.createEmbeddingPort(modelUri, {
      policy,
      onProgress: downloadProgress
        ? (progress) => downloadProgress("embed", progress)
        : undefined,
    });
    if (!embedResult.ok) {
      return { success: false, error: embedResult.error.message };
    }
    embedPort = embedResult.value;

    // Clear download progress line if shown
    if (showDownloadProgress) {
      process.stderr.write("\n");
    }

    // Discover dimensions via probe embedding
    const probeResult = await embedPort.embed("dimension probe");
    if (!probeResult.ok) {
      return { success: false, error: probeResult.error.message };
    }
    const dimensions = probeResult.value.length;

    // Create vector index port
    const vectorResult = await createVectorIndexPort(db, {
      model: modelUri,
      dimensions,
    });
    if (!vectorResult.ok) {
      return { success: false, error: vectorResult.error.message };
    }
    vectorIndex = vectorResult.value;

    // Process batches
    const result = await processBatches({
      db,
      stats,
      embedPort,
      vectorIndex,
      modelUri,
      collection: options.collection,
      batchSize,
      force,
      showProgress: !options.json,
      totalToEmbed,
      verbose: options.verbose ?? false,
      recreateEmbedPort,
    });

    if (!result.ok) {
      return { success: false, error: result.error };
    }

    // Sync vec index if any vec0 writes failed (matches embedBacklog behavior)
    if (vectorIndex.vecDirty) {
      const syncResult = await vectorIndex.syncVecIndex();
      if (syncResult.ok) {
        const { added, removed } = syncResult.value;
        if (added > 0 || removed > 0) {
          if (!options.json) {
            process.stdout.write(
              `\n[vec] Synced index: +${added} -${removed}\n`
            );
          }
        }
        vectorIndex.vecDirty = false;
      } else {
        if (!options.json) {
          process.stdout.write(
            `\n[vec] Sync failed: ${syncResult.error.message}\n`
          );
        }
        return {
          success: true,
          embedded: result.embedded,
          errors: result.errors,
          duration: result.duration,
          model: modelUri,
          searchAvailable: vectorIndex.searchAvailable,
          errorSamples: [
            ...result.errorSamples,
            syncResult.error.message,
          ].slice(0, 5),
          suggestion:
            "Vector index sync failed after embedding. Rerun `gno embed` once more. If it repeats, run `gno vec sync`.",
          syncError: syncResult.error.message,
        };
      }
    }

    return {
      success: true,
      embedded: result.embedded,
      errors: result.errors,
      duration: result.duration,
      model: modelUri,
      searchAvailable: vectorIndex.searchAvailable,
      errorSamples: result.errorSamples,
      suggestion: result.suggestion,
    };
  } finally {
    if (embedPort) {
      await embedPort.dispose();
    }
    await store.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Get all active chunks (for --force mode)
// ─────────────────────────────────────────────────────────────────────────────

function getActiveChunkCount(
  db: Database,
  collection?: string
): Promise<StoreResult<number>> {
  try {
    const collectionClause = collection ? " AND d.collection = ?" : "";
    const result = db
      .prepare(
        `
        SELECT COUNT(*) as count FROM content_chunks c
        WHERE EXISTS (
          SELECT 1 FROM documents d
          WHERE d.mirror_hash = c.mirror_hash AND d.active = 1${collectionClause}
        )
      `
      )
      .get(...(collection ? [collection] : [])) as { count: number };
    return Promise.resolve(ok(result.count));
  } catch (e) {
    return Promise.resolve(
      err(
        "QUERY_FAILED",
        `Failed to count chunks: ${e instanceof Error ? e.message : String(e)}`
      )
    );
  }
}

function getActiveChunks(
  db: Database,
  limit: number,
  after?: { mirrorHash: string; seq: number },
  collection?: string
): Promise<StoreResult<BacklogItem[]>> {
  try {
    const collectionClause = collection ? " AND d.collection = ?" : "";
    // Include title for contextual embedding
    const sql = after
      ? `
        SELECT c.mirror_hash as mirrorHash, c.seq, c.text,
          (SELECT d.title FROM documents d WHERE d.mirror_hash = c.mirror_hash AND d.active = 1 LIMIT 1) as title,
          'force' as reason
        FROM content_chunks c
        WHERE EXISTS (
          SELECT 1 FROM documents d
          WHERE d.mirror_hash = c.mirror_hash AND d.active = 1${collectionClause}
        )
        AND (c.mirror_hash > ? OR (c.mirror_hash = ? AND c.seq > ?))
        ORDER BY c.mirror_hash, c.seq
        LIMIT ?
      `
      : `
        SELECT c.mirror_hash as mirrorHash, c.seq, c.text,
          (SELECT d.title FROM documents d WHERE d.mirror_hash = c.mirror_hash AND d.active = 1 LIMIT 1) as title,
          'force' as reason
        FROM content_chunks c
        WHERE EXISTS (
          SELECT 1 FROM documents d
          WHERE d.mirror_hash = c.mirror_hash AND d.active = 1${collectionClause}
        )
        ORDER BY c.mirror_hash, c.seq
        LIMIT ?
      `;

    const params = after
      ? [
          ...(collection ? [collection] : []),
          after.mirrorHash,
          after.mirrorHash,
          after.seq,
          limit,
        ]
      : [...(collection ? [collection] : []), limit];

    const results = db.prepare(sql).all(...params) as BacklogItem[];
    return Promise.resolve(ok(results));
  } catch (e) {
    return Promise.resolve(
      err(
        "QUERY_FAILED",
        `Failed to get chunks: ${e instanceof Error ? e.message : String(e)}`
      )
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Format
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format embed result for output.
 */
export function formatEmbed(
  result: EmbedResult,
  options: EmbedOptions
): string {
  if (!result.success) {
    return options.json
      ? JSON.stringify({ error: { code: "RUNTIME", message: result.error } })
      : `Error: ${result.error}`;
  }

  if (options.json) {
    return JSON.stringify(
      {
        embedded: result.embedded,
        errors: result.errors,
        duration: result.duration,
        model: result.model,
        searchAvailable: result.searchAvailable,
        errorSamples: result.errorSamples ?? [],
        suggestion: result.suggestion,
        syncError: result.syncError,
      },
      null,
      2
    );
  }

  if (options.dryRun) {
    return `Dry run: would embed ${result.embedded.toLocaleString()} chunks with model ${result.model}`;
  }

  if (result.embedded === 0 && result.errors === 0) {
    return "No chunks need embedding. All up to date.";
  }

  const lines: string[] = [];
  lines.push(
    `Embedded ${result.embedded.toLocaleString()} chunks in ${formatDuration(result.duration)}`
  );

  if (result.errors > 0) {
    lines.push(`${result.errors} chunks failed to embed.`);
    if ((result.errorSamples?.length ?? 0) > 0) {
      for (const sample of result.errorSamples ?? []) {
        lines.push(`Sample error: ${sample}`);
      }
    }
    if (result.suggestion) {
      lines.push(`Hint: ${result.suggestion}`);
    }
  }

  if (!result.searchAvailable) {
    lines.push(
      "Warning: sqlite-vec not available. Embeddings stored but KNN search disabled."
    );
  }

  if (result.syncError) {
    lines.push(`Vec sync error: ${result.syncError}`);
  }

  return lines.join("\n");
}
