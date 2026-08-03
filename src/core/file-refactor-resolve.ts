/**
 * In-memory wiki/markdown target resolution for reference-safe refactors.
 *
 * Mirrors SqliteAdapter / graph-link-resolver ranking and uniqueness rules:
 * best-rank candidate sets with more than one document are ambiguous.
 *
 * Catalog is already bounded (≤5000). Candidate collection never silently
 * truncates mid-scan — the full bounded catalog is evaluated.
 *
 * @module src/core/file-refactor-resolve
 */

// node:path/posix — no Bun path utils
import { posix as pathPosix } from "node:path";

import type { FileRefactorReasonCode } from "./file-refactor-contract";

import {
  stripAngleBracketDestination,
  unescapeCommonMarkDestination,
} from "./link-destination-parse";
import {
  normalizeMarkdownPath,
  normalizeWikiName,
  stripWikiMdExt,
} from "./links";

export const FILE_REFACTOR_RESOLVE_CAPS = {
  maxCatalogDocuments: 5_000,
} as const;

export interface FileRefactorCatalogDocument {
  /** Stable numeric id for deterministic tie-breaks (matches documents.id). */
  id: number;
  uri: string;
  relPath: string;
  collection: string;
  title: string | null;
  active?: boolean;
}

export type FileRefactorResolutionStatus =
  | "unique"
  | "ambiguous"
  | "unresolved"
  | "elsewhere";

export interface FileRefactorResolution {
  status: FileRefactorResolutionStatus;
  /** Present when status is unique and matches the expected source. */
  document?: FileRefactorCatalogDocument;
  matchRank?: number;
  matchCount: number;
  reasonCode?: FileRefactorReasonCode;
  candidates: FileRefactorCatalogDocument[];
}

function lowerTrim(value: string): string {
  return value.toLowerCase().trim();
}

function endsWithPathSegment(target: string, value: string): boolean {
  if (!value) return false;
  if (target === value) return true;
  return target.endsWith(`/${value}`);
}

function wikiMatchRank(
  targetRefNorm: string,
  doc: FileRefactorCatalogDocument
): number | null {
  const baseRef = stripWikiMdExt(targetRefNorm);
  const baseRefMd = `${baseRef}.md`;
  const title = lowerTrim(doc.title ?? "");
  const rel = doc.relPath.toLowerCase();

  if (title === baseRef) return 1;
  if (title === baseRefMd) return 2;
  if (endsWithPathSegment(baseRef, title)) return 3;
  if (endsWithPathSegment(baseRefMd, `${title}.md`)) return 4;
  if (rel === baseRef) return 5;
  if (rel === baseRefMd) return 6;
  if (endsWithPathSegment(rel, baseRefMd)) return 7;
  if (endsWithPathSegment(rel, baseRef)) return 8;
  if (endsWithPathSegment(baseRefMd, rel)) return 9;
  if (endsWithPathSegment(baseRef, rel)) return 10;
  return null;
}

function collectWikiCandidates(
  targetRefNorm: string,
  collection: string,
  catalog: readonly FileRefactorCatalogDocument[]
): Array<{ doc: FileRefactorCatalogDocument; rank: number }> {
  const matches: Array<{ doc: FileRefactorCatalogDocument; rank: number }> = [];
  for (const doc of catalog) {
    if (doc.active === false) continue;
    if (doc.collection !== collection) continue;
    const rank = wikiMatchRank(targetRefNorm, doc);
    if (rank === null) continue;
    matches.push({ doc, rank });
  }
  return matches;
}

function detectUnicodeAmbiguity(
  targetRefNorm: string,
  collection: string,
  catalog: readonly FileRefactorCatalogDocument[],
  best: FileRefactorCatalogDocument[]
): boolean {
  const nfcKey = normalizeWikiName(stripWikiMdExt(targetRefNorm));
  if (!nfcKey) return false;
  const nfcMatches: FileRefactorCatalogDocument[] = [];
  for (const doc of catalog) {
    if (doc.active === false) continue;
    if (doc.collection !== collection) continue;
    const titleKey = normalizeWikiName(doc.title ?? "");
    const relKey = normalizeWikiName(stripWikiMdExt(doc.relPath));
    const baseKey = normalizeWikiName(
      stripWikiMdExt(pathPosix.basename(doc.relPath))
    );
    if (titleKey === nfcKey || relKey === nfcKey || baseKey === nfcKey) {
      nfcMatches.push(doc);
    }
  }
  if (nfcMatches.length <= 1) return false;
  const bestIds = new Set(best.map((doc) => doc.id));
  return nfcMatches.some((doc) => !bestIds.has(doc.id));
}

