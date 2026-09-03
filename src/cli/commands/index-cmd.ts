/**
 * gno index command implementation.
 * Build or update the index end-to-end as two separable, resumable stages:
 * `lexical` (sync) then `embed`. Each stage reports its own receipt state and
 * counts; the run exits 0 only when every attempted stage completed (fn-132).
 *
 * @module src/cli/commands/indexCmd
 */

import {
  type CliWriteLeaseOptions,
  type WriteLeaseContention,
  withCliWriteLease,
} from "../../core/write-lease";
import {
  clearIndexStage,
  findInterruptedStage,
  formatInterruptedStage,
  type IndexStageState,
  type InterruptedStage,
  markIndexStageFinished,
  markIndexStageRunning,
  readIndexStageState,
} from "../../embed/stage-state";
import {
  defaultSyncService,
  type SyncResult,
  withContentTypeRules,
} from "../../ingestion";
import { type EmbedResult, embedStageOutcome } from "./embed";
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

/** Receipt for the lexical (sync) stage. */
export interface LexicalStageReceipt {
  state: IndexStageState;
  filesProcessed: number;
  filesAdded: number;
  filesUpdated: number;
  filesErrored: number;
  filesSkipped: number;
  durationMs: number;
  error?: string;
}

/** Receipt for the embed stage. */
export interface EmbedStageReceipt {
  state: IndexStageState;
  embedded: number;
  errors: number;
  contentionErrors: number;
  durationMs: number;
  /** Why the stage was skipped (`--no-embed`, lexical failure). */
  reason?: string;
  error?: string;
}

export interface IndexStageReceipts {
  lexical: LexicalStageReceipt;
  embed: EmbedStageReceipt;
}

export interface IndexEmbedSummary {
  embedded: number;
  errors: number;
  contentionErrors: number;
  duration: number;
}

/** Receipt fields shared by successful and failed runs that reached a stage. */
export interface IndexReceipt {
  stages: IndexStageReceipts;
  /** Stage a previous run left `running`; null when the run started clean. */
  resumedFrom: InterruptedStage | null;
  syncResult?: SyncResult;
  embedSkipped: boolean;
  embedResult?: IndexEmbedSummary;
}

/**
 * Result of index command. A failure that reached a stage carries the partial
 * receipt (`stages` present); a failure before any stage (init, lease) does not.
 */
export type IndexResult =
  | ({ success: true; syncResult: SyncResult } & IndexReceipt)
  | ({ success: false; error: string } & IndexReceipt)
  | {
      success: false;
      error: string;
      contention?: WriteLeaseContention;
      stages?: undefined;
    };

const EMPTY_LEXICAL_COUNTS = {
  filesProcessed: 0,
  filesAdded: 0,
  filesUpdated: 0,
  filesErrored: 0,
  filesSkipped: 0,
  durationMs: 0,
} as const;

const EMPTY_EMBED_COUNTS = {
  embedded: 0,
  errors: 0,
  contentionErrors: 0,
  durationMs: 0,
} as const;

function lexicalReceipt(syncResult: SyncResult): LexicalStageReceipt {
  return {
    state: "completed",
    filesProcessed: syncResult.totalFilesProcessed,
    filesAdded: syncResult.totalFilesAdded,
    filesUpdated: syncResult.totalFilesUpdated,
    filesErrored: syncResult.totalFilesErrored,
    filesSkipped: syncResult.totalFilesSkipped,
    durationMs: syncResult.totalDurationMs,
  };
}

function skippedEmbedReceipt(reason: string): EmbedStageReceipt {
  return { state: "skipped", ...EMPTY_EMBED_COUNTS, reason };
}

