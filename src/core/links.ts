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
import {
  isBackslashEscaped,
  parseParenthesizedDestination,
  stripAngleBracketDestination,
  unescapeCommonMarkDestination,
} from "./link-destination-parse";

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

interface WikiLinkMatch {
  index: number;
  raw: string;
  content: string;
}

/**
 * Wiki links: [[target]], [[target|alias]], [[target#anchor]] or
 * [[collection:target]]. Matches exactly what
 * `/\[\[([^\]|]+(?:\|[^\]]+)?)\]\]/g` matches, in one pass: the content runs
 * to the first `]`, which must be doubled; it must not start with `|`, and a
 * `|` in it needs text after it. The regex rescanned to that `]` from every
 * unclosed `[[`, so a note with thousands of them took minutes.
 */
export function* findWikiLinks(
  markdown: string
): Generator<WikiLinkMatch, void, undefined> {
  let nextClose = -2;
  let nextPipe = -2;
  let start = markdown.indexOf("[[");
  while (start !== -1) {
    const contentStart = start + 2;
    if (nextClose < contentStart) {
      nextClose = markdown.indexOf("]", contentStart);
      if (nextClose === -1) return;
    }
    if (nextPipe !== -1 && nextPipe < contentStart) {
      nextPipe = markdown.indexOf("|", contentStart);
    }
    const pipeInContent = nextPipe !== -1 && nextPipe < nextClose;
    const matched =
      markdown.charCodeAt(nextClose + 1) === 93 /* ] */ &&
      nextClose > contentStart &&
      nextPipe !== contentStart &&
      (!pipeInContent || nextClose > nextPipe + 1);
    if (matched) {
      yield {
        index: start,
        raw: markdown.slice(start, nextClose + 2),
        content: markdown.slice(contentStart, nextClose),
      };
      start = markdown.indexOf("[[", nextClose + 2);
    } else {
      start = markdown.indexOf("[[", start + 1);
    }
  }
}

/** Logseq embed: {{embed [[Page]]}} or {{embed ((block-id))}} */
const LOGSEQ_EMBED_REGEX =
  /\{\{\s*embed\s+(\[\[[^\]]+\]\]|\(\([^)]+\)\))\s*\}\}/gi;

/**
 * Markdown inline link opener: `[text](`, up to and including the `(`.
 * Captures: 1=text. The destination after `(` is read by
 * parseParenthesizedDestination, as CommonMark reads it.
 * Negative lookbehind to avoid image links ![]()
 * Link text may contain balanced square brackets one level deep
 * (`[see [1]](note.md)`), as CommonMark allows; a backslash-escaped bracket
 * (`\]`, `\[`) in the text is literal and never opens or closes it.
 *
 * SCOPE LIMITATIONS:
 * - Only matches simple inline links [text](url)
 * - Does NOT match reference-style links [text][ref] or [text]
 * - Does NOT match autolinks <url> or bare URLs
 */
const MARKDOWN_LINK_REGEX =
  /(?<!!)\[((?:\\[\s\S]|[^[\]\\]|\[(?:\\[\s\S]|[^[\]\\])*\])*)\]\(/g;

/** Logseq alias destination at the `(`: `([[Target]])`. */
const LOGSEQ_ALIAS_DESTINATION_REGEX = /\((\[\[[^)]*\]\])\)/y;

/** Square brackets in a destination mean the text was split, not a path. */
const BRACKET_IN_DESTINATION_REGEX = /[[\]]/;

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

/**
 * Split the content of a wiki link into target and alias. Obsidian also reads
 * `\|` (the pipe escaped inside a Markdown table) as the alias separator,
 * so `[[Note\|Alias]]` targets `Note`, not `Note\`.
 */