/**
 * Resolve a wiki target against a bounded catalog. Never picks the first
 * candidate and calls it unique when the best-rank set has multiple docs.
 */
export function resolveWikiTarget(input: {
  targetRef: string;
  targetCollection: string;
  sourceUri: string;
  catalog: readonly FileRefactorCatalogDocument[];
}): FileRefactorResolution {
  const targetRefNorm = normalizeWikiName(input.targetRef);
  const matches = collectWikiCandidates(
    targetRefNorm,
    input.targetCollection,
    input.catalog
  );

  if (matches.length === 0) {
    return { status: "unresolved", matchCount: 0, candidates: [] };
  }

  let bestRank = Number.POSITIVE_INFINITY;
  for (const match of matches) {
    if (match.rank < bestRank) bestRank = match.rank;
  }
  const best = matches
    .filter((match) => match.rank === bestRank)
    .map((match) => match.doc)
    .sort((a, b) => a.id - b.id);

  const includesSource = best.some((doc) => doc.uri === input.sourceUri);
  const duplicateBasenames = new Set(
    best.map((doc) =>
      normalizeWikiName(stripWikiMdExt(pathPosix.basename(doc.relPath)))
    )
  );

  if (best.length > 1) {
    const reasonCode: FileRefactorReasonCode =
      duplicateBasenames.size < best.length || best.length > 1
        ? "duplicate_basename_ambiguity"
        : "ambiguous_resolution";
    return {
      status: "ambiguous",
      matchRank: bestRank,
      matchCount: best.length,
      reasonCode: includesSource ? reasonCode : "ambiguous_resolution",
      candidates: best,
    };
  }

  if (
    detectUnicodeAmbiguity(
      targetRefNorm,
      input.targetCollection,
      input.catalog,
      best
    )
  ) {
    return {
      status: "ambiguous",
      matchRank: bestRank,
      matchCount: best.length + 1,
      reasonCode: "unicode_normalization_mismatch",
      candidates: best,
    };
  }

  const unique = best[0];
  if (!unique) {
    return { status: "unresolved", matchCount: 0, candidates: [] };
  }
  if (unique.uri !== input.sourceUri) {
    return {
      status: "elsewhere",
      document: unique,
      matchRank: bestRank,
      matchCount: 1,
      candidates: best,
    };
  }
  return {
    status: "unique",
    document: unique,
    matchRank: bestRank,
    matchCount: 1,
    candidates: best,
  };
}

/**
 * Resolve a markdown path target (already normalized to collection-relative).
 */
export function resolveMarkdownTarget(input: {
  targetRefNorm: string;
  targetCollection: string;
  sourceUri: string;
  catalog: readonly FileRefactorCatalogDocument[];
}): FileRefactorResolution {
  const matches = input.catalog
    .filter(
      (doc) =>
        doc.active !== false &&
        doc.collection === input.targetCollection &&
        doc.relPath === input.targetRefNorm
    )
    .sort((a, b) => a.id - b.id);

  if (matches.length === 0) {
    return { status: "unresolved", matchCount: 0, candidates: [] };
  }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      matchCount: matches.length,
      reasonCode: "ambiguous_resolution",
      candidates: matches,
    };
  }
  const unique = matches[0]!;
  if (unique.uri !== input.sourceUri) {
    return {
      status: "elsewhere",
      document: unique,
      matchCount: 1,
      candidates: matches,
    };
  }
  return {
    status: "unique",
    document: unique,
    matchCount: 1,
    candidates: matches,
  };
}

/**
 * Normalize a markdown inventory destination relative to the referring doc.
 * Unescapes CommonMark punctuation and strips angle brackets before the shared
 * path normalizer (which rejects raw backslashes).
 */
export function normalizeInventoryMarkdownTarget(
  destination: string,
  referringRelPath: string
): string | null {
  const angled = stripAngleBracketDestination(destination);
  const unescaped = unescapeCommonMarkDestination(angled.path);
  return normalizeMarkdownPath(unescaped, referringRelPath);
}
