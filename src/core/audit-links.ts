/** Deterministic read-only link-integrity audit rules. */

import type {
  AuditLinkSnapshot,
  AuditLinkSnapshotDocument,
} from "../store/sqlite/graph-link-resolver";
import type { AuditFindingDraft, AuditRuleContribution } from "./audit";

import { getExcludedRanges } from "../ingestion/strip";
import { isTraversableResolution } from "../store/sqlite/graph-link-resolver";
import {
  AUDIT_MAX_EVIDENCE_DETAIL_CHARS,
  compareAuditCodeUnits,
  compareAuditFindingDrafts,
} from "./audit";

/**
 * 1.1: workspace-wide resolution and reference/resolution/scope evidence.
 * 1.2: `links.outside-index` for workspace files that are not indexed.
 * 1.3: relative Markdown links to such files are `outside-index` too.
 * 1.4: opt-in `links.policy`, `links.external-url` and `paths.pattern`.
 */
export const LINK_AUDIT_RULE_VERSION = "1.4" as const;
/** Default per-rule cap; runs pass the effective `maxFindings` instead. */
export const LINK_AUDIT_MAX_FINDINGS_PER_RULE = 1000;

export interface AuditOrphanPolicy {
  rootUris: readonly string[];
  ignorePathPrefixes: readonly string[];
  /** Mirrored duplicate rows are excluded from orphan claims by default. */
  ignoreMirrorDuplicates?: boolean;
  /** Effective per-rule cap; defaults to LINK_AUDIT_MAX_FINDINGS_PER_RULE. */
  maxFindingsPerRule?: number;
}

const boundedFindings = (
  findings: readonly AuditFindingDraft[],
  maxFindingsPerRule: number
): AuditFindingDraft[] =>
  [...findings].sort(compareAuditFindingDrafts).slice(0, maxFindingsPerRule);

const lineLocation = (line: number, column: number): string =>
  `L${line}:C${column}`;

type LinkReferenceKind =
  | "wiki-name"
  | "wiki-path"
  | "explicit-collection"
  | "markdown";

const referenceKind = (
  link: AuditLinkSnapshot["links"][number]
): LinkReferenceKind =>
  link.linkType === "markdown"
    ? "markdown"
    : link.explicitCollection === true
      ? "explicit-collection"
      : link.targetRef.includes("/")
        ? "wiki-path"
        : "wiki-name";

interface CandidateEvidence {
  /** Canonical-path-ordered tied candidates visible in the audit scope. */
  uris: string[];
  /** Candidates outside the requested collection scope (identity withheld). */
  withheld: number;
  truncated: boolean;
}

