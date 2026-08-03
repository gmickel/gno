/** Declared-contract provenance completeness audit rules. */

import type { AuditFindingDraft, AuditRuleContribution } from "./audit";
import type { CaptureSource } from "./capture";

import { compareAuditFindingDrafts } from "./audit";
import { validateDeclaredCaptureProvenance } from "./capture";
import {
  hasDeclaredRecordProvenance,
  validateDeclaredRecordProvenance,
} from "./record-metadata";

export const PROVENANCE_AUDIT_MAX_FINDINGS_PER_RULE = 1000;

export interface AuditProvenanceDocument {
  uri: string;
  relPath: string;
  sourceState?: "readable" | "missing" | "unreadable";
  /** Whether this source format can declare CaptureSource frontmatter. */
  captureSourceSupported?: boolean;
  captureSource?: Partial<CaptureSource>;
  captureSourceDeclared: boolean;
  record: {
    recordKey?: string | null;
    recordSourceLocator?: string | null;
    converterId?: string | null;
    converterVersion?: string | null;
    recordAdapterFingerprint?: string | null;
  };
}

const issueFinding = (input: {
  document: AuditProvenanceDocument;
  field: string;
  reason: "missing" | "invalid";
  contract: string;
}): AuditFindingDraft => ({
  subject: input.document.uri,
  location: input.field,
  severity: "warning",
  message: `${input.contract} provenance field is ${input.reason}: ${input.field}`,
  evidence: [
    {
      kind: "declared-provenance-requirement",
      summary: `${input.contract}:${input.field}:${input.reason}`,
      uri: input.document.uri,
      path: input.document.relPath,
    },
  ],
  guidance: [
    `Supply a valid ${input.field} value or remove the declaring provenance block`,
  ],
});

/** Missing provenance is completeness evidence, never a truth judgment. */
export const evaluateProvenanceAudit = (
  documents: readonly AuditProvenanceDocument[],
  options: { truncated?: boolean } = {}
): AuditRuleContribution[] => {
  const captureFindings: AuditFindingDraft[] = [];
  const recordFindings: AuditFindingDraft[] = [];
  let declaredCaptureDocuments = 0;
  let declaredRecordDocuments = 0;
  let unavailableCaptureSources = 0;
  for (const document of documents) {
    if (
      document.captureSourceSupported !== false &&
      document.sourceState !== undefined &&
      document.sourceState !== "readable"
    ) {
      unavailableCaptureSources += 1;
    }
    if (document.captureSourceDeclared) {
      declaredCaptureDocuments += 1;
      for (const issue of validateDeclaredCaptureProvenance(
        document.captureSource ?? {}
      )) {
        captureFindings.push(
          issueFinding({
            document,
            field: issue.field,
            reason: issue.reason,
            contract: "capture",
          })
        );
      }
    }
    const recordIssues = validateDeclaredRecordProvenance(document.record);
    if (hasDeclaredRecordProvenance(document.record)) {
      declaredRecordDocuments += 1;
    }
    for (const issue of recordIssues) {
      recordFindings.push(
        issueFinding({
          document,
          field: issue.field,
          reason: issue.reason,
          contract: "logical-record",
        })
      );
    }
  }
  const truncated = options.truncated === true;
  const result = (
    ruleId: string,
    findings: AuditFindingDraft[],
    declaredDocuments: number,
    unavailableDocuments = 0
  ): AuditRuleContribution => ({
    ruleId,
    category: "provenance",
    status: truncated
      ? "inconclusive"
      : unavailableDocuments > 0
        ? "unavailable"
        : findings.length > 0
          ? "fail"
          : declaredDocuments === 0
            ? "skip"
            : "pass",
    message: truncated
      ? "Provenance scan was truncated"
      : unavailableDocuments > 0
        ? `${unavailableDocuments} source files could not be inspected for declared capture provenance`
        : declaredDocuments === 0
          ? "No documents declared this provenance contract"
          : `${findings.length} declared provenance completeness issues`,
    findings: [...findings]
      .sort(compareAuditFindingDrafts)
      .slice(0, PROVENANCE_AUDIT_MAX_FINDINGS_PER_RULE),
    findingCount: findings.length,
    examinedCount: documents.length,
    skipReason: truncated
      ? "snapshot_truncated"
      : unavailableDocuments > 0
        ? "source_unavailable"
        : declaredDocuments === 0
          ? "contract_not_declared"
          : null,
  });
  return [
    result(
      "provenance.capture-source",
      captureFindings,
      declaredCaptureDocuments,
      unavailableCaptureSources
    ),
    result(
      "provenance.logical-record",
      recordFindings,
      declaredRecordDocuments
    ),
  ];
};