function embedReceipt(result: EmbedResult): EmbedStageReceipt {
  if (!result.success) {
    return { state: "failed", ...EMPTY_EMBED_COUNTS, error: result.error };
  }
  const state = embedStageOutcome(result);
  const error =
    state === "failed"
      ? (result.syncError ??
        result.errorSamples?.[0] ??
        `${result.errors} chunks failed to embed`)
      : undefined;
  return {
    state,
    embedded: result.embedded,
    errors: result.errors,
    contentionErrors: result.contentionErrors,
    durationMs: Math.round(result.duration * 1000),
    ...(error ? { error } : {}),
  };
}

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
    const db = store.getRawDb();
    const embedSkipped = options.noEmbed ?? false;

    try {
      // Resume preamble (fn-132 R4): report a stage the previous run left
      // `running` before this run overwrites its marker.
      const resumedFrom = findInterruptedStage(readIndexStageState(db));
      if (resumedFrom && !options.json) {
        process.stderr.write(`${formatInterruptedStage(resumedFrom)}\n`);
      }

      // Lexical stage (sync). Per-file errors are counted, not fatal; only a
      // sync that cannot run at all fails the stage.
      markIndexStageRunning(db, "lexical", { collection: options.collection });
      let syncResult: SyncResult;
      try {
        syncResult = await defaultSyncService.syncAll(
          collections,
          store,
          withContentTypeRules(
            { gitPull: options.gitPull, runUpdateCmd: true },
            config
          )
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        markIndexStageFinished(db, "lexical", "failed");
        return {
          success: false,
          error: `Lexical sync failed: ${message}`,
          stages: {
            lexical: {
              state: "failed",
              ...EMPTY_LEXICAL_COUNTS,
              error: message,
            },
            embed: skippedEmbedReceipt("lexical stage failed"),
          },
          resumedFrom,
          embedSkipped,
        };
      }
      markIndexStageFinished(db, "lexical", "completed");
      const lexical = lexicalReceipt(syncResult);

      if (embedSkipped) {
        // A stale `embed: running` marker (killed embed run) was surfaced in
        // this run's preamble; settle it so the next run does not repeat it
        // or mask a real lexical interruption. Embed progress stays on disk.
        if (resumedFrom?.stage === "embed") {
          clearIndexStage(db, "embed");
        }
        return {
          success: true,
          syncResult,
          embedSkipped,
          stages: { lexical, embed: skippedEmbedReceipt("--no-embed") },
          resumedFrom,
        };
      }

      // Embed stage. embed() owns its own persisted marker.
      const { embed } = await import("./embed");
      const result = await embed({
        configPath: options.configPath,
        indexName: options.indexName,
        collection: options.collection,
        verbose: options.verbose,
        json: options.json,
        skipWriteLease: true,
        resumedFrom,
      });
      const embedStage = embedReceipt(result);
      const embedResult: IndexEmbedSummary | undefined = result.success
        ? {
            embedded: result.embedded,
            errors: result.errors,
            contentionErrors: result.contentionErrors,
            duration: result.duration,
          }
        : undefined;
      const receipt: IndexReceipt = {
        stages: { lexical, embed: embedStage },
        resumedFrom,
        syncResult,
        embedSkipped,
        ...(embedResult ? { embedResult } : {}),
      };

      if (embedStage.state !== "completed") {
        return {
          success: false,
          error: `Embed stage failed: ${embedStage.error ?? "unknown error"}`,
          ...receipt,
        };
      }
      return { success: true, syncResult, ...receipt };
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

  if (!result.success && !result.stages) {
    return `Error: ${result.error}`;
  }

  if (options.json) {
    return JSON.stringify(
      {
        success: result.success,
        ...(result.success ? {} : { error: result.error }),
        stages: result.stages,
        resumedFrom: result.resumedFrom,
        ...(result.syncResult ? { syncResult: result.syncResult } : {}),
        embedSkipped: result.embedSkipped,
        ...(result.embedResult ? { embedResult: result.embedResult } : {}),
      },
      null,
      2
    );
  }

  const { stages, embedSkipped } = result;
  const lines: string[] = [
    result.success ? "Indexing complete." : "Indexing failed.",
    "",
  ];

  if (result.syncResult) {
    lines.push(...formatSyncResultLines(result.syncResult, options));
  } else {
    lines.push(`Lexical stage ${stages.lexical.state}.`);
  }
  if (stages.lexical.error) {
    lines.push(`Lexical error: ${stages.lexical.error}`);
  }

  lines.push("");
  if (embedSkipped) {
    lines.push("Embedding skipped (--no-embed)");
  } else if (stages.embed.state === "skipped") {
    lines.push(`Embedding skipped (${stages.embed.reason ?? "not attempted"})`);
  } else if (result.embedResult) {
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
  if (stages.embed.state === "failed") {
    lines.push(
      `Embed stage failed: ${stages.embed.error ?? "unknown error"}. Lexical index is intact; rerun \`gno embed\` to resume from persisted progress.`
    );
  }

  return lines.join("\n");
}
