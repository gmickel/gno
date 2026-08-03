/** Canonical finding identity, ordering, counts, and report serialization. */

import type {
  AuditCategory,
  AuditCounts,
  AuditEvidence,
  AuditExitKind,
  AuditFinding,
  AuditFindingDraft,
  AuditReport,
  AuditReportStatus,
  AuditRuleResult,
} from "./audit-contract";

import {
  AUDIT_CATEGORIES,
  AUDIT_EXIT_CODES,
  AUDIT_MAX_EVIDENCE_DETAIL_CHARS,
  AUDIT_MAX_EVIDENCE_PER_FINDING,
  AUDIT_MAX_GUIDANCE_CHARS,
  AUDIT_MAX_GUIDANCE_PER_FINDING,
  AUDIT_MAX_CODE_CHARS,
  AUDIT_MAX_IDENTIFIER_CHARS,
  AUDIT_MAX_MESSAGE_CHARS,
} from "./audit-contract";

// ─────────────────────────────────────────────────────────────────────────────
// Canonicalization & stable IDs
// ─────────────────────────────────────────────────────────────────────────────

export const compareAuditCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const compareAuditFindingDrafts = (
  left: AuditFindingDraft,
  right: AuditFindingDraft
): number =>
  compareAuditCodeUnits(left.subject, right.subject) ||
  compareAuditCodeUnits(left.location ?? "", right.location ?? "") ||
  compareAuditCodeUnits(left.message, right.message) ||
  compareAuditCodeUnits(
    JSON.stringify(left.evidence),
    JSON.stringify(right.evidence)
  );

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
    for (const key of Object.keys(value).sort(compareAuditCodeUnits)) {
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

export const boundAuditText = (value: string, maxChars: number): string => {
  const normalized = normalizeAuditText(value);
  const characters = Array.from(normalized);
  if (characters.length <= maxChars) return normalized;
  return characters.slice(0, maxChars).join("");
};

const boundEvidence = (evidence: readonly AuditEvidence[]): AuditEvidence[] => {
  const bounded: AuditEvidence[] = [];
  for (const item of evidence.slice(0, AUDIT_MAX_EVIDENCE_PER_FINDING)) {
    const next: AuditEvidence = {
      kind: boundAuditText(item.kind, AUDIT_MAX_CODE_CHARS),
      summary: boundAuditText(item.summary, AUDIT_MAX_MESSAGE_CHARS),
    };
    if (item.uri !== undefined) {
      next.uri = boundAuditText(item.uri, AUDIT_MAX_IDENTIFIER_CHARS);
    }
    if (item.path !== undefined) {
      next.path = boundAuditText(item.path, AUDIT_MAX_IDENTIFIER_CHARS);
    }
    if (item.detail !== undefined) {
      next.detail = boundAuditText(
        item.detail,
        AUDIT_MAX_EVIDENCE_DETAIL_CHARS
      );
    }
    bounded.push(next);
  }
  return bounded.sort((left, right) => {
    const byKind = compareAuditCodeUnits(left.kind, right.kind);
    if (byKind !== 0) return byKind;
    const bySummary = compareAuditCodeUnits(left.summary, right.summary);
    if (bySummary !== 0) return bySummary;
    return compareAuditCodeUnits(
      canonicalAuditJson(left),
      canonicalAuditJson(right)
    );
  });
};

const boundGuidance = (guidance: readonly string[] | undefined): string[] => {
  if (!guidance || guidance.length === 0) return [];
  return guidance
    .slice(0, AUDIT_MAX_GUIDANCE_PER_FINDING)
    .map((item) => boundAuditText(item, AUDIT_MAX_GUIDANCE_CHARS))
    .sort(compareAuditCodeUnits);
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
  const subject = boundAuditText(draft.subject, AUDIT_MAX_IDENTIFIER_CHARS);
  const location =
    draft.location === undefined || draft.location === null
      ? null
      : boundAuditText(draft.location, AUDIT_MAX_IDENTIFIER_CHARS);
  const evidence = boundEvidence(draft.evidence);
  const evidenceFingerprint = fingerprintAuditEvidence(evidence);
  return {
    id: buildAuditFindingId({
      ruleId,
      subject,
      location,
      evidenceFingerprint,
    }),
    ruleId: boundAuditText(ruleId, AUDIT_MAX_CODE_CHARS),
    category,
    severity: draft.severity,
    subject,
    location,
    message: boundAuditText(draft.message, AUDIT_MAX_MESSAGE_CHARS),
    evidence,
    guidance: boundGuidance(draft.guidance),
    evidenceFingerprint,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Ordering, counts, exit taxonomy
// ─────────────────────────────────────────────────────────────────────────────

export const auditCategoryRank = (category: AuditCategory): number =>
  AUDIT_CATEGORIES.indexOf(category);

export const compareAuditFindings = (
  left: AuditFinding,
  right: AuditFinding
): number => {
  const byCategory =
    auditCategoryRank(left.category) - auditCategoryRank(right.category);
  if (byCategory !== 0) return byCategory;
  const byRule = compareAuditCodeUnits(left.ruleId, right.ruleId);
  if (byRule !== 0) return byRule;
  const bySubject = compareAuditCodeUnits(left.subject, right.subject);
  if (bySubject !== 0) return bySubject;
  const leftLocation = left.location ?? "";
  const rightLocation = right.location ?? "";
  const byLocation = compareAuditCodeUnits(leftLocation, rightLocation);
  if (byLocation !== 0) return byLocation;
  return compareAuditCodeUnits(left.id, right.id);
};

export const compareAuditRules = (
  left: AuditRuleResult,
  right: AuditRuleResult
): number => {
  const byCategory =
    auditCategoryRank(left.category) - auditCategoryRank(right.category);
  if (byCategory !== 0) return byCategory;
  const byRule = compareAuditCodeUnits(left.ruleId, right.ruleId);
  if (byRule !== 0) return byRule;
  const semanticRule = ({
    durationMs: _durationMs,
    ...rule
  }: AuditRuleResult) => canonicalAuditJson(rule);
  return compareAuditCodeUnits(semanticRule(left), semanticRule(right));
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
