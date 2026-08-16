/**
 * Ingestion subsystem types.
 * Defines Walker, Chunker, and Sync interfaces.
 *
 * @module src/ingestion/types
 */

import type { NormalizedContentTypeRule } from "../config";
import type { Collection } from "../config/types";
import type {
  RecordAdapterFailure,
  RecordAttachmentInventoryItem,
} from "../converters/types";
import type { EgressLineage } from "../core/egress-provenance";
import type { DirectoryAvailabilityPort } from "./source-availability/types";

// ─────────────────────────────────────────────────────────────────────────────
// Walker Types
// ─────────────────────────────────────────────────────────────────────────────

/** File entry from walker */
export interface WalkEntry {
  /** Absolute path to file */
  absPath: string;
  /** Relative path within collection (POSIX forward slashes) */
  relPath: string;
  /** File size in bytes */
  size: number;
  /** Modification time (ISO 8601) */
  mtime: string;
  /** Creation/change time (ISO 8601) */
  ctime: string;
}

/** Walker configuration */
export interface WalkConfig {
  /** Collection root path (absolute) */
  root: string;
  /** Glob pattern (default: **\/*) */
  pattern: string;
  /** Extension allowlist (empty = supported defaults) */
  include: string[];
  /** Adapter-configured extensions added only to the supported defaults. */
  additionalDefaultExtensions?: string[];
  /** Paths/patterns to exclude */
  exclude: string[];
  /** Max file size in bytes (files larger are skipped) */
  maxBytes: number;
  /**
   * Source availability mode for this walk.
   * `any` (default) keeps Bun.Glob traversal unchanged.
   * `local` refuses descent into unproven/dataless directories.
   */
  sourceAvailability?: "any" | "local";
  /**
   * Optional injectable directory classifier (tests / SyncService wiring).
   * When omitted, FileWalker builds one from `sourceAvailability`.
   */
  directoryAvailability?: DirectoryAvailabilityPort;
}

/** Skip reasons emitted by the walker (and mirrored into sync receipts). */
export type WalkSkipReason =
  | "TOO_LARGE"
  | "EXCLUDED"
  | "DATALESS_DIRECTORY"
  | "CLOUD_PLACEHOLDER"
  | "CLOUD_PARTIAL"
  | "SOURCE_AVAILABILITY_UNSUPPORTED"
  | "SOURCE_AVAILABILITY_POLICY_FAILED"
  | "SOURCE_AVAILABILITY_UNKNOWN"
  | "PERMISSION"
  | "NOT_FOUND"
  | "NOT_FILE"
  | "IO_ERROR";

/** Skipped file or directory-prefix entry (for error tracking / reconciliation) */
export interface SkippedEntry {
  absPath: string;
  relPath: string;
  reason: WalkSkipReason;
  size?: number;
  /**
   * When true, absence of descendants under this prefix is unproven —
   * reconciliation must preserve previously indexed sources.
   */
  unprovenPrefix?: boolean;
  message?: string;
}

