/**
 * Link parsing and normalization utilities.
 *
 * Parses wiki-style [[links]] and markdown [text](path.md) links.
 * Handles anchors, collection prefixes, and display text aliases.
 *
 * @module src/core/links
 */

// node:path/posix for POSIX paths (relPaths are always POSIX in gno)
import { posix as pathPosix } from "node:path";

import type { ExcludedRange } from "../ingestion/strip";

import { buildLineOffsets, offsetToPosition } from "../ingestion/position";
import { rangeIntersectsExcluded } from "../ingestion/strip";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type LinkKind = "wiki" | "markdown";

export interface ParsedLink {
  /** Link type */
  kind: LinkKind;
  /** Original text including brackets */
  raw: string;
  /** Path/name WITHOUT anchor or collection prefix */
  targetRef: string;
  /** Fragment without # */
  targetAnchor?: string;
  /** Explicit collection prefix */
  targetCollection?: string;
  /** Display text if different (truncated 256 graphemes) */
  displayText?: string;
  /** 1-based line number (in original doc) */
  startLine: number;
  /** 1-based column (in original doc) */
  startCol: number;
  /** 1-based end line */
  endLine: number;
  /** 1-based end column */
  endCol: number;
}

export interface TargetParts {
  /** Reference (name or path) without anchor */
  ref: string;
  /** Anchor/fragment without # */
  anchor?: string;
  /** Collection prefix */
  collection?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Max graphemes for display text before truncation */
const MAX_DISPLAY_TEXT_GRAPHEMES = 256;

/** Safe percent-encoded chars to decode */
const SAFE_PERCENT_DECODE: Record<string, string> = {
  "%20": " ",
  "%28": "(",
  "%29": ")",
};

/** Chars that should never be decoded (security) */
const UNSAFE_PERCENT_CODES = new Set(["%2F", "%5C", "%00", "%2f", "%5c"]);

// ─────────────────────────────────────────────────────────────────────────────
// Regex Patterns
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wiki link: [[target]] or [[target|alias]] or [[target#anchor]] or [[collection:target]]
 * Captures: 1=content inside brackets
 */
const WIKI_LINK_REGEX = /\[\[([^\]|]+(?:\|[^\]]+)?)\]\]/g;

/**
 * Markdown inline link: [text](url)
 * Captures: 1=text, 2=url (path and optional anchor)
 * Negative lookbehind to avoid image links ![]()
 *
 * SCOPE LIMITATIONS:
 * - Only matches simple inline links [text](url)
 * - Does NOT match reference-style links [text][ref] or [text]
 * - Does NOT match autolinks <url> or bare URLs
 * - Parens in URLs not supported (use %28 %29 encoding)
 */
const MARKDOWN_LINK_REGEX = /(?<!!)\[([^\]]*)\]\(([^)]+)\)/g;

/** External URL pattern (http:// https:// mailto: etc.) */
const EXTERNAL_URL_REGEX = /^[a-z][a-z0-9+.-]*:/i;

/** Collection prefix pattern: collection:rest */
const COLLECTION_PREFIX_REGEX = /^([a-z0-9_-]+):(.+)$/i;

// ─────────────────────────────────────────────────────────────────────────────
// Unicode Text Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Truncate text to max grapheme clusters (handles emoji, combining chars).
 * Uses Array.from for proper Unicode segmentation.
 */
export function truncateText(text: string, maxGraphemes: number): string {
  const graphemes = Array.from(text);
  if (graphemes.length <= maxGraphemes) {
    return text;
  }
  return graphemes.slice(0, maxGraphemes).join("");
}

/**
 * Normalize wiki name: NFC + lowercase + trim.
 * Used for matching wiki links to document titles.
 */
export function normalizeWikiName(name: string): string {
  return name.normalize("NFC").toLowerCase().trim();
}

/**
 * Strip a trailing .md extension (case-insensitive) without lowercasing.
 */
export function stripWikiMdExt(ref: string): string {
  const lower = ref.toLowerCase();
  return lower.endsWith(".md") ? ref.slice(0, -3) : ref;
}

/**
 * Extract basename from a wiki ref.
 * Strips path segments and a trailing .md extension (no normalization).
 */
