/**
 * Transport-neutral, versioned reference-safe rename/move contracts.
 *
 * Filesystem atomicity and post-commit index convergence are consecutive,
 * separate states — never one shared transaction. Destination-only edit spans
 * preserve aliases, labels, titles, fragments, queries, escaping, and encoding.
 *
 * @module src/core/file-refactor-contract
 */

export const FILE_REFACTOR_SCHEMA_VERSION = "1.0" as const;

/** Exact apply confirmation token — never inferred from free text. */
export const FILE_REFACTOR_APPLY_CONFIRMATION = "apply" as const;

export type FileRefactorOperation = "rename" | "move";

export type FileRefactorConflictPolicy = "fail";

export type FileRefactorReferenceKind =
  | "wiki"
  | "markdown"
  | "markdown_definition"
  | "opaque";

/**
 * Per-reference classification from a conservative impact preview.
 * Malformed is distinct from unsupported (recognized but unsafe to rewrite).
 */
export type FileRefactorReferenceClassification =
  | "rewriteable"
  | "unchanged"
  | "ambiguous"
  | "unsupported"
  | "malformed"
  | "invalid";

/**
 * Stable reason taxonomy for preview/apply diagnostics.
 * Codes are closed; surfaces must not invent ad-hoc strings.
 */
export const FILE_REFACTOR_REASON_CODES = [
  "ambiguous_resolution",
  "unsupported_syntax",
  "malformed_syntax",
  "stale_plan",
  "capability_denied",
  "occupied_target",
  "sync_pending",
  "cross_collection_unsupported",
  "unsafe_target",
  "external_destination",
  "code_fence_context",
  "inline_code_context",
  "html_context",
  "duplicate_basename_ambiguity",
  "unicode_normalization_mismatch",
  "destination_unchanged",
  "read_only_document",
  "relative_path_recalculated",
  "reference_definition_site",
  "filesystem_commit_failed",
  "rollback_recovery_required",
] as const;

export type FileRefactorReasonCode =
  (typeof FILE_REFACTOR_REASON_CODES)[number];

export type FileRefactorApplyStatus =
  | "applied"
  | "applied_with_sync_pending"
  | "conflict"
  | "stale_plan"
  | "unsupported"
  | "failed_rolled_back";

export type FileRefactorFilesystemState =
  | "committed"
  | "rolled_back"
  | "unchanged"
  | "recovery_required";

export type FileRefactorIndexConvergenceState =
  | "converged"
  | "pending"
  | "not_attempted"
  | "skipped";

/**
 * Minimal edit span: ONLY destination/path token content may change.
 * Alias, Markdown label, title, fragment, query, escaping, and encoding
 * outside this span must remain identical (UTF-16 code-unit slices).
 */
export interface FileRefactorDestinationSpan {
  coordinateSpace: "utf16_code_units";
  /** Inclusive start offset (UTF-16 code units) of destination token. */
  startOffset: number;
  /** Exclusive end offset (UTF-16 code units) of destination token. */
  endOffset: number;
  originalDestination: string;
  replacementDestination: string;
}

export interface FileRefactorDocumentRef {
  uri: string;
  relPath: string;
  collection: string;
}

export interface FileRefactorExaminedReference {
  documentUri: string;
  documentRelPath: string;
  kind: FileRefactorReferenceKind;
  classification: FileRefactorReferenceClassification;
  reasonCode?: FileRefactorReasonCode;
  /** Raw destination text before any rewrite (path portion only when known). */
  originalDestination?: string;
  proposedDestination?: string;
  /** Present only when classification is rewriteable. */
  edit?: FileRefactorDestinationSpan;
  startLine?: number;
  startCol?: number;
  endLine?: number;
  endCol?: number;
}

export interface FileRefactorAffectedDocument {
  uri: string;
  relPath: string;
  /** SHA-256 hex of full document UTF-8 content at plan time. */
  contentFingerprint: string;
  edits: FileRefactorDestinationSpan[];
  examined: FileRefactorExaminedReference[];
}

export interface FileRefactorPreconditions {
  sourceContentFingerprint: string;
  affectedContentFingerprints: Array<{
    uri: string;
    fingerprint: string;
  }>;
  /** Hex digest over the intended target path absence/occupancy check. */
  targetPathFingerprint: string;
}

/**
 * Explicit split between durable filesystem mutation and index refresh.
 * Never claim one transaction spans both.
 */
export interface FileRefactorMutationBoundary {
  filesystemCommit: "atomic_all_or_rollback";
  indexConvergence: "post_commit_separate";
  syncFailureDoesNotRollbackFilesystem: true;
}

export interface FileRefactorSafetySummary {
  rewriteableCount: number;
  unchangedCount: number;
  ambiguousCount: number;
  unsupportedCount: number;
  malformedCount: number;
  invalidCount: number;
  blockingReasonCodes: FileRefactorReasonCode[];
  warnings: string[];
  backlinkCount: number;
  wikiLinkCount: number;
  markdownLinkCount: number;
}