const linkFinding = (
  link: AuditLinkSnapshot["links"][number],
  context: {
    documents: ReadonlyMap<number, AuditLinkSnapshotDocument>;
    scope: ReadonlySet<string> | null;
  },
  onEvidenceTruncated: () => void
): AuditFindingDraft => {
  const ambiguous = (link.resolved?.matchCount ?? 0) > 1;
  const outsideIndex = !ambiguous && link.outsideIndex === true;
  const target = `${link.targetCollection}:${link.targetRef}`;
  const kind = referenceKind(link);
  const tied = (link.resolved?.candidates ?? []).map((candidate) =>
    context.documents.get(candidate.id)
  );
  const visible = tied.filter(
    (document): document is AuditLinkSnapshotDocument =>
      document !== undefined &&
      (context.scope === null || context.scope.has(document.collection))
  );
  // Scope describes every tied candidate; withheld ones are only counted.
  const resolvedScope = !ambiguous
    ? null
    : link.explicitCollection === true
      ? "explicit-collection"
      : tied.some(
            (document) =>
              document !== undefined &&
              document.collection !== link.sourceCollection
          )
        ? "cross-collection"
        : "same-collection";
  const base = {
    anchor: link.targetAnchor,
    endColumn: link.endCol,
    endLine: link.endLine,
    linkType: link.linkType,
    matchCount: link.resolved?.matchCount ?? 0,
    matchRank: link.resolved?.matchRank ?? null,
    normalizedTarget: link.targetRefNorm,
    referenceKind: kind,
    resolutionStatus: ambiguous
      ? "ambiguous"
      : outsideIndex
        ? "outside-index"
        : "unresolved",
    resolvedScope,
  };
  // Candidate URIs are added while the detail stays within the evidence
  // bound, so a long tie is reported as truncated rather than silently cut.
  const candidates: CandidateEvidence = {
    uris: [],
    withheld: tied.length - visible.length,
    truncated: false,
  };
  const render = (): string =>
    JSON.stringify(
      tied.length > 0
        ? {
            ...base,
            candidateCount: tied.length,
            candidates: candidates.uris,
            ...(candidates.withheld > 0
              ? { candidatesWithheld: candidates.withheld }
              : {}),
            ...(candidates.truncated ? { candidatesTruncated: true } : {}),
          }
        : base
    );
  for (const document of visible) {
    candidates.uris.push(document.uri);
    if (Array.from(render()).length > AUDIT_MAX_EVIDENCE_DETAIL_CHARS) {
      candidates.uris.pop();
      candidates.truncated = true;
      break;
    }
  }
  if (
    candidates.truncated &&
    Array.from(render()).length > AUDIT_MAX_EVIDENCE_DETAIL_CHARS
  ) {
    candidates.uris.pop();
  }
  if (candidates.truncated) onEvidenceTruncated();
  if (outsideIndex) {
    return {
      subject: link.sourceUri,
      location: lineLocation(link.startLine, link.startCol),
      severity: "info",
      message: `Link target exists outside the index: ${target}`,
      evidence: [
        {
          kind: "outside-index-target",
          summary: target,
          uri: link.sourceUri,
          path: link.sourceRelPath,
          detail: render(),
        },
      ],
      guidance: [
        "No action needed; index the target's folder to add it to the link graph",
      ],
    };
  }
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
        detail: render(),
      },
    ],
    guidance: ambiguous
      ? [
          tied.length > 0
            ? "Use a longer path such as [[Folder/Note]] to pick one target"
            : "Use an explicit collection-relative target path",
        ]
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
  const outsideIndex: AuditFindingDraft[] = [];
  const ambiguous: AuditFindingDraft[] = [];
  const connected = new Set<number>();
  const auditedDocumentIds = new Set(
    snapshot.auditedDocumentIds ?? snapshot.documents.map(({ id }) => id)
  );
  let evidenceTruncated = false;
  const findingContext = {
    documents: new Map(snapshot.documents.map((doc) => [doc.id, doc])),
    scope: snapshot.scopeCollections
      ? new Set(snapshot.scopeCollections)
      : null,
  };
  const finding = (link: AuditLinkSnapshot["links"][number]) =>
    linkFinding(link, findingContext, () => {
      evidenceTruncated = true;
    });
  for (const link of snapshot.links) {
    const sourceAudited = auditedDocumentIds.has(link.sourceId);
    if (!link.resolved) {
      if (sourceAudited) {
        (link.outsideIndex === true ? outsideIndex : unresolved).push(
          finding(link)
        );
      }
      continue;
    }
    // A tied workspace link is not a resolved link: it connects nothing.
    if (isTraversableResolution(link.resolved)) {
      if (sourceAudited) connected.add(link.sourceId);
      if (auditedDocumentIds.has(link.resolved.targetId)) {
        connected.add(link.resolved.targetId);
      }
    }
    if (sourceAudited && link.resolved.matchCount > 1) {
      ambiguous.push(finding(link));
    }
  }
  const maxFindingsPerRule =
    policy.maxFindingsPerRule ?? LINK_AUDIT_MAX_FINDINGS_PER_RULE;
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
      findings: boundedFindings(unresolved, maxFindingsPerRule),
      findingCount: unresolved.length,
      skipReason: partial ? "snapshot_truncated" : null,
    },
    {
      ...common,
      ruleId: "links.ambiguous-targets",
      category: "links",
      evidenceTruncated,
      status: statusFor(ambiguous),
      message: partial
        ? "Ambiguous target scan was truncated"
        : `${ambiguous.length} ambiguous local links`,
      findings: boundedFindings(ambiguous, maxFindingsPerRule),
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
      findings: boundedFindings(orphanFindings, maxFindingsPerRule),
      findingCount: orphanFindings.length,
      skipReason: partial ? "snapshot_truncated" : null,
    },
    {
      // Informational: Obsidian resolves these links, so they never fail
      // the audit. Info findings keep the rule passing.
      ...common,
      ruleId: "links.outside-index",
      category: "links",
      status: partial ? ("inconclusive" as const) : ("pass" as const),
      message: [
        partial
          ? "Outside-index scan was truncated"
          : `${outsideIndex.length} links point to existing files outside the index`,
        ...(snapshot.outsideIndexDiagnostic
          ? [snapshot.outsideIndexDiagnostic]
          : []),
      ].join("; "),
      findings: boundedFindings(outsideIndex, maxFindingsPerRule),
      findingCount: outsideIndex.length,
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

// ─────────────────────────────────────────────────────────────────────────────
// Opt-in collection link rules: links.policy, links.external-url, paths.pattern
// ─────────────────────────────────────────────────────────────────────────────

/** Per-collection opt-in rules (collection `linkPolicy` and `pathPattern`). */
export interface AuditCollectionLinkRules {
  name: string;
  linkPolicy?: {
    mayLinkTo?: readonly string[];
    externalUrls?: "allow" | "deny";
  };
  pathPattern?: string;
}

export interface AuditExternalUrl {
  url: string;
  line: number;
  column: number;
}

/**
 * Markdown text of one audited document in a collection that denies URLs.
 * `markdown` is null when the indexed content is missing; the document is
 * then reported as unchecked instead of passing.
 */
export interface AuditExternalUrlDocument {
  id: number;
  markdown: string | null;
}

/** Scheme URLs (`https://…`, `ftp://…`) and `mailto:`; `gno://` is internal. */
const EXTERNAL_URL_TEXT_REGEX =
  /\b(?:[a-z][a-z0-9+.-]*:\/\/|mailto:)[^\s<>()[\]"'`]+/giu;
const URL_TRAILING_PUNCTUATION_REGEX = /[.,;:!?]+$/u;
const INTERNAL_URL_PREFIX = "gno://";

/** External URLs outside frontmatter, code and HTML comments, in text order. */
export const findExternalUrls = (markdown: string): AuditExternalUrl[] => {
  const excluded = getExcludedRanges(markdown);
  const urls: AuditExternalUrl[] = [];
  for (const match of markdown.matchAll(EXTERNAL_URL_TEXT_REGEX)) {
    const start = match.index;
    const url = match[0].replace(URL_TRAILING_PUNCTUATION_REGEX, "");
    if (url.toLowerCase().startsWith(INTERNAL_URL_PREFIX)) continue;
    if (excluded.some((range) => range.start <= start && start < range.end)) {
      continue;
    }
    const before = markdown.slice(0, start);
    const lineStart = before.lastIndexOf("\n") + 1;
    urls.push({
      url,
      line: before.split("\n").length,
      column: start - lineStart + 1,
    });
  }
  return urls;
};

const hasExternalUrlRule = (rules: AuditCollectionLinkRules): boolean =>
  rules.linkPolicy?.externalUrls === "deny";

/** Collections whose audited documents need markdown for `links.external-url`. */
export const externalUrlCollections = (
  rules: readonly AuditCollectionLinkRules[]
): Set<string> =>
  new Set(rules.filter(hasExternalUrlRule).map(({ name }) => name));

/**
 * Evaluate the opt-in collection rules over the same link snapshot. A rule is
 * emitted only when an audited document's collection configures it, so with
 * no rules configured the report is unchanged.
 */
export const evaluateCollectionLinkRules = (
  snapshot: AuditLinkSnapshot,
  rules: readonly AuditCollectionLinkRules[],
  options: {
    externalUrlDocuments?: readonly AuditExternalUrlDocument[];
    maxFindingsPerRule?: number;
  } = {}
): AuditRuleContribution[] => {
  const byName = new Map(rules.map((rule) => [rule.name, rule]));
  const documents = new Map(snapshot.documents.map((doc) => [doc.id, doc]));
  const auditedIds = new Set(
    snapshot.auditedDocumentIds ?? snapshot.documents.map(({ id }) => id)
  );
  const audited = snapshot.documents.filter(({ id }) => auditedIds.has(id));
  const auditedCollections = new Set(audited.map((doc) => doc.collection));
  const configured = (pick: (rule: AuditCollectionLinkRules) => boolean) =>
    [...auditedCollections].some((name) => {
      const rule = byName.get(name);
      return rule !== undefined && pick(rule);
    });
  const maxFindingsPerRule =
    options.maxFindingsPerRule ?? LINK_AUDIT_MAX_FINDINGS_PER_RULE;
  const partial = snapshot.truncated.documents || snapshot.truncated.links;
  const contribution = (
    ruleId: string,
    findings: AuditFindingDraft[],
    examinedCount: number,
    message: string
  ): AuditRuleContribution => ({
    ruleId,
    category: "links",
    status: partial ? "inconclusive" : findings.length > 0 ? "fail" : "pass",
    message: partial ? `${ruleId} scan was truncated` : message,
    findings: boundedFindings(findings, maxFindingsPerRule),
    findingCount: findings.length,
    examinedCount,
    durationMs: 0,
    skipReason: partial ? "snapshot_truncated" : null,
  });
  const output: AuditRuleContribution[] = [];

  if (configured((rule) => rule.linkPolicy?.mayLinkTo !== undefined)) {
    const policyFindings: AuditFindingDraft[] = [];
    let examined = 0;
    for (const link of snapshot.links) {
      if (!auditedIds.has(link.sourceId)) continue;
      const allowed = byName.get(link.sourceCollection)?.linkPolicy?.mayLinkTo;
      if (allowed === undefined) continue;
      examined += 1;
      const target = isTraversableResolution(link.resolved)
        ? documents.get(link.resolved.targetId)
        : undefined;
      const targetCollection =
        target?.collection ??
        (link.explicitCollection === true ? link.targetCollection : undefined);
      if (
        targetCollection === undefined ||
        targetCollection === link.sourceCollection ||
        allowed.includes(targetCollection)
      ) {
        continue;
      }
      const targetRef = target?.relPath ?? link.targetRef;
      policyFindings.push({
        subject: link.sourceUri,
        location: lineLocation(link.startLine, link.startCol),
        severity: "warning",
        message: `Link to collection ${targetCollection} is not allowed by the link policy of ${link.sourceCollection}: ${targetCollection}:${targetRef}`,
        evidence: [
          {
            kind: "link-policy",
            summary: `${link.sourceCollection} -> ${targetCollection}`,
            uri: link.sourceUri,
            path: link.sourceRelPath,
            detail: JSON.stringify({
              sourceCollection: link.sourceCollection,
              targetCollection,
              target: `${targetCollection}:${targetRef}`,
              mayLinkTo: [...allowed].sort(compareAuditCodeUnits),
            }),
          },
        ],
        guidance: [
          "Remove the link, or add the target collection to linkPolicy.mayLinkTo",
        ],
      });
    }
    output.push(
      contribution(
        "links.policy",
        policyFindings,
        examined,
        `${policyFindings.length} links cross a collection link policy`
      )
    );
  }

  if (configured(hasExternalUrlRule)) {
    const urlFindings: AuditFindingDraft[] = [];
    const urlDocuments = options.externalUrlDocuments ?? [];
    for (const { id, markdown } of urlDocuments) {
      const document = documents.get(id);
      if (!document || !auditedIds.has(id)) continue;
      if (!hasExternalUrlRule(byName.get(document.collection) ?? { name: "" }))
        continue;
      if (markdown === null) {
        // Missing content cannot prove the document has no URLs: fail closed.
        urlFindings.push({
          subject: document.uri,
          location: null,
          severity: "warning",
          message: `Content is missing from the index, so external URLs were not checked in collection ${document.collection}: ${document.relPath}`,
          evidence: [
            {
              kind: "external-url-unchecked",
              summary: "indexed content missing",
              uri: document.uri,
              path: document.relPath,
            },
          ],
          guidance: ["Run gno update to index the document, then audit again"],
        });
        continue;
      }
      for (const found of findExternalUrls(markdown)) {
        urlFindings.push({
          subject: document.uri,
          location: lineLocation(found.line, found.column),
          severity: "warning",
          message: `External URL is not allowed in collection ${document.collection}: ${found.url}`,
          evidence: [
            {
              kind: "external-url",
              summary: found.url,
              uri: document.uri,
              path: document.relPath,
            },
          ],
          guidance: ["Remove the URL or set linkPolicy.externalUrls to allow"],
        });
      }
    }
    output.push(
      contribution(
        "links.external-url",
        urlFindings,
        urlDocuments.length,
        `${urlFindings.length} external URLs in collections that deny them`
      )
    );
  }

  if (configured((rule) => rule.pathPattern !== undefined)) {
    const pathFindings: AuditFindingDraft[] = [];
    const patterns = new Map<string, RegExp>();
    let examined = 0;
    for (const document of audited) {
      const pattern = byName.get(document.collection)?.pathPattern;
      if (pattern === undefined) continue;
      examined += 1;
      let regex = patterns.get(pattern);
      if (!regex) {
        regex = new RegExp(pattern, "u");
        patterns.set(pattern, regex);
      }
      if (regex.test(document.relPath)) continue;
      pathFindings.push({
        subject: document.uri,
        location: null,
        severity: "warning",
        message: `Path does not match the pathPattern of collection ${document.collection}: ${document.relPath}`,
        evidence: [
          {
            kind: "path-pattern",
            summary: document.relPath,
            uri: document.uri,
            path: document.relPath,
            detail: JSON.stringify({ pattern }),
          },
        ],
        guidance: ["Rename the file to match the collection pathPattern"],
      });
    }
    output.push(
      contribution(
        "paths.pattern",
        pathFindings,
        examined,
        `${pathFindings.length} document paths do not match pathPattern`
      )
    );
  }
  return output;
};
