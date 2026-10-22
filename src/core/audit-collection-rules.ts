/**
 * Opt-in, report-only collection rules for the `links` audit category:
 * `links.collection-policy`, `links.external-url` and `links.path-layout`.
 * A rule is emitted only when an audited collection configures it.
 */

import type { Collection, CollectionAuditConfig } from "../config/types";
import type { AuditLinkSnapshot } from "../store/sqlite/graph-link-resolver";
import type { DocumentRow } from "../store/types";
import type { AuditFindingDraft, AuditRuleContribution } from "./audit";

import { buildLineOffsets, offsetToPosition } from "../ingestion/position";
import { getExcludedRanges, rangeIntersectsExcluded } from "../ingestion/strip";
import { isTraversableResolution } from "../store/sqlite/graph-link-resolver";
import {
  AUDIT_MAX_EVIDENCE_DETAIL_CHARS,
  compareAuditCodeUnits,
  compareAuditFindingDrafts,
} from "./audit";

export interface CollectionAuditRuleInput {
  links: AuditLinkSnapshot;
  /** Audited documents (the requested scope). */
  documents: readonly DocumentRow[];
  /** Configured collections. */
  collections: readonly Collection[];
  /** Collections the run audits; rules are emitted only for these. */
  auditedCollections: readonly string[];
  /** Indexed text by mirror hash, loaded only for `externalUrls: report`. */
  contents: ReadonlyMap<string, string>;
  truncated: boolean;
  maxFindingsPerRule: number;
}

