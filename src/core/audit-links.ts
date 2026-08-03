/** Deterministic read-only link-integrity audit rules. */

import type {
  AuditLinkSnapshot,
  AuditLinkSnapshotDocument,
} from "../store/sqlite/graph-link-resolver";
import type { AuditFindingDraft, AuditRuleContribution } from "./audit";

import { compareAuditCodeUnits, compareAuditFindingDrafts } from "./audit";

export const LINK_AUDIT_RULE_VERSION = "1.0" as const;
export const LINK_AUDIT_MAX_FINDINGS_PER_RULE = 1000;

export interface AuditOrphanPolicy {
  rootUris: readonly string[];
  ignorePathPrefixes: readonly string[];
  /** Mirrored duplicate rows are excluded from orphan claims by default. */
  ignoreMirrorDuplicates?: boolean;
}

const boundedFindings = (
  findings: readonly AuditFindingDraft[]
): AuditFindingDraft[] =>
  [...findings]
    .sort(compareAuditFindingDrafts)
    .slice(0, LINK_AUDIT_MAX_FINDINGS_PER_RULE);

const lineLocation = (line: number, column: number): string =>
  `L${line}:C${column}`;

const linkFinding = (
  link: AuditLinkSnapshot["links"][number]
): AuditFindingDraft => {
  const ambiguous = (link.resolved?.matchCount ?? 0) > 1;
  const target = `${link.targetCollection}:${link.targetRef}`;
  return {
    subject: link.sourceUri,
    location: lineLocation(link.startLine, link.startCol),
    severity: "warning",
    message: ambiguous
      ? `Link target is ambiguous: ${target}`
      : `${link.linkType === "markdown" ? "Broken" : "Unresolved"} local link: ${target}`,
    evidence: [
      {
        kind: ambiguous ? "ambiguous-target" : "unresolved-target",
        summary: target,
        uri: link.sourceUri,
        path: link.sourceRelPath,
        detail: JSON.stringify({
          anchor: link.targetAnchor,
          endColumn: link.endCol,
          endLine: link.endLine,
          linkType: link.linkType,
          matchCount: link.resolved?.matchCount ?? 0,
          matchRank: link.resolved?.matchRank ?? null,
          normalizedTarget: link.targetRefNorm,
        }),
      },
    ],
    guidance: ambiguous
      ? ["Use an explicit collection-relative target path"]
      : ["Create the target or correct the local link"],
  };
};

const normalizedPrefixes = (values: readonly string[]): string[] =>
  [...new Set(values.map((value) => value.normalize("NFC").trim()))]
    .filter(Boolean)
    .sort(compareAuditCodeUnits);

const isIgnoredDocument = (
  document: AuditLinkSnapshotDocument,
  roots: Set<string>,
  ignorePrefixes: readonly string[],
  mirroredIds: Set<number>
): boolean =>
  roots.has(document.uri) ||
  mirroredIds.has(document.id) ||
  ignorePrefixes.some((prefix) => {
    const visiblePath = document.recordSourcePath ?? document.relPath;
    return visiblePath === prefix || visiblePath.startsWith(`${prefix}/`);
  });

const duplicateMirrorIds = (
  documents: readonly AuditLinkSnapshotDocument[],
  ignoreMirrorDuplicates: boolean
): Set<number> => {
  if (!ignoreMirrorDuplicates) return new Set<number>();
  const byMirror = new Map<string, number[]>();
  for (const document of documents) {
    if (!document.mirrorHash) continue;
    const ids = byMirror.get(document.mirrorHash) ?? [];
    ids.push(document.id);
    byMirror.set(document.mirrorHash, ids);
  }
  const duplicates = new Set<number>();
  for (const ids of byMirror.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) duplicates.add(id);
  }
  return duplicates;
};