export interface FileRefactorPreviewPlan {
  schemaVersion: typeof FILE_REFACTOR_SCHEMA_VERSION;
  operation: FileRefactorOperation;
  conflictPolicy: FileRefactorConflictPolicy;
  source: FileRefactorDocumentRef;
  target: FileRefactorDocumentRef;
  affectedDocuments: FileRefactorAffectedDocument[];
  /** Deterministic ordered list of every examined reference (incl. opaque). */
  examinedReferences: FileRefactorExaminedReference[];
  preconditions: FileRefactorPreconditions;
  planDigest: string;
  safety: FileRefactorSafetySummary;
  canApply: boolean;
  mutationBoundary: FileRefactorMutationBoundary;
}

export interface FileRefactorApplyRequest {
  schemaVersion: typeof FILE_REFACTOR_SCHEMA_VERSION;
  planDigest: string;
  confirmation: typeof FILE_REFACTOR_APPLY_CONFIRMATION;
}

interface FileRefactorApplyResultBase {
  schemaVersion: typeof FILE_REFACTOR_SCHEMA_VERSION;
  planDigest: string;
  operation: FileRefactorOperation;
  source: FileRefactorDocumentRef;
  target: FileRefactorDocumentRef;
}

/** Content-free filesystem receipt — never embeds note bodies. */
export type FileRefactorApplyResult =
  | (FileRefactorApplyResultBase & {
      status: "applied";
      filesystem: { state: "committed"; recoveryJournalId?: string };
      indexConvergence: { state: "converged" };
    })
  | (FileRefactorApplyResultBase & {
      status: "applied_with_sync_pending";
      reasonCode: "sync_pending";
      filesystem: { state: "committed"; recoveryJournalId?: string };
      indexConvergence: {
        state: "pending";
        recoveryInstruction: string;
      };
    })
  | (FileRefactorApplyResultBase & {
      status: "conflict" | "stale_plan" | "unsupported";
      reasonCode: FileRefactorReasonCode;
      filesystem: { state: "unchanged"; recoveryJournalId?: string };
      indexConvergence: { state: "not_attempted" | "skipped" };
    })
  | (FileRefactorApplyResultBase & {
      status: "failed_rolled_back";
      reasonCode: FileRefactorReasonCode;
      filesystem: {
        state: "rolled_back" | "recovery_required";
        recoveryJournalId?: string;
      };
      indexConvergence: { state: "not_attempted" | "skipped" };
    });

export const FILE_REFACTOR_MUTATION_BOUNDARY: FileRefactorMutationBoundary = {
  filesystemCommit: "atomic_all_or_rollback",
  indexConvergence: "post_commit_separate",
  syncFailureDoesNotRollbackFilesystem: true,
};

const UTF8 = new TextEncoder();