/** `scheme://` in prose or link syntax; the start must not continue a word. */
const URL_PATTERN = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*):\/\/[^\s<>"'`]+/gi;
/** Local schemes are not external URLs. */
const LOCAL_URL_SCHEMES = new Set(["gno", "file"]);
const TRAILING_PUNCTUATION = /[.,;:!?*_~]$/;
const MAX_URL_EVIDENCE_CHARS = 400;

const clip = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

const lineLocation = (line: number, column: number): string =>
  `L${line}:C${column}`;

/** Trim sentence punctuation and closers that do not belong to the URL. */
const trimUrl = (raw: string): string => {
  let url = raw;
  for (;;) {
    const last = url.at(-1);
    if (last === undefined) return url;
    if (TRAILING_PUNCTUATION.test(last)) {
      url = url.slice(0, -1);
      continue;
    }
    const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
    const opener = pairs[last];
    if (
      opener !== undefined &&
      url.split(last).length > url.split(opener).length
    ) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
};

export interface ExternalUrlMatch {
  url: string;
  line: number;
  column: number;
}

/** External URLs in indexed text, outside frontmatter, code and comments. */
export const findExternalUrls = (markdown: string): ExternalUrlMatch[] => {
  const excluded = getExcludedRanges(markdown);
  const lineOffsets = buildLineOffsets(markdown);
  const matches: ExternalUrlMatch[] = [];
  for (const match of markdown.matchAll(URL_PATTERN)) {
    const scheme = match[1]?.toLowerCase() ?? "";
    if (LOCAL_URL_SCHEMES.has(scheme)) continue;
    const url = trimUrl(match[0]);
    if (url.length <= scheme.length + 3) continue;
    const start = match.index;
    if (rangeIntersectsExcluded(start, start + url.length, excluded)) continue;
    const position = offsetToPosition(start, lineOffsets);
    matches.push({ url, line: position.line, column: position.col });
  }
  return matches;
};

const configuredFor = (
  input: CollectionAuditRuleInput
): Map<string, CollectionAuditConfig> => {
  const audited = new Set(input.auditedCollections);
  return new Map(
    input.collections
      .filter(({ name, audit }) => audit !== undefined && audited.has(name))
      .map(({ name, audit }) => [name, audit as CollectionAuditConfig])
  );
};

const documentPath = (document: DocumentRow): string =>
  document.recordSourcePath ?? document.relPath;

const contribution = (
  ruleId: string,
  findings: AuditFindingDraft[],
  input: CollectionAuditRuleInput,
  examinedCount: number,
  messages: { partial: string; done: string }
): AuditRuleContribution => {
  const partial = input.truncated;
  return {
    ruleId,
    category: "links",
    status: partial ? "inconclusive" : findings.length > 0 ? "fail" : "pass",
    message: partial ? messages.partial : messages.done,
    findings: [...findings]
      .sort(compareAuditFindingDrafts)
      .slice(0, input.maxFindingsPerRule),
    findingCount: findings.length,
    examinedCount,
    durationMs: 0,
    skipReason: partial ? "snapshot_truncated" : null,
  };
};

const collectionPolicy = (
  input: CollectionAuditRuleInput,
  configured: ReadonlyMap<string, CollectionAuditConfig>
): AuditRuleContribution | null => {
  const allowedBySource = new Map<string, Set<string>>();
  for (const [name, audit] of configured) {
    if (audit.linkCollections === undefined) continue;
    allowedBySource.set(name, new Set([name, ...audit.linkCollections]));
  }
  if (allowedBySource.size === 0) return null;
  const audited = new Set(
    input.links.auditedDocumentIds ?? input.links.documents.map(({ id }) => id)
  );
  const documents = new Map(input.links.documents.map((doc) => [doc.id, doc]));
  const findings: AuditFindingDraft[] = [];
  let examined = 0;
  for (const link of input.links.links) {
    const allowed = allowedBySource.get(link.sourceCollection);
    if (!allowed || !audited.has(link.sourceId)) continue;
    examined += 1;
    // Unresolved and ambiguous links belong to the broken-link rules.
    if (!link.resolved || !isTraversableResolution(link.resolved)) continue;
    if (link.resolved.matchCount > 1) continue;
    const target = documents.get(link.resolved.targetId);
    if (!target || allowed.has(target.collection)) continue;
    findings.push({
      subject: link.sourceUri,
      location: lineLocation(link.startLine, link.startCol),
      severity: "warning",
      message: `Link into collection "${target.collection}", which audit.linkCollections does not list: ${target.uri}`,
      evidence: [
        {
          kind: "collection-policy",
          summary: `${target.collection}:${target.uri}`,
          uri: link.sourceUri,
          path: link.sourceRelPath,
          detail: clip(
            JSON.stringify({
              sourceCollection: link.sourceCollection,
              targetCollection: target.collection,
              target: target.uri,
              linkType: link.linkType,
              allowed: [...allowed].sort(compareAuditCodeUnits),
            }),
            AUDIT_MAX_EVIDENCE_DETAIL_CHARS
          ),
        },
      ],
      guidance: [
        `Remove or change the link, or add "${target.collection}" to audit.linkCollections`,
      ],
    });
  }
  return contribution("links.collection-policy", findings, input, examined, {
    partial: "Collection link policy scan was truncated",
    done: `${findings.length} links into collections outside audit.linkCollections`,
  });
};

const externalUrls = (
  input: CollectionAuditRuleInput,
  configured: ReadonlyMap<string, CollectionAuditConfig>
): AuditRuleContribution | null => {
  const reporting = new Set(
    [...configured]
      .filter(([, audit]) => audit.externalUrls === "report")
      .map(([name]) => name)
  );
  if (reporting.size === 0) return null;
  const findings: AuditFindingDraft[] = [];
  let examined = 0;
  let unchecked = 0;
  for (const document of input.documents) {
    if (!reporting.has(document.collection)) continue;
    examined += 1;
    const text = document.mirrorHash
      ? input.contents.get(document.mirrorHash)
      : undefined;
    if (text === undefined) {
      unchecked += 1;
      findings.push({
        subject: document.uri,
        location: null,
        severity: "warning",
        message: "Indexed text is unavailable; external URLs were not checked",
        evidence: [
          {
            kind: "external-url-unchecked",
            summary: "unchecked",
            uri: document.uri,
            path: documentPath(document),
          },
        ],
        guidance: ["Run gno update so the document has indexed text"],
      });
      continue;
    }
    for (const match of findExternalUrls(text)) {
      findings.push({
        subject: document.uri,
        location: lineLocation(match.line, match.column),
        severity: "warning",
        message: `External URL in document text: ${clip(match.url, MAX_URL_EVIDENCE_CHARS)}`,
        evidence: [
          {
            kind: "external-url",
            summary: clip(match.url, MAX_URL_EVIDENCE_CHARS),
            uri: document.uri,
            path: documentPath(document),
            detail: JSON.stringify({ line: match.line, column: match.column }),
          },
        ],
        guidance: [
          "Remove the URL, or set audit.externalUrls: ignore for this collection",
        ],
      });
    }
  }
  const urls = findings.length - unchecked;
  return contribution("links.external-url", findings, input, examined, {
    partial: "External URL scan was truncated",
    done:
      unchecked > 0
        ? `${urls} external URLs; ${unchecked} documents unchecked`
        : `${urls} external URLs`,
  });
};

const pathLayout = (
  input: CollectionAuditRuleInput,
  configured: ReadonlyMap<string, CollectionAuditConfig>
): AuditRuleContribution | null => {
  const globsByCollection = new Map<
    string,
    { patterns: string[]; globs: Bun.Glob[] }
  >();
  for (const [name, audit] of configured) {
    if (audit.paths === undefined) continue;
    globsByCollection.set(name, {
      patterns: audit.paths,
      globs: audit.paths.map((pattern) => new Bun.Glob(pattern)),
    });
  }
  if (globsByCollection.size === 0) return null;
  const findings: AuditFindingDraft[] = [];
  let examined = 0;
  for (const document of input.documents) {
    const expected = globsByCollection.get(document.collection);
    if (!expected) continue;
    examined += 1;
    const path = documentPath(document);
    if (expected.globs.some((glob) => glob.match(path))) continue;
    findings.push({
      subject: document.uri,
      location: null,
      severity: "warning",
      message: `Document path matches no audit.paths glob: ${path}`,
      evidence: [
        {
          kind: "path-layout",
          summary: path,
          uri: document.uri,
          path,
          detail: clip(
            JSON.stringify({ paths: expected.patterns }),
            AUDIT_MAX_EVIDENCE_DETAIL_CHARS
          ),
        },
      ],
      guidance: ["Move the document, or add a matching glob to audit.paths"],
    });
  }
  return contribution("links.path-layout", findings, input, examined, {
    partial: "Path layout scan was truncated",
    done: `${findings.length} documents outside the audit.paths layout`,
  });
};

/** True when any audited collection reports external URLs. */
export const needsAuditContents = (
  collections: readonly Collection[],
  auditedCollections: readonly string[]
): boolean => {
  const audited = new Set(auditedCollections);
  return collections.some(
    ({ name, audit }) => audited.has(name) && audit?.externalUrls === "report"
  );
};

export const evaluateCollectionAuditRules = (
  input: CollectionAuditRuleInput
): AuditRuleContribution[] => {
  const configured = configuredFor(input);
  if (configured.size === 0) return [];
  return [
    collectionPolicy(input, configured),
    externalUrls(input, configured),
    pathLayout(input, configured),
  ].filter((rule): rule is AuditRuleContribution => rule !== null);
};
