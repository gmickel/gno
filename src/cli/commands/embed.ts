/**
 * gno embed command implementation.
 * Batch embed chunks into vector storage.
 *
 * @module src/cli/commands/embed
 */

import type { Database } from 'bun:sqlite';
import { getIndexDbPath } from '../../app/constants';
import { getConfigPaths, isInitialized, loadConfig } from '../../config';
import { LlmAdapter } from '../../llm/nodeLlamaCpp/adapter';
import { getActivePreset } from '../../llm/registry';
import type { EmbeddingPort } from '../../llm/types';
import { SqliteAdapter } from '../../store/sqlite/adapter';
import type { StoreResult } from '../../store/types';
import { err, ok } from '../../store/types';
import {
  type BacklogItem,
  createVectorIndexPort,
  createVectorStatsPort,
  type VectorIndexPort,
  type VectorRow,
  type VectorStatsPort,
} from '../../store/vector';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type EmbedOptions = {
  /** Override config path */
  configPath?: string;
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
};

export type EmbedResult =
  | {
      success: true;
      embedded: number;
      errors: number;
      duration: number;
      model: string;
      searchAvailable: boolean;
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

async function checkVecAvailable(
  db: import('bun:sqlite').Database
): Promise<boolean> {
  try {
    const sqliteVec = await import('sqlite-vec');
    sqliteVec.load(db);
    return true;
  } catch {
    return false;
  }
}

type BatchContext = {
  db: import('bun:sqlite').Database;
  stats: VectorStatsPort;
  embedPort: EmbeddingPort;
  vectorIndex: VectorIndexPort;
  modelUri: string;
  batchSize: number;
  force: boolean;
  showProgress: boolean;
  totalToEmbed: number;
};

type BatchResult =
  | { ok: true; embedded: number; errors: number; duration: number }
  | { ok: false; error: string };

type Cursor = { mirrorHash: string; seq: number };

async function processBatches(ctx: BatchContext): Promise<BatchResult> {
  const startTime = Date.now();
  let embedded = 0;
  let errors = 0;
  let cursor: Cursor | undefined;

  while (embedded + errors < ctx.totalToEmbed) {
    // Get next batch using seek pagination (cursor-based)
    const batchResult = ctx.force
      ? await getActiveChunks(ctx.db, ctx.batchSize, cursor)
      : await ctx.stats.getBacklog(ctx.modelUri, {
          limit: ctx.batchSize,
          after: cursor,
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

    // Embed batch
    const batchEmbedResult = await ctx.embedPort.embedBatch(
      batch.map((b) => b.text)
    );
    if (!batchEmbedResult.ok) {
      errors += batch.length;
      continue;
    }

    // Validate batch/embedding count match
    const embeddings = batchEmbedResult.value;
    if (embeddings.length !== batch.length) {
      errors += batch.length;
      continue;
    }

    // Store vectors
    const vectors: VectorRow[] = batch.map((b, idx) => ({
      mirrorHash: b.mirrorHash,
      seq: b.seq,
      model: ctx.modelUri,
      embedding: new Float32Array(embeddings[idx] as number[]),
      embeddedAt: new Date().toISOString(),
    }));

    const storeResult = await ctx.vectorIndex.upsertVectors(vectors);
    if (!storeResult.ok) {
      errors += batch.length;
      continue;
    }

    embedded += batch.length;

    // Progress output
    if (ctx.showProgress) {
      const pct = ((embedded + errors) / ctx.totalToEmbed) * 100;
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = embedded / Math.max(elapsed, 0.001);
      const eta =
        (ctx.totalToEmbed - embedded - errors) / Math.max(rate, 0.001);
      process.stdout.write(
        `\rEmbedding: ${embedded.toLocaleString()}/${ctx.totalToEmbed.toLocaleString()} (${pct.toFixed(1)}%) | ${rate.toFixed(1)} chunks/s | ETA ${formatDuration(eta)}`
      );
    }
  }

  if (ctx.showProgress) {
    process.stdout.write('\n');
  }

  return {
    ok: true,
    embedded,
    errors,
    duration: (Date.now() - startTime) / 1000,
  };
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

  // Check initialization
  const initialized = await isInitialized(options.configPath);
  if (!initialized) {
    return { success: false, error: 'GNO not initialized. Run: gno init' };
  }

  // Load config
  const configResult = await loadConfig(options.configPath);
  if (!configResult.ok) {
    return { success: false, error: configResult.error.message };
  }
  const config = configResult.value;

  // Get model URI
  const preset = getActivePreset(config);
  const modelUri = options.model ?? preset.embed;

  // Open store
  const store = new SqliteAdapter();
  const dbPath = getIndexDbPath();
  const paths = getConfigPaths();
  store.setConfigPath(paths.configFile);

  const openResult = await store.open(dbPath, config.ftsTokenizer);
  if (!openResult.ok) {
    return { success: false, error: openResult.error.message };
  }

  // Get raw DB for vector ops (SqliteAdapter always implements SqliteDbProvider)
  const db = store.getRawDb();
  let embedPort: EmbeddingPort | null = null;
  let vectorIndex: VectorIndexPort | null = null;

  try {
    // Create stats port for backlog detection
    const stats: VectorStatsPort = createVectorStatsPort(db);

    // Get backlog count first (before loading model)
    const backlogResult = force
      ? await getActiveChunkCount(db)
      : await stats.countBacklog(modelUri);

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
      };
    }

    // Create LLM adapter and embedding port
    const llm = new LlmAdapter(config);
    const embedResult = await llm.createEmbeddingPort(modelUri);
    if (!embedResult.ok) {
      return { success: false, error: embedResult.error.message };
    }
    embedPort = embedResult.value;

    // Discover dimensions via probe embedding
    const probeResult = await embedPort.embed('dimension probe');
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
      batchSize,
      force,
      showProgress: !options.json,
      totalToEmbed,
    });

    if (!result.ok) {
      return { success: false, error: result.error };
    }

    return {
      success: true,
      embedded: result.embedded,
      errors: result.errors,
      duration: result.duration,
      model: modelUri,
      searchAvailable: vectorIndex.searchAvailable,
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

function getActiveChunkCount(db: Database): Promise<StoreResult<number>> {
  try {
    const result = db
      .prepare(
        `
        SELECT COUNT(*) as count FROM content_chunks c
        WHERE EXISTS (
          SELECT 1 FROM documents d
          WHERE d.mirror_hash = c.mirror_hash AND d.active = 1
        )
      `
      )
      .get() as { count: number };
    return Promise.resolve(ok(result.count));
  } catch (e) {
    return Promise.resolve(err('QUERY_FAILED', `Failed to count chunks: ${e}`));
  }
}

function getActiveChunks(
  db: Database,
  limit: number,
  after?: { mirrorHash: string; seq: number }
): Promise<StoreResult<BacklogItem[]>> {
  try {
    const sql = after
      ? `
        SELECT c.mirror_hash as mirrorHash, c.seq, c.text, 'force' as reason
        FROM content_chunks c
        WHERE EXISTS (
          SELECT 1 FROM documents d
          WHERE d.mirror_hash = c.mirror_hash AND d.active = 1
        )
        AND (c.mirror_hash > ? OR (c.mirror_hash = ? AND c.seq > ?))
        ORDER BY c.mirror_hash, c.seq
        LIMIT ?
      `
      : `
        SELECT c.mirror_hash as mirrorHash, c.seq, c.text, 'force' as reason
        FROM content_chunks c
        WHERE EXISTS (
          SELECT 1 FROM documents d
          WHERE d.mirror_hash = c.mirror_hash AND d.active = 1
        )
        ORDER BY c.mirror_hash, c.seq
        LIMIT ?
      `;

    const params = after
      ? [after.mirrorHash, after.mirrorHash, after.seq, limit]
      : [limit];

    const results = db.prepare(sql).all(...params) as BacklogItem[];
    return Promise.resolve(ok(results));
  } catch (e) {
    return Promise.resolve(err('QUERY_FAILED', `Failed to get chunks: ${e}`));
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
      ? JSON.stringify({ error: { code: 'RUNTIME', message: result.error } })
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
      },
      null,
      2
    );
  }

  if (options.dryRun) {
    return `Dry run: would embed ${result.embedded.toLocaleString()} chunks with model ${result.model}`;
  }

  if (result.embedded === 0 && result.errors === 0) {
    return 'No chunks need embedding. All up to date.';
  }

  const lines: string[] = [];
  lines.push(
    `Embedded ${result.embedded.toLocaleString()} chunks in ${formatDuration(result.duration)}`
  );

  if (result.errors > 0) {
    lines.push(`${result.errors} chunks failed to embed.`);
  }

  if (!result.searchAvailable) {
    lines.push(
      'Warning: sqlite-vec not available. Embeddings stored but KNN search disabled.'
    );
  }

  return lines.join('\n');
}