/** SHA-256 hex fingerprint via Web Crypto (browser- and Bun-safe). */
export async function fingerprintUtf8Content(content: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", UTF8.encode(content))
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Ordinal UTF-16 code-unit comparison — locale/ICU/OS independent.
 * Uses `<`/`>` on JS strings (16-bit code units), not localeCompare.
 */
export function compareUtf16CodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Canonical serializer matching JSON transport semantics with sorted keys.
 * - Object keys with `undefined` values are omitted (like JSON.stringify).
 * - Array holes / `undefined` items serialize as `null`.
 * - Non-finite numbers, bigint, symbol, and function values are rejected.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) {
    throw new Error("stableStringify cannot serialize top-level undefined");
  }
  if (value === null) return "null";
  const valueType = typeof value;
  if (valueType === "boolean" || valueType === "string") {
    return JSON.stringify(value);
  }
  if (valueType === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("stableStringify rejects non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (
    valueType === "bigint" ||
    valueType === "symbol" ||
    valueType === "function"
  ) {
    throw new Error(`stableStringify rejects unsupported type: ${valueType}`);
  }
  if (valueType !== "object") {
    throw new Error(`stableStringify rejects unsupported type: ${valueType}`);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => (item === undefined ? "null" : stableStringify(item)))
      .join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareUtf16CodeUnits);
  const parts: string[] = [];
  for (const key of keys) {
    const entry = record[key];
    if (entry === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${stableStringify(entry)}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * Deterministic plan digest over material preview fields (excludes planDigest).
 * Ordering of examined references and affected documents must already be stable.
 */
export async function computeFileRefactorPlanDigest(
  plan: Omit<FileRefactorPreviewPlan, "planDigest">
): Promise<string> {
  return fingerprintUtf8Content(
    stableStringify({
      schemaVersion: plan.schemaVersion,
      operation: plan.operation,
      conflictPolicy: plan.conflictPolicy,
      source: plan.source,
      target: plan.target,
      affectedDocuments: plan.affectedDocuments,
      examinedReferences: plan.examinedReferences,
      preconditions: plan.preconditions,
      safety: plan.safety,
      canApply: plan.canApply,
      mutationBoundary: plan.mutationBoundary,
    })
  );
}

/** Compare references for deterministic plan ordering. */
export function compareExaminedReferences(
  left: FileRefactorExaminedReference,
  right: FileRefactorExaminedReference
): number {
  const byDoc = compareUtf16CodeUnits(
    left.documentRelPath,
    right.documentRelPath
  );
  if (byDoc !== 0) return byDoc;
  const leftLine = left.startLine ?? 0;
  const rightLine = right.startLine ?? 0;
  if (leftLine !== rightLine) return leftLine - rightLine;
  const leftCol = left.startCol ?? 0;
  const rightCol = right.startCol ?? 0;
  if (leftCol !== rightCol) return leftCol - rightCol;
  return compareUtf16CodeUnits(
    left.originalDestination ?? "",
    right.originalDestination ?? ""
  );
}

export function sortExaminedReferences(
  references: FileRefactorExaminedReference[]
): FileRefactorExaminedReference[] {
  return [...references].sort(compareExaminedReferences);
}

/**
 * Apply a destination-only span. Throws when the live slice does not match
 * originalDestination (stale span / wrong coordinate space).
 */
export function applyDestinationOnlyEdit(
  content: string,
  span: FileRefactorDestinationSpan
): string {
  if (span.coordinateSpace !== "utf16_code_units") {
    throw new Error("Unsupported coordinate space for destination edit");
  }
  if (span.endOffset < span.startOffset) {
    throw new Error("Invalid destination span offsets");
  }
  const actual = content.slice(span.startOffset, span.endOffset);
  if (actual !== span.originalDestination) {
    throw new Error(
      "Destination span does not match originalDestination (stale or misaligned)"
    );
  }
  return (
    content.slice(0, span.startOffset) +
    span.replacementDestination +
    content.slice(span.endOffset)
  );
}

/**
 * True when every UTF-16 code unit outside the destination span is unchanged.
 * Full-document UTF-8 fingerprints prove content changed; this proves only the
 * destination token content changed.
 */
export function isContentPreservedOutsideSpan(
  before: string,
  after: string,
  span: FileRefactorDestinationSpan
): boolean {
  const prefix = before.slice(0, span.startOffset);
  const suffix = before.slice(span.endOffset);
  const expected = prefix + span.replacementDestination + suffix;
  if (after !== expected) {
    return false;
  }
  return (
    after.slice(0, span.startOffset) === prefix &&
    after.slice(span.startOffset + span.replacementDestination.length) ===
      suffix
  );
}

/**
 * @deprecated Prefer {@link isContentPreservedOutsideSpan}. Alias retained for
 * import stability; compares UTF-16 code-unit slices, not UTF-8 bytes.
 */
export const isBytePreservedOutsideSpan = isContentPreservedOutsideSpan;

export function summarizeReferenceClassifications(
  references: FileRefactorExaminedReference[],
  warningSnapshot: {
    warnings?: string[];
    backlinks?: number;
    wikiLinks?: number;
    markdownLinks?: number;
  } = {}
): FileRefactorSafetySummary {
  const counts = {
    rewriteableCount: 0,
    unchangedCount: 0,
    ambiguousCount: 0,
    unsupportedCount: 0,
    malformedCount: 0,
    invalidCount: 0,
  };
  const blocking = new Set<FileRefactorReasonCode>();

  for (const reference of references) {
    switch (reference.classification) {
      case "rewriteable":
        counts.rewriteableCount += 1;
        break;
      case "unchanged":
        counts.unchangedCount += 1;
        break;
      case "ambiguous":
        counts.ambiguousCount += 1;
        if (reference.reasonCode) blocking.add(reference.reasonCode);
        else blocking.add("ambiguous_resolution");
        break;
      case "unsupported":
        counts.unsupportedCount += 1;
        if (reference.reasonCode) blocking.add(reference.reasonCode);
        else blocking.add("unsupported_syntax");
        break;
      case "malformed":
        counts.malformedCount += 1;
        if (reference.reasonCode) blocking.add(reference.reasonCode);
        else blocking.add("malformed_syntax");
        break;
      case "invalid":
        counts.invalidCount += 1;
        if (reference.reasonCode) blocking.add(reference.reasonCode);
        break;
    }
  }

  return {
    ...counts,
    blockingReasonCodes: [...blocking].sort(compareUtf16CodeUnits),
    warnings: warningSnapshot.warnings ?? [],
    backlinkCount: warningSnapshot.backlinks ?? 0,
    wikiLinkCount: warningSnapshot.wikiLinks ?? 0,
    markdownLinkCount: warningSnapshot.markdownLinks ?? 0,
  };
}

export function deriveCanApply(input: {
  safety: FileRefactorSafetySummary;
  sourceEditable: boolean;
  targetOccupied: boolean;
  sameCollection: boolean;
}): boolean {
  if (!input.sourceEditable) return false;
  if (!input.sameCollection) return false;
  if (input.targetOccupied) return false;
  if (input.safety.blockingReasonCodes.length > 0) return false;
  if (input.safety.ambiguousCount > 0) return false;
  if (input.safety.unsupportedCount > 0) return false;
  if (input.safety.malformedCount > 0) return false;
  if (input.safety.invalidCount > 0) return false;
  return true;
}
