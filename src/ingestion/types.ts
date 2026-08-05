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
}

/** Skipped file entry (for error tracking) */
export interface SkippedEntry {
  absPath: string;
  relPath: string;
  reason: "TOO_LARGE" | "EXCLUDED";
  size?: number;
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
}

export type ContentTypeSource =
  | "frontmatter-type"
  | "prefix"
  | "path-ext"
  | "fallback";

/** Maximum per-record actions retained in one sync receipt. */
export const MAX_RECORD_IMPORT_RECEIPT_ITEMS = 1_000;

/**
 * Maximum record URIs listed on one {@link WrittenPathHandle}.
 *
 * Same bound as {@link MAX_RECORD_IMPORT_RECEIPT_ITEMS}, deliberately: both are
 * "how much of an arbitrarily large container may one receipt carry", and a
 * second, different number would only invite the two to drift.
 */
export const MAX_WRITTEN_RECORD_URIS = MAX_RECORD_IMPORT_RECEIPT_ITEMS;

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

/**
 * The honest handle for a single path a caller WROTE and then proved.
 *
 * A create/capture that answers 202 + a job id has already sent its response by
 * the time the write is proven, so the completed JOB RESULT is the only channel
 * left that can correct it. `gno://<collection>/<relPath>` is the right handle
 * for an ordinary document and the WRONG one for a record container: the
 * container is indexed as N logical records at virtual paths with no row at the
 * written path, and `getDocumentByUri` is an exact lookup, so that URI resolves
 * to nothing. The `record-container` shape therefore carries no `uri` at all -
 * the file stays identified by `relPath`, and the fetchable handles are
 * `recordUris`.
 *
 * The URI list is a BOUNDED PAGE, not the container's contents. One valid
 * `.jsonl` export can hold six figures of records, and this handle is retained
 * on a completed job for an hour and JSON-encoded into a broadcast SSE frame -
 * so an exhaustive list would put megabytes into both. `recordCount` is exact,
 * `recordUris` carries the first {@link MAX_WRITTEN_RECORD_URIS} of them, and
 * `recordUrisTruncated` says how many this page does not list. There is no
 * DEDICATED per-container enumeration endpoint, and the handle claims none -
 * but the omitted records are not lost either: every record URI shares the
 * container's virtual `.gno/records/<id>/` prefix, so a prefix-scoped listing
 * enumerates exactly that container, and ordinary collection paging returns
 * every logical record with `relPath` projected from the container's own path.
 * The handle names those instead of overclaiming a continuation or
 * underclaiming reachability. The bound matches the
 * record-import receipt's existing {@link MAX_RECORD_IMPORT_RECEIPT_ITEMS} cap
 * so one convention governs everything a sync hands back.
 */
export type WrittenPathHandle =
  | {
      kind: "document";
      collection: string;
      relPath: string;
      /** Fetchable: resolves to the document at the written path. */
      uri: string;
      reason?: string;
    }
  | {
      kind: "record-container";
      collection: string;
      relPath: string;
      /** Exact number of active logical records the container is indexed as. */
      recordCount: number;
      /**
       * Fetchable: the virtual URIs of the container's logical records, capped
       * at {@link MAX_WRITTEN_RECORD_URIS}. Never the whole container.
       */
      recordUris: string[];
      /** `recordCount - recordUris.length`: records this page does not list. */
      recordUrisTruncated: number;
      reason?: string;
    };

/** Full sync summary */
export interface SyncResult {
  /**
   * Set only by the single-write create/capture job wrappers, where the job
   * result is what a caller reads to learn whether their write succeeded. A
   * broad `gno update` writes nothing of its own and leaves this absent.
   */
  written?: WrittenPathHandle;
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
  maxBytes: number
): WalkConfig {
  const transcriptFormat = collection.recordAdapters?.transcript?.format;
  return {
    root: collection.path,
    pattern: collection.pattern,
    include: collection.include,
    additionalDefaultExtensions: transcriptFormat
      ? [TRANSCRIPT_EXTENSION_BY_FORMAT[transcriptFormat]]
      : [],
    exclude: collection.exclude,
    maxBytes,
  };
}
