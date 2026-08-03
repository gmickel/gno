/**
 * Conservative destination relevance for reference-safe file refactors.
 *
 * Uses exact token/path/basename equality after stripping query/fragment,
 * safe decoding, NFC normalization, and syntax delimiters. No fuzzy
 * substring matching — unrelated `other-note.md` must not match `note.md`.
 *
 * @module src/core/link-relevance
 */

// node:path/posix — no Bun path utils
import { posix as pathPosix } from "node:path";

import {
  stripAngleBracketDestination,
  unescapeCommonMarkDestination,
} from "./link-destination-parse";
import { normalizeWikiName, stripWikiMdExt } from "./links";

function safeDecodeForRelevance(value: string): string {
  return value
    .replaceAll("%20", " ")
    .replaceAll("%28", "(")
    .replaceAll("%29", ")");
}

function stripQueryAndFragment(value: string): string {
  const hash = value.indexOf("#");
  const withoutHash = hash >= 0 ? value.slice(0, hash) : value;
  const query = withoutHash.indexOf("?");
  return query >= 0 ? withoutHash.slice(0, query) : withoutHash;
}

function addKey(keys: Set<string>, value: string): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  keys.add(normalizeWikiName(trimmed));
  keys.add(normalizeWikiName(stripWikiMdExt(trimmed)));
  keys.add(trimmed.toLowerCase());
  keys.add(stripWikiMdExt(trimmed).toLowerCase());
  const base = pathPosix.basename(trimmed);
  keys.add(normalizeWikiName(base));
  keys.add(normalizeWikiName(stripWikiMdExt(base)));
  keys.add(base.toLowerCase());
  keys.add(stripWikiMdExt(base).toLowerCase());
}

/** Build lookup keys used to decide whether a destination is about the source. */
export function buildSourceRelevanceKeys(input: {
  relPath: string;
  title: string | null | undefined;
}): Set<string> {
  const keys = new Set<string>();
  addKey(keys, input.relPath);
  addKey(keys, input.relPath.normalize("NFC"));
  addKey(keys, input.relPath.normalize("NFD"));
  if (input.title) {
    addKey(keys, input.title);
    addKey(keys, input.title.normalize("NFC"));
    addKey(keys, input.title.normalize("NFD"));
  }
  return keys;
}

/**
 * Normalize a destination token into candidate equality keys (exact only).
 */
export function destinationRelevanceCandidates(destination: string): string[] {
  const trimmed = destination.trim();
  if (!trimmed) return [];

  const { path: withoutAngles } = stripAngleBracketDestination(trimmed);
  const unescaped = unescapeCommonMarkDestination(withoutAngles);
  const withoutQueryFrag = stripQueryAndFragment(unescaped);
  const decoded = safeDecodeForRelevance(withoutQueryFrag);

  const forms = [
    trimmed,
    withoutAngles,
    unescaped,
    withoutQueryFrag,
    decoded,
    withoutQueryFrag.normalize("NFC"),
    withoutQueryFrag.normalize("NFD"),
    decoded.normalize("NFC"),
    decoded.normalize("NFD"),
  ];

  const keys = new Set<string>();
  for (const form of forms) {
    addKey(keys, form);
  }
  return [...keys];
}

/**
 * Exact-token relevance: true only when a normalized destination key equals a
 * source key. Malformed prefixes may still match when the prefix token itself
 * equals a source key (bounded exact equality, not substring).
 */
export function isRelevantDestination(
  destination: string,
  sourceKeys: ReadonlySet<string>
): boolean {
  const candidates = destinationRelevanceCandidates(destination);
  return candidates.some((key) => sourceKeys.has(key));
}

/**
 * Content-prefilter needle strings for SQL LIKE (caller escapes wildcards).
 * Conservative: source path/title identities and common escape encodings.
 */
export function buildContentPrefilterNeedles(input: {
  relPath: string;
  title: string | null | undefined;
}): string[] {
  const needles = new Set<string>();
  const add = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length < 2) return;
    needles.add(trimmed);
    needles.add(trimmed.normalize("NFC"));
    needles.add(trimmed.normalize("NFD"));
    needles.add(trimmed.replaceAll(" ", "%20"));
    needles.add(
      trimmed
        .replaceAll(" ", "%20")
        .replaceAll("(", "%28")
        .replaceAll(")", "%29")
    );
    needles.add(trimmed.replaceAll("(", "%28").replaceAll(")", "%29"));
    needles.add(
      trimmed
        .replaceAll(" ", "\\ ")
        .replaceAll("(", "\\(")
        .replaceAll(")", "\\)")
    );
    needles.add(trimmed.replaceAll("(", "\\(").replaceAll(")", "\\)"));
  };

  add(input.relPath);
  add(pathPosix.basename(input.relPath));
  add(stripWikiMdExt(pathPosix.basename(input.relPath)));
  add(stripWikiMdExt(input.relPath));
  if (input.title) {
    add(input.title);
    add(`${input.title}.md`);
  }
  return [...needles].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
