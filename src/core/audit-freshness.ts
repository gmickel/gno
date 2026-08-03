/** Observable source/index freshness audit rules. */

import type { AuditFindingDraft, AuditRuleContribution } from "./audit";

import { compareAuditFindingDrafts } from "./audit";

export const FRESHNESS_AUDIT_MAX_FINDINGS_PER_RULE = 1000;

export interface AuditFreshnessDocument {
  uri: string;
  relPath: string;
  contentType: string | null;
  indexedSourceHash: string;
  indexedSourceMtime: string;
  indexedAt: string | null;
  lastErrorCode: string | null;
  source: {
    state: "readable" | "missing" | "unreadable";
    hash: string | null;
    mtime: string | null;
    /** Logical records use their physical container only for readability. */
    byteComparable?: boolean;
    changedDuringRead?: boolean;
  };
}

export interface AuditAgePolicy {
  maxAgeDays: number;
  contentTypes?: readonly string[];
}

export interface AuditFreshnessOptions {
  now: Date;
  agePolicy?: AuditAgePolicy;
  truncated?: boolean;
}

const finding = (input: {
  document: AuditFreshnessDocument;
  kind: string;
  message: string;
  detail: Record<string, unknown>;
  severity?: "error" | "warning" | "info";
  guidance: string;
}): AuditFindingDraft => ({
  subject: input.document.uri,
  location: null,
  severity: input.severity ?? "warning",
  message: input.message,
  evidence: [
    {
      kind: input.kind,
      summary: input.message,
      uri: input.document.uri,
      path: input.document.relPath,
      detail: JSON.stringify(input.detail),
    },
  ],
  guidance: [input.guidance],
});

const rule = (input: {
  ruleId: string;
  findings: AuditFindingDraft[];
  examinedCount: number;
  unavailable?: boolean;
  inconclusive?: boolean;
  skipped?: boolean;
  message: string;
  reason?: string;
}): AuditRuleContribution => ({
  ruleId: input.ruleId,
  category: "freshness",
  status: input.inconclusive
    ? "inconclusive"
    : input.unavailable
      ? "unavailable"
      : input.skipped
        ? "skip"
        : input.findings.length > 0
          ? "fail"
          : "pass",
  message: input.message,
  findings: [...input.findings]
    .sort(compareAuditFindingDrafts)
    .slice(0, FRESHNESS_AUDIT_MAX_FINDINGS_PER_RULE),
  findingCount: input.findings.length,
  examinedCount: input.examinedCount,
  skipReason: input.reason ?? null,
});

/** Age findings are policy signals only and do not claim factual incorrectness. */
export const evaluateFreshnessAudit = (
  documents: readonly AuditFreshnessDocument[],
  options: AuditFreshnessOptions
): AuditRuleContribution[] => {
  const unavailable: AuditFindingDraft[] = [];
  const drift: AuditFindingDraft[] = [];
  const staleRevision: AuditFindingDraft[] = [];
  const ageSignals: AuditFindingDraft[] = [];
  let changedDuringRead = false;
  const ageTypes = new Set(options.agePolicy?.contentTypes ?? []);
  for (const document of documents) {
    if (document.source.changedDuringRead) changedDuringRead = true;
    if (document.source.state !== "readable") {
      unavailable.push(
        finding({
          document,
          kind: `source-${document.source.state}`,
          message: `Source evidence is ${document.source.state}`,
          detail: { state: document.source.state },
          guidance: "Restore read access and re-run the audit",
        })
      );
      continue;
    }
    if (
      document.source.byteComparable !== false &&
      document.source.hash !== null &&
      document.source.hash !== document.indexedSourceHash
    ) {
      drift.push(
        finding({
          document,
          kind: "source-index-hash-drift",
          message: "Source bytes differ from the indexed revision",
          detail: {
            indexedHash: document.indexedSourceHash,
            sourceHash: document.source.hash,
          },
          guidance: "Run gno index and inspect conversion errors",
        })
      );
    }
    if (!document.indexedAt || document.lastErrorCode) {
      staleRevision.push(
        finding({
          document,
          kind: "stale-indexed-revision",
          message: document.lastErrorCode
            ? "The latest indexing attempt recorded an error"
            : "The document has no indexed-at revision evidence",
          detail: {
            indexedAt: document.indexedAt,
            lastErrorCode: document.lastErrorCode,
          },
          guidance: "Run gno index and resolve the reported ingest error",
        })
      );
    }
    if (
      options.agePolicy &&
      (ageTypes.size === 0 ||
        (document.contentType !== null && ageTypes.has(document.contentType)))
    ) {
      const timestamp = Date.parse(document.indexedSourceMtime);
      const ageDays = (options.now.getTime() - timestamp) / 86_400_000;
      if (Number.isFinite(ageDays) && ageDays > options.agePolicy.maxAgeDays) {
        ageSignals.push(
          finding({
            document,
            kind: "configured-age-signal",
            message: `Source age exceeds the configured ${options.agePolicy.maxAgeDays}-day review signal`,
            detail: {
              ageDays: Math.floor(ageDays),
              maxAgeDays: options.agePolicy.maxAgeDays,
            },
            severity: "info",
            guidance:
              "Review if useful; age is not evidence that the content is false",
          })
        );
      }
    }
  }
  const truncated = options.truncated === true;
  const inconclusive = truncated || changedDuringRead;
  const byteComparableCount = documents.filter(
    ({ source }) => source.byteComparable !== false
  ).length;
  const excludedLogicalRecords = documents.length - byteComparableCount;
  const reason = changedDuringRead
    ? "source_changed_during_read"
    : truncated
      ? "snapshot_truncated"
      : undefined;
  return [
    rule({
      ruleId: "freshness.source-readable",
      findings: unavailable,
      examinedCount: documents.length,
      unavailable: unavailable.length > 0 && !inconclusive,
      inconclusive,
      message: inconclusive
        ? "Source readability evidence changed or was truncated"
        : `${unavailable.length} sources are missing or unreadable`,
      reason,
    }),
    rule({
      ruleId: "freshness.source-index-drift",
      findings: drift,
      examinedCount: byteComparableCount,
      inconclusive,
      message: inconclusive
        ? "Source/index drift evidence changed or was truncated"
        : `${drift.length} source revisions differ from the index${excludedLogicalRecords > 0 ? `; ${excludedLogicalRecords} logical records excluded from byte comparison` : ""}`,
      reason,
    }),
    rule({
      ruleId: "freshness.index-revision",
      findings: staleRevision,
      examinedCount: documents.length,
      inconclusive,
      message: inconclusive
        ? "Indexed revision evidence changed or was truncated"
        : `${staleRevision.length} indexed revisions need attention`,
      reason,
    }),
    rule({
      ruleId: "freshness.configured-age-signal",
      findings: ageSignals,
      examinedCount: documents.length,
      inconclusive,
      skipped: !options.agePolicy,
      message: !options.agePolicy
        ? "No age review policy was configured"
        : `${ageSignals.length} configured age review signals`,
      reason:
        reason ??
        (!options.agePolicy ? "age_policy_not_configured" : undefined),
    }),
  ];
};
