/** Versioned types and bounds for deterministic knowledge integrity audits. */

import type { StorePort } from "../store/types";

// ─────────────────────────────────────────────────────────────────────────────
// Versions & bounds
// ─────────────────────────────────────────────────────────────────────────────

export const AUDIT_SCHEMA_VERSION = "1.0" as const;
export const AUDIT_RULE_SET_VERSION = "1.0" as const;

/** Default returned finding cap; totals remain exact when truncated. */
export const AUDIT_DEFAULT_MAX_FINDINGS = 100;
/** Hard upper bound for `--max-findings` / MCP maxFindings. */
export const AUDIT_MAX_FINDINGS_LIMIT = 1000;
export const AUDIT_MAX_EVIDENCE_PER_FINDING = 8;
export const AUDIT_MAX_GUIDANCE_PER_FINDING = 4;
export const AUDIT_MAX_EVIDENCE_DETAIL_CHARS = 512;
export const AUDIT_MAX_MESSAGE_CHARS = 512;
export const AUDIT_MAX_GUIDANCE_CHARS = 256;
export const AUDIT_MAX_CODE_CHARS = 128;
export const AUDIT_MAX_IDENTIFIER_CHARS = 2048;
export const AUDIT_MAX_SCOPE_ITEMS = 256;
export const AUDIT_MAX_SCOPE_VALUE_CHARS = 256;
/** Bounded snapshot retries before `changed_during_audit`. */
export const AUDIT_MAX_SNAPSHOT_ATTEMPTS = 2;

export const AUDIT_CATEGORIES = ["links", "provenance", "freshness"] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export const AUDIT_RULE_STATUSES = [
  "pass",
  "fail",
  "skip",
  "unavailable",
  "inconclusive",
] as const;
export type AuditRuleStatus = (typeof AUDIT_RULE_STATUSES)[number];

export const AUDIT_REPORT_STATUSES = [
  "complete",
  "partial",
  "changed_during_audit",
  "failed",
] as const;
export type AuditReportStatus = (typeof AUDIT_REPORT_STATUSES)[number];

export const AUDIT_EXIT_KINDS = [
  "clean",
  "findings",
  "invalid",
  "partial",
  "runtime",
] as const;
export type AuditExitKind = (typeof AUDIT_EXIT_KINDS)[number];

/**
 * Process exit codes for `gno audit` / MCP surfaces.
 * 0/1/2 align with global SUCCESS/VALIDATION/RUNTIME; 4/5 are audit-specific.
 */
export const AUDIT_EXIT_CODES = {
  clean: 0,
  invalid: 1,
  runtime: 2,
  findings: 4,
  partial: 5,
} as const satisfies Record<AuditExitKind, number>;

export type AuditFindingSeverity = "error" | "warning" | "info";

// ─────────────────────────────────────────────────────────────────────────────
// No-write port boundary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read-only store methods permitted for audit snapshot/rule evaluation.
 * Category tasks may narrow further; mutating StorePort methods are forbidden.
 */
export type AuditReadStorePort = Pick<
  StorePort,
  | "getActivationIndexSnapshot"
  | "getCollections"
  | "getStatus"
  | "listDocuments"
  | "listDocumentsPaginated"
  | "getDocumentsByDocids"
  | "getChunksBatch"
  | "getContentBatch"
>;

/** Mutating StorePort method names that audits must never invoke. */
export const AUDIT_FORBIDDEN_STORE_METHODS = [
  "upsertDocument",
  "deactivateDocument",
  "deleteDocument",
  "upsertChunks",
  "deleteChunks",
  "recordError",
  "upsertActivationReceipt",
  "createRetrievalTrace",
  "withTransaction",
  "syncCollections",
  "cleanup",
] as const;

