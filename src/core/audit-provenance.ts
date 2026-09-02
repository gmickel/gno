/** Declared-contract provenance completeness audit rules. */

import type { AuditFindingDraft, AuditRuleContribution } from "./audit";
import type { CaptureSource } from "./capture";

import { compareAuditFindingDrafts } from "./audit";
import { validateDeclaredCaptureProvenance } from "./capture";
import { diagnoseMemoryContent } from "./memory-diagnostics";
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
  /**
   * Present only for documents in a memory-managed collection: the file
   * content the memory-record validator runs against (null when unreadable).
   */
  memory?: { content: string | null };
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

const memoryFinding = (
  document: AuditProvenanceDocument,
  code: string,
  message: string
): AuditFindingDraft => ({
  subject: document.uri,
  location: code,
  severity: "warning",
  message: `memory record excluded from recall: ${message}`,
  evidence: [
    {
      kind: "memory-record-contract",
      summary: code,
      uri: document.uri,
      path: document.relPath,
    },
  ],
  guidance: [
    "Repair the memory frontmatter (memory.recordId/scopes/caller/session/createdAt/contentHash) or re-create the fact with gno remember",
  ],
});

/**
 * Managed memory files are audited against the memory-record contract; each
 * malformed file yields one finding per diagnostic code. Ordinary retrieval
 * still sees such files; managed recall does not.
 */
export const evaluateMemoryRecordAudit = (
  documents: readonly AuditProvenanceDocument[],
  options: { truncated?: boolean } = {}
): AuditRuleContribution => {
  const findings: AuditFindingDraft[] = [];
  let managedDocuments = 0;
  let unreadable = 0;
  for (const document of documents) {
    if (document.memory === undefined) continue;
    managedDocuments += 1;
    if (document.memory.content === null) {
      unreadable += 1;
      continue;
    }
    const diagnostics = diagnoseMemoryContent(document.memory.content) ?? [];
    for (const diagnostic of diagnostics) {
      findings.push(
        memoryFinding(document, diagnostic.code, diagnostic.message)
      );
    }
  }
  findings.sort(compareAuditFindingDrafts);
  const truncated = options.truncated === true;
  return {
    ruleId: "provenance.memory-record",
    category: "provenance",
    status: truncated
      ? "inconclusive"
      : unreadable > 0
        ? "unavailable"
        : findings.length > 0
          ? "fail"
          : managedDocuments === 0
            ? "skip"
            : "pass",
    message: truncated
      ? "Audit selection was truncated; memory record contract not fully evaluated"
      : unreadable > 0
        ? `${unreadable} memory-managed source(s) could not be read`
        : findings.length > 0
          ? `${findings.length} memory record contract violation(s) across ${managedDocuments} managed document(s)`
          : managedDocuments === 0
            ? "No memory-managed collections in scope"
            : `${managedDocuments} managed memory record(s) satisfy the contract`,
    findings: findings.slice(0, PROVENANCE_AUDIT_MAX_FINDINGS_PER_RULE),
    findingCount: findings.length,
    examinedCount: managedDocuments,
    skipReason: truncated
      ? "snapshot_truncated"
      : unreadable > 0
        ? "source_unavailable"
        : managedDocuments === 0
          ? "no_memory_managed_collections"
          : null,
  };
};

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
    evaluateMemoryRecordAudit(documents, options),
  ];
};
