import type { TypedMetadata } from "../core/typed-metadata";
/**
 * Converter subsystem types.
 * PRD §8.2 - Converter interfaces
 */

export type ConverterId = string;

export interface ConvertInput {
  /** Absolute path to source file */
  sourcePath: string;
  /** Relative path within collection */
  relativePath: string;
  /** Collection name */
  collection: string;
  /** File contents */
  bytes: Uint8Array;
  /** Detected MIME type */
  mime: string;
  /** File extension (e.g., ".pdf") */
  ext: string;
  /** Conversion limits */
  limits: {
    /** Max file size in bytes (default: 100MB) */
    maxBytes: number;
    /** Conversion timeout in ms (default: 60000) */
    timeoutMs: number;
    /** Max output chars after conversion (zip bomb protection, default: 50M) */
    maxOutputChars?: number;
  };
}

export interface ConvertWarning {
  code:
    | "LOSSY"
    | "TRUNCATED"
    | "PARTIAL"
    | "UNSUPPORTED_FEATURE"
    | "LOW_CONFIDENCE";
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Raw output from individual converters.
 * Note: markdown is NOT canonical - pipeline.ts handles normalization.
 */
export interface ConvertOutput {
  /** Raw markdown (pipeline canonicalizes) */
  markdown: string;
  /** Extracted or derived title */
  title?: string;
  /** BCP-47 language hint or "und" */
  languageHint?: string;
  /** Conversion metadata */
  meta: {
    converterId: ConverterId;
    converterVersion: string;
    sourceMime: string;
    warnings?: ConvertWarning[];
  };
}

export type ConvertErrorCode =
  | "UNSUPPORTED"
  | "TOO_LARGE"
  | "TIMEOUT"
  | "CORRUPT"
  | "PERMISSION"
  | "IO"
  | "ADAPTER_FAILURE"
  | "INTERNAL";

export interface ConvertError {
  code: ConvertErrorCode;
  message: string;
  retryable: boolean;
  fatal: boolean;
  converterId: string;
  sourcePath: string;
  mime: string;
  ext: string;
  cause?: unknown;
  details?: Record<string, unknown>;
}

export type ConvertResult =
  | { ok: true; value: ConvertOutput }
  | { ok: false; error: ConvertError };

export interface Converter {
  readonly id: ConverterId;
  readonly version: string;
  canHandle(mime: string, ext: string): boolean;
  convert(input: ConvertInput): Promise<ConvertResult>;
}

/** Declarative limits applied to every multi-record container adapter. */
export interface RecordAdapterLimits {
  /** End-to-end adapter deadline; production callers always set it. */
  timeoutMs?: number;
  /** Maximum bytes an adapter may read from the container source. */
  maxSourceBytes: number;
  /** Maximum canonical characters accepted for one logical record. */
  maxRecordChars: number;
  /** Maximum canonical metadata characters accepted for one logical record. */
  maxMetadataChars: number;
  /** Maximum canonical characters retained across the whole snapshot. */
  maxTotalChars: number;
  /** Maximum logical records retained from one snapshot. */
  maxRecords: number;
  /** Maximum isolated failures retained before consumption stops. */
  maxFailures: number;
}

/** Input for a streaming adapter. The opener is wrapped with the source cap. */
export interface RecordAdapterInput {
  sourcePath: string;
  relativePath: string;
  collection: string;
  mime: string;
  ext: string;
  open: (signal?: AbortSignal) => AsyncIterable<Uint8Array>;
  signal?: AbortSignal;
  limits: RecordAdapterLimits;
}

export interface RecordAnchor {
  kind: "line" | "cue" | "timestamp" | "message" | "event" | "record";
  value: string;
  endValue?: string;
}

export interface RecordAttachmentInventoryItem {
  name: string;
  mime?: string;
  bytes?: number;
  disposition?: "inline" | "attachment";
  sha256?: string;
}

/** Closed per-field limits shared by ingestion and versioned output schemas. */
export const RECORD_METADATA_LIMITS = {
  maxItems: 256,
  maxAdapterIdChars: 128,
  maxAdapterVersionChars: 64,
  maxTitleChars: 2048,
  maxPersonChars: 2048,
  maxCategoryChars: 512,
  maxIdentifierChars: 2048,
  maxDateFieldKeyChars: 128,
  maxDateFieldValueChars: 256,
  maxAttachmentNameChars: 512,
  maxAttachmentMimeChars: 256,
  maxAnchorChars: 512,
  maxLanguageHintChars: 64,
} as const;

/** Metadata shared by export adapters and later search/get projections. */
export interface RecordMetadata {
  custom?: TypedMetadata;
  /** Derived validation diagnostic; adapters do not set this field. */
  customError?: string;
  author?: string;
  participants?: string[];
  categories?: string[];
  dateFields?: Record<string, string>;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  threadId?: string;
  eventId?: string;
  sessionId?: string;
  attachments?: RecordAttachmentInventoryItem[];
}

/** One raw logical record yielded by a container adapter. */
export interface RecordAdapterRecord {
  stableId: string;
  sourceLocator: string;
  markdown: string;
  /** Optional exact source-item hash. Derived deterministically when omitted. */
  sourceHash?: string;
  title?: string;
  languageHint?: string;
  metadata?: RecordMetadata;
  anchors?: RecordAnchor[];
}

export type RecordAdapterFailureCode =
  | "MALFORMED_RECORD"
  | "MISSING_ID"
  | "DUPLICATE_ID"
  | "RECORD_TOO_LARGE"
  | "SOURCE_TOO_LARGE"
  | "TIMEOUT"
  | "RECORD_LIMIT"
  | "FAILURE_LIMIT"
  | "INVALID_LOCATOR"
  | "INVALID_SOURCE_HASH"
  | "ADAPTER_FAILURE"
  | "INVALID_SNAPSHOT";

export interface RecordAdapterFailure {
  code: RecordAdapterFailureCode;
  message: string;
  retryable: boolean;
  stableId?: string;
  sourceLocator?: string;
}

export type RecordAdapterEvent =
  | { type: "record"; record: RecordAdapterRecord }
  | { type: "failure"; failure: RecordAdapterFailure }
  | { type: "snapshot"; state: "complete" | "partial" };

/** Separate lane from one-file converters so byte-oriented behavior is stable. */
export interface RecordAdapter {
  readonly id: string;
  readonly version: string;
  /** Stable fingerprint of declarative adapter configuration, when present. */
  readonly configurationFingerprint?: string;
  canHandle(mime: string, ext: string): boolean;
  records(input: RecordAdapterInput): AsyncIterable<RecordAdapterEvent>;
}

/**
 * Pipeline output after canonicalization and hash computation.
 * This is what consumers receive from the conversion pipeline.
 */
export interface ConversionArtifact {
  /** Canonical markdown after pipeline normalization */
  markdown: string;
  /** SHA-256 hex of canonical markdown - content-addressed key */
  mirrorHash: string;
  /** Title from conversion (or derived from filename) */
  title?: string;
  /** Language hint from conversion */
  languageHint?: string;
  /** Conversion metadata */
  meta: ConvertOutput["meta"];
}

export type PipelineResult =
  | { ok: true; value: ConversionArtifact }
  | { ok: false; error: ConvertError };

/** Default conversion limits */
export const DEFAULT_LIMITS = {
  maxBytes: 100 * 1024 * 1024, // 100MB
  timeoutMs: 60_000, // 60 seconds
  maxOutputChars: 50_000_000, // 50M chars (zip bomb protection)
} as const;

export const DEFAULT_RECORD_ADAPTER_LIMITS: RecordAdapterLimits = {
  timeoutMs: 60_000,
  maxSourceBytes: 100 * 1024 * 1024,
  maxRecordChars: 2_000_000,
  maxMetadataChars: 100_000,
  maxTotalChars: 50_000_000,
  maxRecords: 100_000,
  maxFailures: 1_000,
};