export function splitWikiLinkContent(content: string): {
  target: string;
  alias?: string;
} {
  const pipeIndex = content.indexOf("|");
  if (pipeIndex < 0) {
    return { target: content };
  }
  const escaped = pipeIndex > 0 && content[pipeIndex - 1] === "\\";
  return {
    target: content.slice(0, escaped ? pipeIndex - 1 : pipeIndex),
    alias: content.slice(pipeIndex + 1),
  };
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
 * Read an inline link destination at the `(` after `[text]`, the way
 * CommonMark reads it: optional title, balanced parentheses, and no
 * unescaped whitespace unless wrapped in `<...>`. Returns the unescaped
 * destination (angle brackets removed) and the offset after the closing `)`,
 * or null when the text is not a link. A Logseq alias `([[Target]])` is
 * returned verbatim.
 */
function readInlineDestination(
  markdown: string,
  parenOffset: number
): { url: string; endOffset: number; logseqAlias: boolean } | null {
  LOGSEQ_ALIAS_DESTINATION_REGEX.lastIndex = parenOffset;
  const logseq = LOGSEQ_ALIAS_DESTINATION_REGEX.exec(markdown);
  if (logseq) {
    return {
      url: logseq[1] ?? "",
      endOffset: parenOffset + logseq[0].length,
      logseqAlias: true,
    };
  }
  const parsed = parseParenthesizedDestination(markdown, parenOffset);
  if (!parsed || parsed.destinationRaw.includes("\n")) {
    return null;
  }
  return {
    url: unescapeCommonMarkDestination(
      stripAngleBracketDestination(parsed.destinationRaw).path
    ),
    endOffset: parsed.closeParenOffset + 1,
    logseqAlias: false,
  };
}

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

  const pushWikiLink = (
    raw: string,
    target: string,
    startOffset: number,
    endOffset: number,
    displayText?: string
  ): void => {
    const trimmedTarget = target.trim();
    const hasScheme =
      /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmedTarget) ||
      trimmedTarget.startsWith("mailto:");
    if (hasScheme || trimmedTarget.startsWith("//")) {
      return;
    }

    const parts = parseTargetParts(trimmedTarget);
    if (!parts.ref) {
      return;
    }

    const startPos = offsetToPosition(startOffset, lineOffsets);
    const endPos = offsetToPosition(endOffset, lineOffsets);

    links.push({
      kind: "wiki",
      raw,
      targetRef: parts.ref,
      targetAnchor: parts.anchor,
      targetCollection: parts.collection,
      displayText,
      startLine: startPos.line,
      startCol: startPos.col,
      endLine: endPos.line,
      endCol: endPos.col,
    });
  };

  // Parse wiki links
  for (const wiki of findWikiLinks(markdown)) {
    const startOffset = wiki.index;
    const endOffset = startOffset + wiki.raw.length;

    // Skip [[target]] nested in Logseq alias syntax: [Display]([[target]])
    if (
      markdown.slice(Math.max(0, startOffset - 2), startOffset) === "](" &&
      markdown.slice(endOffset, endOffset + 1) === ")"
    ) {
      continue;
    }

    // Skip if inside excluded range
    if (rangeIntersectsExcluded(startOffset, endOffset, excludedRanges)) {
      continue;
    }

    // Parse [[target|alias]] (and table-escaped [[target\|alias]]) format
    const { target: targetPart, alias: aliasText } = splitWikiLinkContent(
      wiki.content
    );
    // Only set displayText if different from target
    const displayText =
      aliasText !== undefined && aliasText !== targetPart
        ? truncateText(aliasText, MAX_DISPLAY_TEXT_GRAPHEMES)
        : undefined;

    const trimmedTarget = targetPart.trim();
    if (!trimmedTarget) {
      continue;
    }
    pushWikiLink(wiki.raw, trimmedTarget, startOffset, endOffset, displayText);
  }

  // Parse Logseq embeds as links
  LOGSEQ_EMBED_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = LOGSEQ_EMBED_REGEX.exec(markdown)) !== null) {
    const startOffset = match.index;
    const endOffset = startOffset + match[0].length;

    if (rangeIntersectsExcluded(startOffset, endOffset, excludedRanges)) {
      continue;
    }

    const embedTarget = match[1]?.trim();
    if (!embedTarget) {
      continue;
    }

    if (embedTarget.startsWith("((") && embedTarget.endsWith("))")) {
      const blockId = embedTarget.slice(2, -2).trim();
      if (blockId.length === 0) {
        continue;
      }
      pushWikiLink(match[0], blockId, startOffset, endOffset);
    }
  }

  // Parse markdown links
  MARKDOWN_LINK_REGEX.lastIndex = 0;

  while ((match = MARKDOWN_LINK_REGEX.exec(markdown)) !== null) {
    const startOffset = match.index;
    const parenOffset = startOffset + match[0].length - 1;

    // `\[` is literal text in CommonMark: it cannot open a link. A link
    // may still start at a later `[` inside the text.
    if (isBackslashEscaped(markdown, startOffset)) {
      MARKDOWN_LINK_REGEX.lastIndex = startOffset + 1;
      continue;
    }

    const destination = readInlineDestination(markdown, parenOffset);
    // Not a link: a destination with an unescaped space outside `<...>`
    // (`[x](my note.md)`) or no closing parenthesis. It is plain text; a link
    // may still start at a later `[` inside the text.
    if (!destination) {
      MARKDOWN_LINK_REGEX.lastIndex = startOffset + 1;
      continue;
    }
    const endOffset = destination.endOffset;
    MARKDOWN_LINK_REGEX.lastIndex = endOffset;

    // Skip if inside excluded range
    if (rangeIntersectsExcluded(startOffset, endOffset, excludedRanges)) {
      continue;
    }

    const raw = markdown.slice(startOffset, endOffset);
    const linkText = match[1] ?? "";
    const { url } = destination;
    if (!url) continue;

    // Logseq alias syntax: [Display]([[Target]])
    if (destination.logseqAlias) {
      const innerTarget = url.slice(2, -2).trim();
      if (innerTarget.length > 0) {
        const displayText =
          linkText && linkText !== innerTarget
            ? truncateText(linkText, MAX_DISPLAY_TEXT_GRAPHEMES)
            : undefined;
        pushWikiLink(raw, innerTarget, startOffset, endOffset, displayText);
      }
      continue;
    }

    // Skip external URLs
    if (EXTERNAL_URL_REGEX.test(url)) {
      continue;
    }

    // Brackets in the destination come from link text split at an
    // unbalanced bracket (`[a [b](c](d)`): unparseable, not a missing target.
    if (BRACKET_IN_DESTINATION_REGEX.test(url)) {
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
      raw,
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