export type AuditForbiddenStoreMethod =
  (typeof AUDIT_FORBIDDEN_STORE_METHODS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Report / finding shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditScope {
  /** Categories requested for this run. Empty means all categories. */
  categories: AuditCategory[];
  collections: string[];
  /** Optional path/prefix filters (normalized, sorted). */
  paths: string[];
  /** Optional tag filters (normalized, sorted). */
  tags: string[];
  indexName: string;
}

export interface AuditCapabilitySnapshot {
  indexReadable: boolean;
  sourcesReadable: boolean;
  linksGraphAvailable: boolean;
  provenanceSchemaAvailable: boolean;
  offline: true;
  llmDisabled: true;
}

export interface AuditFingerprints {
  /** Canonical config / rule-input fingerprint. */
  config: string;
  /** Source tree revision evidence fingerprint. */
  source: string;
  /** Index revision evidence fingerprint. */
  index: string;
  /** Active rule-set identity fingerprint. */
  rules: string;
}

export interface AuditEvidence {
  kind: string;
  summary: string;
  uri?: string;
  path?: string;
  detail?: string;
}

export interface AuditFinding {
  /** Stable SHA-256 identity; survives traversal order. */
  id: string;
  ruleId: string;
  category: AuditCategory;
  severity: AuditFindingSeverity;
  /** Normalized subject (typically gno:// URI or collection-relative path). */
  subject: string;
  /** Normalized location within the subject, or null. */
  location: string | null;
  message: string;
  evidence: AuditEvidence[];
  guidance: string[];
  evidenceFingerprint: string;
}

export interface AuditRuleResult {
  ruleId: string;
  category: AuditCategory;
  status: AuditRuleStatus;
  message: string;
  findings: AuditFinding[];
  /** Exact findings before the bounded per-rule payload. */
  findingCount: number;
  examinedCount: number;
  durationMs: number;
  skipReason: string | null;
}

export interface AuditCounts {
  rules: {
    pass: number;
    fail: number;
    skip: number;
    unavailable: number;
    inconclusive: number;
    total: number;
  };
  findings: {
    /** Exact total before return-cap truncation. */
    total: number;
    /** Findings included in the report payload. */
    returned: number;
    truncated: boolean;
  };
  examined: {
    documents: number;
  };
}

export interface AuditTruncation {
  findingsTruncated: boolean;
  maxFindings: number;
}

export interface AuditTiming {
  snapshotMs: number;
  rulesMs: number;
  totalMs: number;
}

export interface AuditVersions {
  gno: string;
  schema: typeof AUDIT_SCHEMA_VERSION;
  ruleSet: typeof AUDIT_RULE_SET_VERSION;
}

export interface AuditReport {
  schemaVersion: typeof AUDIT_SCHEMA_VERSION;
  ruleSetVersion: typeof AUDIT_RULE_SET_VERSION;
  status: AuditReportStatus;
  scope: AuditScope;
  capabilities: AuditCapabilitySnapshot;
  fingerprints: AuditFingerprints;
  versions: AuditVersions;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  rules: AuditRuleResult[];
  findings: AuditFinding[];
  counts: AuditCounts;
  truncation: AuditTruncation;
  timing: AuditTiming;
}

// ─────────────────────────────────────────────────────────────────────────────
// Draft / evaluator contracts (category rules plug in later)
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditFindingDraft {
  subject: string;
  location?: string | null;
  severity: AuditFindingSeverity;
  message: string;
  evidence: AuditEvidence[];
  guidance?: string[];
}

export interface AuditRuleContribution {
  ruleId: string;
  category: AuditCategory;
  status: AuditRuleStatus;
  message: string;
  findings?: AuditFindingDraft[];
  /** Exact findings before any evaluator-side payload cap. */
  findingCount?: number;
  examinedCount?: number;
  durationMs?: number;
  skipReason?: string | null;
}

export interface AuditRuleContext {
  scope: AuditScope;
  capabilities: AuditCapabilitySnapshot;
  fingerprints: AuditFingerprints;
  attempt: number;
}

export type AuditRuleEvaluator = (
  ctx: AuditRuleContext
) =>
  | AuditRuleContribution
  | AuditRuleContribution[]
  | Promise<AuditRuleContribution | AuditRuleContribution[]>;

export interface AuditFingerprintCapture {
  (): AuditFingerprints | Promise<AuditFingerprints>;
}

export interface AuditRunInput {
  scope: AuditScope;
  capabilities: AuditCapabilitySnapshot;
  captureFingerprints: AuditFingerprintCapture;
  rules: readonly AuditRuleEvaluator[];
  maxFindings?: number;
  maxAttempts?: number;
  gnoVersion?: string;
  clock?: () => Date;
  monotonicNow?: () => number;
  signal?: AbortSignal;
}

export type AuditRunResult =
  | { ok: true; report: AuditReport; exit: AuditExitKind }
  | { ok: false; exit: "invalid"; error: string };