/** Evaluate one already captured set-oriented snapshot; never touches storage. */
export const evaluateLinkAudit = (
  snapshot: AuditLinkSnapshot,
  policy: AuditOrphanPolicy
): AuditRuleContribution[] => {
  const unresolved: AuditFindingDraft[] = [];
  const ambiguous: AuditFindingDraft[] = [];
  const connected = new Set<number>();
  const auditedDocumentIds = new Set(
    snapshot.auditedDocumentIds ?? snapshot.documents.map(({ id }) => id)
  );
  for (const link of snapshot.links) {
    const sourceAudited = auditedDocumentIds.has(link.sourceId);
    if (!link.resolved) {
      if (sourceAudited) unresolved.push(linkFinding(link));
      continue;
    }
    if (sourceAudited) connected.add(link.sourceId);
    if (auditedDocumentIds.has(link.resolved.targetId)) {
      connected.add(link.resolved.targetId);
    }
    if (sourceAudited && link.resolved.matchCount > 1) {
      ambiguous.push(linkFinding(link));
    }
  }
  const roots = new Set(normalizedPrefixes(policy.rootUris));
  const ignorePrefixes = normalizedPrefixes(policy.ignorePathPrefixes);
  const mirroredIds = duplicateMirrorIds(
    snapshot.documents,
    policy.ignoreMirrorDuplicates ?? true
  );
  const orphanFindings = snapshot.documents
    .filter(
      (document) =>
        auditedDocumentIds.has(document.id) &&
        !connected.has(document.id) &&
        !isIgnoredDocument(document, roots, ignorePrefixes, mirroredIds)
    )
    .sort((left, right) => compareAuditCodeUnits(left.uri, right.uri))
    .map<AuditFindingDraft>((document) => ({
      subject: document.uri,
      location: null,
      severity: "info",
      message: "Document is isolated under the configured orphan policy",
      evidence: [
        {
          kind: "orphan-policy",
          summary: "No resolved incoming or outgoing local links",
          uri: document.uri,
          path: document.recordSourcePath ?? document.relPath,
          detail: JSON.stringify({ root: false, ignored: false }),
        },
      ],
      guidance: [
        "Link this document or add it to the explicit root/ignore policy",
      ],
    }));
  const partial = snapshot.truncated.documents || snapshot.truncated.links;
  const statusFor = (findings: readonly AuditFindingDraft[]) =>
    partial
      ? ("inconclusive" as const)
      : findings.length > 0
        ? ("fail" as const)
        : ("pass" as const);
  const common = {
    examinedCount:
      snapshot.metrics.documentRowsExamined + snapshot.metrics.linkRowsExamined,
    durationMs: 0,
  };
  return [
    {
      ...common,
      ruleId: "links.local-targets",
      category: "links",
      status: statusFor(unresolved),
      message: partial
        ? "Local target scan was truncated"
        : `${unresolved.length} unresolved or broken local links`,
      findings: boundedFindings(unresolved),
      findingCount: unresolved.length,
      skipReason: partial ? "snapshot_truncated" : null,
    },
    {
      ...common,
      ruleId: "links.ambiguous-targets",
      category: "links",
      status: statusFor(ambiguous),
      message: partial
        ? "Ambiguous target scan was truncated"
        : `${ambiguous.length} ambiguous local links`,
      findings: boundedFindings(ambiguous),
      findingCount: ambiguous.length,
      skipReason: partial ? "snapshot_truncated" : null,
    },
    {
      ...common,
      ruleId: "links.orphans",
      category: "links",
      status: statusFor(orphanFindings),
      message: partial
        ? "Orphan scan was truncated"
        : `${orphanFindings.length} policy-defined orphan documents`,
      findings: boundedFindings(orphanFindings),
      findingCount: orphanFindings.length,
      skipReason: partial ? "snapshot_truncated" : null,
    },
    {
      ...common,
      ruleId: "links.parser-boundary",
      category: "links",
      status: "pass",
      message:
        "External URLs and parser-excluded malformed references are outside the local target graph",
      findings: [],
      findingCount: 0,
      skipReason: null,
    },
  ];
};