export function extractWikiBasename(ref: string): string {
  const base = pathPosix.basename(ref.trim());
  return stripWikiMdExt(base);
}

// ─────────────────────────────────────────────────────────────────────────────
// Path Normalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Safe percent-decode for markdown paths.
 * Only decodes safe chars (space, parens).
 * Never decodes path separators or null bytes.
 */
function safePercentDecode(path: string): string {
  // Check for unsafe codes first
  for (const code of UNSAFE_PERCENT_CODES) {
    if (path.includes(code)) {
      // Contains unsafe code - don't decode anything
      return path;
    }
  }

  // Decode safe codes
  let result = path;
  for (const [encoded, decoded] of Object.entries(SAFE_PERCENT_DECODE)) {
    result = result.replaceAll(encoded, decoded);
  }
  return result;
}

/**
 * Normalize markdown path relative to source document.
 * Resolves ../ paths and ensures result stays within collection root.
 * Uses POSIX paths since relPaths are always POSIX in gno (even on Windows).
 *
 * @param rawPath - Raw path from link (may have ../, percent-encoding)
 * @param sourceRelPath - Relative path of source document from collection root (POSIX)
 * @returns Resolved relative path (POSIX), or null if path escapes collection
 */
export function normalizeMarkdownPath(
  rawPath: string,
  sourceRelPath: string
): string | null {
  // Reject backslashes early (Windows-style paths in markdown links)
  if (rawPath.includes("\\")) {
    return null;
  }

  // Decode safe percent-encoded chars
  const decoded = safePercentDecode(rawPath);

  // Remove anchor for path resolution
  const pathWithoutAnchor = decoded.split("#")[0] ?? decoded;

  // Handle absolute paths (unusual but possible)
  if (pathPosix.isAbsolute(pathWithoutAnchor)) {
    return null; // Reject absolute paths
  }

  // Resolve relative to source document's directory (POSIX)
  const sourceDir = pathPosix.dirname(sourceRelPath);
  const resolved = pathPosix.normalize(
    pathPosix.join(sourceDir, pathWithoutAnchor)
  );

  // Check if resolved path escapes the root (starts with ..)
  if (resolved.startsWith("..") || resolved.startsWith("/")) {
    return null;
  }

  // Additional check: ensure path doesn't contain traversal after normalization
  const parts = resolved.split("/");
  for (const part of parts) {
    if (part === "..") {
      return null;
    }
  }

  return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// Target Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse target into ref, anchor, and optional collection prefix.
 * Handles: "Note", "Note#Section", "collection:Note#Section"
 */
export function parseTargetParts(target: string): TargetParts {
  let remaining = target.trim();
  let collection: string | undefined;

  // Check for collection prefix (before any #)
  const hashIndex = remaining.indexOf("#");
  const textBeforeHash =
    hashIndex >= 0 ? remaining.slice(0, hashIndex) : remaining;

  const prefixMatch = COLLECTION_PREFIX_REGEX.exec(textBeforeHash);
  if (prefixMatch?.[1] && prefixMatch[2]) {
    collection = prefixMatch[1].toLowerCase(); // Normalize to lowercase for consistency
    // Reconstruct remaining without the collection prefix
    remaining =
      prefixMatch[2] + (hashIndex >= 0 ? remaining.slice(hashIndex) : "");
  }

  // Split on # for anchor
  const parts = remaining.split("#");
  const ref = (parts[0] ?? "").trim();
  const anchor = parts[1]?.trim();

  return {
    ref,
    anchor: anchor && anchor.length > 0 ? anchor : undefined,
    collection,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Link Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse all links from markdown content.
 * Skips links inside excluded ranges (code blocks, frontmatter, etc.).
 *
 * @param markdown - Original markdown content
 * @param lineOffsets - Precomputed line offsets from buildLineOffsets()
 * @param excludedRanges - Ranges to skip from getExcludedRanges()
 */
export function parseLinks(
  markdown: string,
  lineOffsets: number[],
  excludedRanges: ExcludedRange[]
): ParsedLink[] {
  const links: ParsedLink[] = [];

  // Parse wiki links
  WIKI_LINK_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = WIKI_LINK_REGEX.exec(markdown)) !== null) {
    const startOffset = match.index;
    const endOffset = startOffset + match[0].length;

    // Skip if inside excluded range
    if (rangeIntersectsExcluded(startOffset, endOffset, excludedRanges)) {
      continue;
    }

    const content = match[1];
    if (!content) continue;

    // Parse [[target|alias]] format
    const pipeIndex = content.indexOf("|");
    let targetPart: string;
    let displayText: string | undefined;

    if (pipeIndex >= 0) {
      targetPart = content.slice(0, pipeIndex);
      const aliasText = content.slice(pipeIndex + 1);
      // Only set displayText if different from target
      displayText =
        aliasText !== targetPart
          ? truncateText(aliasText, MAX_DISPLAY_TEXT_GRAPHEMES)
          : undefined;
    } else {
      targetPart = content;
    }

    const trimmedTarget = targetPart.trim();
    const hasScheme =
      /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmedTarget) ||
      trimmedTarget.startsWith("mailto:");
    if (hasScheme || trimmedTarget.startsWith("//")) {
      continue;
    }

    const parts = parseTargetParts(trimmedTarget);
    if (!parts.ref) continue;

    const startPos = offsetToPosition(startOffset, lineOffsets);
    const endPos = offsetToPosition(endOffset, lineOffsets);

    links.push({
      kind: "wiki",
      raw: match[0],
      targetRef: parts.ref,
      targetAnchor: parts.anchor,
      targetCollection: parts.collection,
      displayText,
      startLine: startPos.line,
      startCol: startPos.col,
      endLine: endPos.line,
      endCol: endPos.col,
    });
  }

  // Parse markdown links
  MARKDOWN_LINK_REGEX.lastIndex = 0;

  while ((match = MARKDOWN_LINK_REGEX.exec(markdown)) !== null) {
    const startOffset = match.index;
    const endOffset = startOffset + match[0].length;

    // Skip if inside excluded range
    if (rangeIntersectsExcluded(startOffset, endOffset, excludedRanges)) {
      continue;
    }

    const linkText = match[1] ?? "";
    const url = match[2];
    if (!url) continue;

    // Skip external URLs
    if (EXTERNAL_URL_REGEX.test(url)) {
      continue;
    }

    // Skip URLs that look like protocol-relative (//example.com)
    if (url.startsWith("//")) {
      continue;
    }

    // Parse URL and anchor
    const hashIndex = url.indexOf("#");
    let path: string;
    let anchor: string | undefined;

    if (hashIndex >= 0) {
      path = url.slice(0, hashIndex);
      const anchorPart = url.slice(hashIndex + 1);
      anchor = anchorPart.length > 0 ? anchorPart : undefined;
    } else {
      path = url;
    }

    // Skip empty paths (anchor-only links like #section)
    if (!path) {
      continue;
    }

    // Check for collection prefix in path
    const parts = parseTargetParts(path);
    if (parts.collection) {
      // Markdown cross-collection links are not supported
      continue;
    }

    const startPos = offsetToPosition(startOffset, lineOffsets);
    const endPos = offsetToPosition(endOffset, lineOffsets);

    // Display text is the link text if different from path
    const displayText =
      linkText && linkText !== parts.ref
        ? truncateText(linkText, MAX_DISPLAY_TEXT_GRAPHEMES)
        : undefined;

    links.push({
      kind: "markdown",
      raw: match[0],
      targetRef: parts.ref,
      targetAnchor: anchor ?? parts.anchor,
      targetCollection: parts.collection,
      displayText,
      startLine: startPos.line,
      startCol: startPos.col,
      endLine: endPos.line,
      endCol: endPos.col,
    });
  }

  // Sort by position for consistent ordering
  links.sort((a, b) => {
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    return a.startCol - b.startCol;
  });

  return links;
}

/**
 * Convenience function to parse links with automatic line offset computation.
 */
export function parseLinksFromContent(
  markdown: string,
  excludedRanges: ExcludedRange[]
): ParsedLink[] {
  const lineOffsets = buildLineOffsets(markdown);
  return parseLinks(markdown, lineOffsets, excludedRanges);
}
