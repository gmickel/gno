/**
 * Deterministic read-only knowledge integrity audit contract.
 *
 * Freezes report/finding schemas, stable identity, status/exit taxonomy,
 * snapshot consistency, and the no-write port boundary. Category rules and
 * CLI/MCP registration are intentionally out of scope for this module.
 *
 * Distinct from content-free egress audit receipts (`egress-audit.ts`).
 *
 * @module src/core/audit
 */

import type { StorePort } from "../store/types";

import { VERSION } from "../app/constants";

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
}

export type AuditRunResult =
  | { ok: true; report: AuditReport; exit: AuditExitKind }
  | { ok: false; exit: "invalid"; error: string };

// ─────────────────────────────────────────────────────────────────────────────
// Canonicalization & stable IDs
// ─────────────────────────────────────────────────────────────────────────────

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

type CanonicalJson =
  | boolean
  | null
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

const canonicalizeJsonValue = (value: unknown): CanonicalJson => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Canonical JSON rejects non-finite numbers");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJsonValue(item));
  }
  if (typeof value === "object") {
    const sorted: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(value).sort(compareCodeUnits)) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) {
        throw new Error(`Canonical JSON rejects undefined at ${key}`);
      }
      sorted[key] = canonicalizeJsonValue(child);
    }
    return sorted;
  }
  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
};

/** Key-sorted JSON used for identity hashes and semantic equality. */
export const canonicalAuditJson = (value: unknown): string =>
  JSON.stringify(canonicalizeJsonValue(value));

export const hashAuditCanonical = (value: unknown): string =>
  new Bun.CryptoHasher("sha256")
    .update(canonicalAuditJson(value))
    .digest("hex");

export const normalizeAuditText = (value: string): string =>
  value.normalize("NFC").trim();

const boundText = (value: string, maxChars: number): string => {
  const normalized = normalizeAuditText(value);
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars);
};

const boundEvidence = (evidence: readonly AuditEvidence[]): AuditEvidence[] => {
  const bounded: AuditEvidence[] = [];
  for (const item of evidence.slice(0, AUDIT_MAX_EVIDENCE_PER_FINDING)) {
    const next: AuditEvidence = {
      kind: normalizeAuditText(item.kind),
      summary: boundText(item.summary, AUDIT_MAX_MESSAGE_CHARS),
    };
    if (item.uri !== undefined) {
      next.uri = normalizeAuditText(item.uri);
    }
    if (item.path !== undefined) {
      next.path = normalizeAuditText(item.path);
    }
    if (item.detail !== undefined) {
      next.detail = boundText(item.detail, AUDIT_MAX_EVIDENCE_DETAIL_CHARS);
    }
    bounded.push(next);
  }
  return bounded.sort((left, right) => {
    const byKind = compareCodeUnits(left.kind, right.kind);
    if (byKind !== 0) return byKind;
    const bySummary = compareCodeUnits(left.summary, right.summary);
    if (bySummary !== 0) return bySummary;
    return compareCodeUnits(
      canonicalAuditJson(left),
      canonicalAuditJson(right)
    );
  });
};

const boundGuidance = (guidance: readonly string[] | undefined): string[] => {
  if (!guidance || guidance.length === 0) return [];
  return guidance
    .slice(0, AUDIT_MAX_GUIDANCE_PER_FINDING)
    .map((item) => boundText(item, AUDIT_MAX_GUIDANCE_CHARS))
    .sort(compareCodeUnits);
};

export const fingerprintAuditEvidence = (
  evidence: readonly AuditEvidence[]
): string => hashAuditCanonical(boundEvidence(evidence));

/**
 * Stable finding identity from rule + normalized subject/location + evidence.
 * Wall-clock timing is intentionally excluded.
 */
export const buildAuditFindingId = (input: {
  ruleId: string;
  subject: string;
  location: string | null;
  evidenceFingerprint: string;
}): string =>
  hashAuditCanonical({
    evidenceFingerprint: input.evidenceFingerprint,
    location: input.location,
    ruleId: normalizeAuditText(input.ruleId),
    subject: normalizeAuditText(input.subject),
  });