/** Walker port interface */
export interface WalkerPort {
  /**
   * Walk collection directory yielding file entries.
   * Filters by pattern, include, exclude.
   * Files > maxBytes are tracked in skipped array.
   */
  walk(config: WalkConfig): Promise<{
    entries: WalkEntry[];
    skipped: SkippedEntry[];
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunker Types
// ─────────────────────────────────────────────────────────────────────────────

/** Chunk parameters */
export interface ChunkParams {
  /** Max tokens per chunk (default: 800) */
  maxTokens: number;
  /** Overlap percentage 0-1 (default: 0.15) */
  overlapPercent: number;
}

/** Default chunk params */
export const DEFAULT_CHUNK_PARAMS: ChunkParams = {
  maxTokens: 800,
  overlapPercent: 0.15,
};

/** Chunked output */
export interface ChunkOutput {
  /** Sequence number (0-indexed) */
  seq: number;
  /** Character position in source */
  pos: number;
  /** Chunk text */
  text: string;
  /** Start line (1-based) */
  startLine: number;
  /** End line (1-based) */
  endLine: number;
  /** Detected language (BCP-47 or null) */
  language: string | null;
  /** Token count estimate (null for char-based) */
  tokenCount: number | null;
}

/** Chunker port interface */
export interface ChunkerPort {
  /**
   * Chunk markdown content.
   * Returns deterministic chunks for (text, params).
   */
  chunk(
    markdown: string,
    params?: ChunkParams,
    documentLanguageHint?: string,
    sourcePath?: string
  ): ChunkOutput[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync Types
// ─────────────────────────────────────────────────────────────────────────────

/** Sync options */
export interface SyncOptions {
  /** Run git pull before scanning */
  gitPull?: boolean;
  /** Run collection updateCmd before scanning */
  runUpdateCmd?: boolean;
  /** Conversion limits override */
  limits?: {
    maxBytes?: number;
    timeoutMs?: number;
    maxOutputChars?: number;
  };
  /**
   * Max concurrent file processing (default: 1).
   * Higher values improve throughput but increase memory pressure.
   * SQLite operations are serialized regardless of this setting.
   */
  concurrency?: number;
  /** Normalized content type rules from config.contentTypes. */
  contentTypeRules?: NormalizedContentTypeRule[];
  /** Stable hash of metadata-affecting rules, used for re-derivation. */
  contentTypeRulesFingerprint?: string;
  /** Internal orchestration flag: defer graph projection to an outer sync. */
  projectTypedEdges?: boolean;
  /**
   * Optional run-level override for source availability (`any` | `local`).
   * Wins over collection config when set. Distinct from egress policy.
   */
  sourceAvailability?: "any" | "local";
}

export type ContentTypeSource =
  | "frontmatter-type"
  | "prefix"
  | "path-ext"
  | "fallback";

/** Maximum per-record actions retained in one sync receipt. */
export const MAX_RECORD_IMPORT_RECEIPT_ITEMS = 1_000;

export type RecordImportOutcome =
  | "added"
  | "updated"
  | "reactivated"
  | "unchanged"
  | "deactivated"
  | "preserved";

/** Bounded, privacy-safe identity and provenance for one reconciled record. */
export interface RecordImportItemReceipt {
  outcome: RecordImportOutcome;
  recordKey: string;
  sourceLocator: string;
  sourceHash: string;
  mirrorHash?: string;
  adapterFingerprint: string;
  attachments: RecordAttachmentInventoryItem[];
}

export interface RecordImportWarning {
  code: "PARTIAL_SNAPSHOT";
  message: string;
  retryable: boolean;
}

/** Per-file sync status */
export type FileSyncStatus =
  | "added"
  | "updated"
  | "unchanged"
  | "error"
  | "skipped";

/** Per-file sync result */
export interface FileSyncResult {
  relPath: string;
  status: FileSyncStatus;
  docid?: string;
  mirrorHash?: string;
  contentType?: string;
  contentTypeSource?: ContentTypeSource;
  errorCode?: string;
  errorMessage?: string;
  recordImport?: {
    adapterId: string;
    adapterVersion: string;
    adapterFingerprint: string;
    egressLineage?: EgressLineage;
    snapshotState: "complete" | "partial";
    authoritative: boolean;
    stoppedByCap: boolean;
    sourceBytesRead: number;
    records: {
      accepted: number;
      added: number;
      updated: number;
      reactivated: number;
      unchanged: number;
      deactivated: number;
      preserved: number;
      failed: number;
    };
    items: RecordImportItemReceipt[];
    itemsTruncated: number;
    warnings: RecordImportWarning[];
    failures: RecordAdapterFailure[];
  };
}

/** Collection sync summary */
export interface CollectionSyncResult {
  collection: string;
  filesProcessed: number;
  filesAdded: number;
  filesUpdated: number;
  filesUnchanged: number;
  filesErrored: number;
  filesSkipped: number;
  filesMarkedInactive: number;
  durationMs: number;
  files?: FileSyncResult[];
  errors: Array<{
    relPath: string;
    code: string;
    message: string;
  }>;
}

/** Full sync summary */
export interface SyncResult {
  collections: CollectionSyncResult[];
  totalDurationMs: number;
  totalFilesProcessed: number;
  totalFilesAdded: number;
  totalFilesUpdated: number;
  totalFilesErrored: number;
  totalFilesSkipped: number;
}

/** Decision for whether to process a file */
export type ProcessDecision =
  | { kind: "skip"; reason: string }
  | { kind: "process"; reason: string }
  | { kind: "repair"; reason: string };

// ─────────────────────────────────────────────────────────────────────────────
// Language Detection Types
// ─────────────────────────────────────────────────────────────────────────────

/** Language detector port */
export interface LanguageDetectorPort {
  /**
   * Detect language from text.
   * Returns BCP-47 code or null if undetermined.
   * Must be deterministic for same input.
   */
  detect(text: string): string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper to create WalkConfig from Collection
// ─────────────────────────────────────────────────────────────────────────────

const TRANSCRIPT_EXTENSION_BY_FORMAT = {
  json: ".json",
  srt: ".srt",
  text: ".txt",
  vtt: ".vtt",
} as const;

/**
 * Create WalkConfig from Collection with maxBytes override.
 */
export function collectionToWalkConfig(
  collection: Collection,
  maxBytes: number,
  options?: Pick<SyncOptions, "sourceAvailability">
): WalkConfig {
  const transcriptFormat = collection.recordAdapters?.transcript?.format;
  const sourceAvailability =
    options?.sourceAvailability ?? collection.sourceAvailability ?? undefined;
  return {
    root: collection.path,
    pattern: collection.pattern,
    include: collection.include,
    additionalDefaultExtensions: transcriptFormat
      ? [TRANSCRIPT_EXTENSION_BY_FORMAT[transcriptFormat]]
      : [],
    exclude: collection.exclude,
    maxBytes,
    ...(sourceAvailability ? { sourceAvailability } : {}),
  };
}
