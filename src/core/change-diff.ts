/**
 * Bounded, content-free structural snapshots for document change journaling.
 *
 * The snapshot values are normalized summaries only. Source bodies are used
 * transiently during sync and are never included in a journal delta.
 */

import type {
  DocumentChangeStructureDelta,
  DocumentChangeSet,
} from "../store/types";

import { parseFrontmatter } from "../ingestion/frontmatter";
import { buildLineOffsets } from "../ingestion/position";
import { getExcludedRanges } from "../ingestion/strip";
import { normalizeMarkdownPath, normalizeWikiName, parseLinks } from "./links";
import { extractSections } from "./sections";

export type RelationMap = Record<string, string[]>;

export interface DocumentStructureSnapshot {
  headings: string[];
  links: string[];
  typedEdges: string[];
  dates: Record<string, string>;
}

export interface DocumentStructureDeltaResult {
  delta: DocumentChangeStructureDelta;
  history: "available" | "unavailable";
}

const RELATION_EDGE_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;

export function isRelationMap(value: unknown): value is RelationMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(
    (targets) =>
      Array.isArray(targets) &&
      targets.every((target) => typeof target === "string")
  );
}

export function normalizeRelationTarget(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[[") && trimmed.endsWith("]]")) {
    return trimmed.slice(2, -2).split("|")[0]?.trim() ?? "";
  }
  return trimmed;
}

export function normalizeRelationEdgeType(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
}

const withOccurrences = (values: readonly string[]): string[] => {
  const counts = new Map<string, number>();
  return values
    .map((value) => {
      const count = (counts.get(value) ?? 0) + 1;
      counts.set(value, count);
      return count === 1 ? value : `${value} [${count}]`;
    })
    .sort();
};

const linkSummary = (
  link: ReturnType<typeof parseLinks>[number],
  relPath: string
): string | null => {
  const anchor = link.targetAnchor
    ? `#${normalizeWikiName(link.targetAnchor)}`
    : "";
  if (link.kind === "wiki") {
    const collection = link.targetCollection
      ? `${normalizeWikiName(link.targetCollection)}:`
      : "";
    return `wiki:${collection}${normalizeWikiName(link.targetRef)}${anchor}`;
  }
  const target = normalizeMarkdownPath(link.targetRef, relPath);
  return target ? `markdown:${target}${anchor}` : null;
};

const extractTypedEdges = (markdown: string): string[] => {
  const relations = parseFrontmatter(markdown).metadata.relations;
  if (!isRelationMap(relations)) return [];

  const values: string[] = [];
  for (const [rawEdgeType, targets] of Object.entries(relations)) {
    const edgeType = normalizeRelationEdgeType(rawEdgeType);
    if (!RELATION_EDGE_TYPE_PATTERN.test(edgeType)) continue;
    for (const rawTarget of targets) {
      const target = normalizeRelationTarget(rawTarget);
      if (target) {
        values.push(`${edgeType}:${normalizeWikiName(target)}`);
      }
    }
  }
  return [...new Set(values)].sort();
};

export const extractDocumentStructure = (
  markdown: string,
  relPath: string,
  dateFields: Readonly<Record<string, string>> | null | undefined
): DocumentStructureSnapshot => {
  const excludedRanges = getExcludedRanges(markdown);
  const links = parseLinks(markdown, buildLineOffsets(markdown), excludedRanges)
    .map((link) => linkSummary(link, relPath))
    .filter((value): value is string => value !== null);

  return {
    headings: withOccurrences(
      extractSections(markdown).map(
        ({ level, title }) => `${"#".repeat(level)} ${title.normalize("NFC")}`
      )
    ),
    links: withOccurrences(links),
    typedEdges: extractTypedEdges(markdown),
    dates: { ...dateFields },
  };
};

const diffValues = (
  previous: readonly string[],
  next: readonly string[]
): DocumentChangeSet => {
  const previousValues = new Set(previous);
  const nextValues = new Set(next);
  return {
    added: next.filter((value) => !previousValues.has(value)),
    removed: previous.filter((value) => !nextValues.has(value)),
  };
};

export const diffDocumentStructure = (
  previous: DocumentStructureSnapshot | null | undefined,
  next: DocumentStructureSnapshot
): DocumentStructureDeltaResult => {
  if (previous === undefined) {
    return {
      history: "unavailable",
      delta: {
        headings: { added: [], removed: [] },
        links: { added: [], removed: [] },
        typedEdges: { added: [], removed: [] },
        dates: { added: [], removed: [], changed: [] },
        truncated: true,
      },
    };
  }

  const prior = previous ?? {
    headings: [],
    links: [],
    typedEdges: [],
    dates: {},
  };
  const priorDateKeys = Object.keys(prior.dates).sort();
  const nextDateKeys = Object.keys(next.dates).sort();
  const dates = diffValues(priorDateKeys, nextDateKeys);
  const changed = priorDateKeys.filter(
    (key) =>
      Object.hasOwn(next.dates, key) && prior.dates[key] !== next.dates[key]
  );

  return {
    history: "available",
    delta: {
      headings: diffValues(prior.headings, next.headings),
      links: diffValues(prior.links, next.links),
      typedEdges: diffValues(prior.typedEdges, next.typedEdges),
      dates: { ...dates, changed },
      truncated: false,
    },
  };
};