export const materializeAuditFinding = (
  ruleId: string,
  category: AuditCategory,
  draft: AuditFindingDraft
): AuditFinding => {
  const subject = normalizeAuditText(draft.subject);
  const location =
    draft.location === undefined || draft.location === null
      ? null
      : normalizeAuditText(draft.location);
  const evidence = boundEvidence(draft.evidence);
  const evidenceFingerprint = fingerprintAuditEvidence(evidence);
  return {
    id: buildAuditFindingId({
      ruleId,
      subject,
      location,
      evidenceFingerprint,
    }),
    ruleId: normalizeAuditText(ruleId),
    category,
    severity: draft.severity,
    subject,
    location,
    message: boundText(draft.message, AUDIT_MAX_MESSAGE_CHARS),
    evidence,
    guidance: boundGuidance(draft.guidance),
    evidenceFingerprint,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Ordering, counts, exit taxonomy
// ─────────────────────────────────────────────────────────────────────────────

const categoryRank = (category: AuditCategory): number =>
  AUDIT_CATEGORIES.indexOf(category);

export const compareAuditFindings = (
  left: AuditFinding,
  right: AuditFinding
): number => {
  const byCategory = categoryRank(left.category) - categoryRank(right.category);
  if (byCategory !== 0) return byCategory;
  const byRule = compareCodeUnits(left.ruleId, right.ruleId);
  if (byRule !== 0) return byRule;
  const bySubject = compareCodeUnits(left.subject, right.subject);
  if (bySubject !== 0) return bySubject;
  const leftLocation = left.location ?? "";
  const rightLocation = right.location ?? "";
  const byLocation = compareCodeUnits(leftLocation, rightLocation);
  if (byLocation !== 0) return byLocation;
  return compareCodeUnits(left.id, right.id);
};

export const compareAuditRules = (
  left: AuditRuleResult,
  right: AuditRuleResult
): number => {
  const byCategory = categoryRank(left.category) - categoryRank(right.category);
  if (byCategory !== 0) return byCategory;
  const byRule = compareCodeUnits(left.ruleId, right.ruleId);
  if (byRule !== 0) return byRule;
  const semanticRule = ({
    durationMs: _durationMs,
    ...rule
  }: AuditRuleResult) => canonicalAuditJson(rule);
  return compareCodeUnits(semanticRule(left), semanticRule(right));
};

const emptyRuleCounts = (): AuditCounts["rules"] => ({
  pass: 0,
  fail: 0,
  skip: 0,
  unavailable: 0,
  inconclusive: 0,
  total: 0,
});

export const tallyAuditRuleCounts = (
  rules: readonly AuditRuleResult[]
): AuditCounts["rules"] => {
  const counts = emptyRuleCounts();
  for (const rule of rules) {
    counts[rule.status] += 1;
    counts.total += 1;
  }
  return counts;
};

/**
 * Derive report status from rule outcomes and snapshot consistency.
 * Unavailable/inconclusive evidence can never yield a clean complete report.
 */
export const deriveAuditReportStatus = (input: {
  rules: readonly AuditRuleResult[];
  snapshotChanged: boolean;
  failed?: boolean;
}): AuditReportStatus => {
  if (input.failed) return "failed";
  if (input.snapshotChanged) return "changed_during_audit";
  const hasHonestGap = input.rules.some(
    (rule) => rule.status === "unavailable" || rule.status === "inconclusive"
  );
  if (hasHonestGap) return "partial";
  return "complete";
};

/**
 * Map a finished report to the frozen exit taxonomy.
 * Clean requires complete status and zero fail findings.
 */
export const deriveAuditExitKind = (report: AuditReport): AuditExitKind => {
  if (report.status === "failed") return "runtime";
  if (report.status === "partial" || report.status === "changed_during_audit") {
    return "partial";
  }
  const hasFailFindings = report.findings.some(
    (finding) => finding.severity === "error" || finding.severity === "warning"
  );
  const hasFailRules = report.rules.some((rule) => rule.status === "fail");
  if (hasFailFindings || hasFailRules) return "findings";
  return "clean";
};

export const auditExitCode = (kind: AuditExitKind): number =>
  AUDIT_EXIT_CODES[kind];

/**
 * Semantic projection for equality: identical snapshots must match regardless
 * of wall-clock timing and per-rule duration noise.
 */
export const auditSemanticProjection = (report: AuditReport): CanonicalJson => {
  const {
    startedAt: _s,
    completedAt: _c,
    durationMs: _d,
    timing: _t,
    ...rest
  } = report;
  return canonicalizeJsonValue({
    ...rest,
    rules: report.rules.map(({ durationMs: _durationMs, ...rule }) => rule),
  });
};

export const serializeAuditReportSemantic = (report: AuditReport): string =>
  canonicalAuditJson(auditSemanticProjection(report));

export const serializeAuditReportCanonical = (report: AuditReport): string =>
  canonicalAuditJson(report);

// ─────────────────────────────────────────────────────────────────────────────
// Scope / input validation
// ─────────────────────────────────────────────────────────────────────────────

const isAuditCategory = (value: string): value is AuditCategory =>
  (AUDIT_CATEGORIES as readonly string[]).includes(value);

export const normalizeAuditScope = (
  scope: AuditScope
): { ok: true; scope: AuditScope } | { ok: false; error: string } => {
  const indexName = normalizeAuditText(scope.indexName);
  if (indexName.length < 1) {
    return { ok: false, error: "indexName is required" };
  }

  const categories =
    scope.categories.length === 0
      ? [...AUDIT_CATEGORIES]
      : [...new Set(scope.categories.map((item) => normalizeAuditText(item)))];
  for (const category of categories) {
    if (!isAuditCategory(category)) {
      return { ok: false, error: `unknown audit category: ${category}` };
    }
  }
  categories.sort(
    (left, right) =>
      categoryRank(left as AuditCategory) - categoryRank(right as AuditCategory)
  );

  const collections = [
    ...new Set(scope.collections.map((item) => normalizeAuditText(item))),
  ]
    .filter((item) => item.length > 0)
    .sort(compareCodeUnits);
  const paths = [
    ...new Set(scope.paths.map((item) => normalizeAuditText(item))),
  ]
    .filter((item) => item.length > 0)
    .sort(compareCodeUnits);
  const tags = [...new Set(scope.tags.map((item) => normalizeAuditText(item)))]
    .filter((item) => item.length > 0)
    .sort(compareCodeUnits);

  return {
    ok: true,
    scope: {
      categories: categories as AuditCategory[],
      collections,
      paths,
      tags,
      indexName,
    },
  };
};

const resolveMaxFindings = (
  value: number | undefined
): { ok: true; maxFindings: number } | { ok: false; error: string } => {
  const maxFindings = value ?? AUDIT_DEFAULT_MAX_FINDINGS;
  if (
    !Number.isSafeInteger(maxFindings) ||
    maxFindings < 1 ||
    maxFindings > AUDIT_MAX_FINDINGS_LIMIT
  ) {
    return {
      ok: false,
      error: `maxFindings must be an integer between 1 and ${AUDIT_MAX_FINDINGS_LIMIT}`,
    };
  }
  return { ok: true, maxFindings };
};

const fingerprintsEqual = (
  left: AuditFingerprints,
  right: AuditFingerprints
): boolean =>
  left.config === right.config &&
  left.source === right.source &&
  left.index === right.index &&
  left.rules === right.rules;

const normalizeFingerprints = (
  fingerprints: AuditFingerprints
): AuditFingerprints => ({
  config: normalizeAuditText(fingerprints.config),
  source: normalizeAuditText(fingerprints.source),
  index: normalizeAuditText(fingerprints.index),
  rules: normalizeAuditText(fingerprints.rules),
});

const defaultCapabilities = (
  capabilities: AuditCapabilitySnapshot
): AuditCapabilitySnapshot => ({
  ...capabilities,
  offline: true,
  llmDisabled: true,
});

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────

const materializeRule = (
  contribution: AuditRuleContribution
): AuditRuleResult => {
  const findings = (contribution.findings ?? [])
    .map((draft) =>
      materializeAuditFinding(contribution.ruleId, contribution.category, draft)
    )
    .sort(compareAuditFindings);

  let status = contribution.status;
  if (findings.length > 0 && status === "pass") {
    status = "fail";
  }

  return {
    ruleId: normalizeAuditText(contribution.ruleId),
    category: contribution.category,
    status,
    message: boundText(contribution.message, AUDIT_MAX_MESSAGE_CHARS),
    findings,
    examinedCount: Math.max(0, contribution.examinedCount ?? 0),
    durationMs: Math.max(0, Math.round(contribution.durationMs ?? 0)),
    skipReason:
      contribution.skipReason === undefined || contribution.skipReason === null
        ? null
        : boundText(contribution.skipReason, AUDIT_MAX_MESSAGE_CHARS),
  };
};

const collectContributions = async (
  evaluators: readonly AuditRuleEvaluator[],
  ctx: AuditRuleContext
): Promise<AuditRuleContribution[]> => {
  const collected: AuditRuleContribution[] = [];
  for (const evaluator of evaluators) {
    const result = await evaluator(ctx);
    if (Array.isArray(result)) {
      collected.push(...result);
    } else {
      collected.push(result);
    }
  }
  return collected;
};

const buildReportFromRules = (input: {
  scope: AuditScope;
  capabilities: AuditCapabilitySnapshot;
  fingerprints: AuditFingerprints;
  versions: AuditVersions;
  rules: AuditRuleResult[];
  status: AuditReportStatus;
  maxFindings: number;
  startedAt: string;
  completedAt: string;
  snapshotMs: number;
  rulesMs: number;
  totalMs: number;
}): AuditReport => {
  const rules = [...input.rules].sort(compareAuditRules).map((rule) => ({
    ...rule,
    findings: [...rule.findings].sort(compareAuditFindings),
  }));

  const allFindings = rules
    .flatMap((rule) => rule.findings)
    .sort(compareAuditFindings);
  // Deduplicate by stable id while preserving canonical order.
  const seen = new Set<string>();
  const uniqueFindings: AuditFinding[] = [];
  for (const finding of allFindings) {
    if (seen.has(finding.id)) continue;
    seen.add(finding.id);
    uniqueFindings.push(finding);
  }

  const truncated = uniqueFindings.length > input.maxFindings;
  const returnedFindings = truncated
    ? uniqueFindings.slice(0, input.maxFindings)
    : uniqueFindings;

  const examinedDocuments = rules.reduce(
    (sum, rule) => sum + rule.examinedCount,
    0
  );

  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    ruleSetVersion: AUDIT_RULE_SET_VERSION,
    status: input.status,
    scope: input.scope,
    capabilities: input.capabilities,
    fingerprints: input.fingerprints,
    versions: input.versions,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: Math.max(0, Math.round(input.totalMs)),
    rules,
    findings: returnedFindings,
    counts: {
      rules: tallyAuditRuleCounts(rules),
      findings: {
        total: uniqueFindings.length,
        returned: returnedFindings.length,
        truncated,
      },
      examined: {
        documents: examinedDocuments,
      },
    },
    truncation: {
      findingsTruncated: truncated,
      maxFindings: input.maxFindings,
    },
    timing: {
      snapshotMs: Math.max(0, Math.round(input.snapshotMs)),
      rulesMs: Math.max(0, Math.round(input.rulesMs)),
      totalMs: Math.max(0, Math.round(input.totalMs)),
    },
  };
};

/**
 * Run the read-only audit runner against injected rule evaluators.
 * Snapshots fingerprints before and after rule evaluation; mid-run changes
 * retry up to `maxAttempts` and otherwise yield `changed_during_audit` —
 * never a clean report.
 */
export async function runAudit(input: AuditRunInput): Promise<AuditRunResult> {
  const scopeResult = normalizeAuditScope(input.scope);
  if (!scopeResult.ok) {
    return { ok: false, exit: "invalid", error: scopeResult.error };
  }
  const maxFindingsResult = resolveMaxFindings(input.maxFindings);
  if (!maxFindingsResult.ok) {
    return { ok: false, exit: "invalid", error: maxFindingsResult.error };
  }

  const maxAttempts = Math.max(
    1,
    Math.min(
      input.maxAttempts ?? AUDIT_MAX_SNAPSHOT_ATTEMPTS,
      AUDIT_MAX_SNAPSHOT_ATTEMPTS
    )
  );
  const clock = input.clock ?? (() => new Date());
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  const capabilities = defaultCapabilities(input.capabilities);
  const versions: AuditVersions = {
    gno: input.gnoVersion ?? VERSION,
    schema: AUDIT_SCHEMA_VERSION,
    ruleSet: AUDIT_RULE_SET_VERSION,
  };

  const runStartedAt = clock();
  const runStartedMs = monotonicNow();
  let snapshotMs = 0;
  let rulesMs = 0;
  let lastRules: AuditRuleResult[] = [];
  let lastFingerprints: AuditFingerprints | null = null;
  let snapshotChanged = false;
  let failed = false;
  let failureMessage = "Audit failed";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const snapshotStarted = monotonicNow();
    let before: AuditFingerprints;
    try {
      before = normalizeFingerprints(await input.captureFingerprints());
    } catch (cause) {
      failed = true;
      failureMessage =
        cause instanceof Error
          ? cause.message
          : "Failed to capture audit fingerprints";
      break;
    }
    snapshotMs += Math.max(0, monotonicNow() - snapshotStarted);
    lastFingerprints = before;

    const ruleCtx: AuditRuleContext = {
      scope: scopeResult.scope,
      capabilities,
      fingerprints: before,
      attempt,
    };

    const rulesStarted = monotonicNow();
    try {
      const contributions = await collectContributions(input.rules, ruleCtx);
      lastRules = contributions.map(materializeRule);
    } catch (cause) {
      failed = true;
      failureMessage =
        cause instanceof Error ? cause.message : "Audit rule evaluation failed";
      break;
    }
    rulesMs += Math.max(0, monotonicNow() - rulesStarted);

    const afterStarted = monotonicNow();
    let after: AuditFingerprints;
    try {
      after = normalizeFingerprints(await input.captureFingerprints());
    } catch (cause) {
      failed = true;
      failureMessage =
        cause instanceof Error
          ? cause.message
          : "Failed to re-capture audit fingerprints";
      break;
    }
    snapshotMs += Math.max(0, monotonicNow() - afterStarted);

    if (fingerprintsEqual(before, after)) {
      snapshotChanged = false;
      lastFingerprints = after;
      break;
    }

    snapshotChanged = true;
    lastFingerprints = after;
    if (attempt === maxAttempts) {
      break;
    }
    // Discard rule results from a drifted attempt; retry with a fresh snapshot.
    lastRules = [];
  }

  const completedAt = clock();
  const totalMs = Math.max(0, monotonicNow() - runStartedMs);
  const fingerprints = lastFingerprints ?? {
    config: "",
    source: "",
    index: "",
    rules: "",
  };

  if (failed) {
    const report = buildReportFromRules({
      scope: scopeResult.scope,
      capabilities,
      fingerprints,
      versions,
      rules: [
        {
          ruleId: "audit.runner",
          category: scopeResult.scope.categories[0] ?? "links",
          status: "unavailable",
          message: failureMessage,
          findings: [],
          examinedCount: 0,
          durationMs: 0,
          skipReason: failureMessage,
        },
      ],
      status: "failed",
      maxFindings: maxFindingsResult.maxFindings,
      startedAt: runStartedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      snapshotMs,
      rulesMs,
      totalMs,
    });
    return { ok: true, report, exit: deriveAuditExitKind(report) };
  }

  const status = deriveAuditReportStatus({
    rules: lastRules,
    snapshotChanged,
  });

  // Mid-run drift must never report clean, even if evaluators emitted no findings.
  const rulesForReport =
    status === "changed_during_audit" && lastRules.length === 0
      ? [
          {
            ruleId: "audit.snapshot",
            category: scopeResult.scope.categories[0] ?? "links",
            status: "inconclusive" as const,
            message:
              "Source or index fingerprints changed during audit; results are not authoritative",
            findings: [] as AuditFinding[],
            examinedCount: 0,
            durationMs: 0,
            skipReason: "changed_during_audit",
          },
        ]
      : lastRules;

  const report = buildReportFromRules({
    scope: scopeResult.scope,
    capabilities,
    fingerprints,
    versions,
    rules: rulesForReport,
    status:
      status === "changed_during_audit"
        ? "changed_during_audit"
        : deriveAuditReportStatus({
            rules: rulesForReport,
            snapshotChanged: false,
          }),
    maxFindings: maxFindingsResult.maxFindings,
    startedAt: runStartedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    snapshotMs,
    rulesMs,
    totalMs,
  });

  return { ok: true, report, exit: deriveAuditExitKind(report) };
}

/**
 * Assert a store-like object does not expose callable mutating methods used
 * by audits. Tests wrap ports to prove no writes occur during a run.
 */
export function createAuditWriteGuard<T extends object>(
  port: T,
  forbidden: readonly AuditForbiddenStoreMethod[] = AUDIT_FORBIDDEN_STORE_METHODS
): T & { readonly writeAttempts: readonly string[] } {
  const writeAttempts: string[] = [];
  const forbiddenMethods = new Set<string>(forbidden);
  return new Proxy(port, {
    get(target, property, receiver) {
      if (property === "writeAttempts") return writeAttempts;
      if (typeof property === "string" && forbiddenMethods.has(property)) {
        return (..._args: unknown[]) => {
          writeAttempts.push(property);
          throw new Error(
            `Audit must not call mutating store method ${property}`
          );
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as T & { readonly writeAttempts: readonly string[] };
}
