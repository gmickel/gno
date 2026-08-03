/**
 * Deterministic Markdown/Obsidian image discovery for publish attachments.
 * Uses a state-machine for CommonMark-style inline image destinations;
 * excludes frontmatter/code via ingestion strip helpers.
 *
 * @module src/publish/attachment-discover
 */

import { getExcludedRanges, rangeIntersectsExcluded } from "../ingestion/strip";

export interface DiscoveredImageRef {
  /** Raw alt/alias text between brackets (as authored). */
  alt: string;
  end: number;
  kind: "markdown" | "obsidian";
  /** Destination / embed path used for resolution (unescaped). */
  sourceRef: string;
  start: number;
}

const isAsciiWhitespace = (ch: string): boolean =>
  ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

const skipAsciiWhitespace = (text: string, index: number): number => {
  let i = index;
  while (i < text.length && isAsciiWhitespace(text[i] ?? "")) i += 1;
  return i;
};

const isEscapedMarker = (text: string, index: number): boolean => {
  let backslashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && text[cursor] === "\\";
    cursor -= 1
  ) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
};

const parseObsidianTarget = (
  raw: string
): { alias: string; pathPart: string } => {
  const pipe = raw.indexOf("|");
  const pathWithFrag = pipe >= 0 ? raw.slice(0, pipe) : raw;
  const alias = pipe >= 0 ? raw.slice(pipe + 1).trim() : "";
  const hash = pathWithFrag.indexOf("#");
  const pathPart = (
    hash >= 0 ? pathWithFrag.slice(0, hash) : pathWithFrag
  ).trim();
  return { alias, pathPart };
};

/**
 * Parse `![[...]]` starting at bangIndex (`!`). Returns null if malformed.
 */
const parseObsidianEmbedAt = (
  text: string,
  bangIndex: number
): DiscoveredImageRef | null => {
  if (text.slice(bangIndex, bangIndex + 3) !== "![[") return null;
  let i = bangIndex + 3;
  let raw = "";
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (ch === "]" && text[i + 1] === "]") {
      const parsed = parseObsidianTarget(raw);
      return {
        alt: parsed.alias,
        end: i + 2,
        kind: "obsidian",
        sourceRef: parsed.pathPart,
        start: bangIndex,
      };
    }
    if (ch === "\n" || ch === "\r") return null;
    raw += ch;
    i += 1;
  }
  return null;
};

/**
 * Parse link-text (alt) with escapes and balanced brackets after `![`.
 * Returns index after the closing `]` and the raw alt slice.
 */
const parseLinkText = (
  text: string,
  start: number
): { alt: string; next: number } | null => {
  let i = start;
  let depth = 1;
  const altStart = i;
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (ch === "\\" && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (ch === "[") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        return { alt: text.slice(altStart, i), next: i + 1 };
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return null;
};

/**
 * Parse an unbracketed destination with escapes and nested balanced parentheses.
 * Stops at ASCII whitespace or a closing `)` at paren depth 0.
 */
const parseUnbracketedDestination = (
  text: string,
  start: number
): { dest: string; next: number } | null => {
  let i = start;
  let parenDepth = 0;
  let dest = "";
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (ch === "\\" && i + 1 < text.length) {
      dest += text[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (ch === "(") {
      parenDepth += 1;
      dest += ch;
      i += 1;
      continue;
    }
    if (ch === ")") {
      if (parenDepth === 0) break;
      parenDepth -= 1;
      dest += ch;
      i += 1;
      continue;
    }
    if (isAsciiWhitespace(ch)) break;
    dest += ch;
    i += 1;
  }
  if (parenDepth !== 0) return null;
  return { dest, next: i };
};

/**
 * Parse `<angle-bracket>` destination with escapes.
 */
const parseAngleDestination = (
  text: string,
  start: number
): { dest: string; next: number } | null => {
  if (text[start] !== "<") return null;
  let i = start + 1;
  let dest = "";
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (ch === "\\" && i + 1 < text.length) {
      dest += text[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (ch === "\n" || ch === "\r") return null;
    if (ch === ">") return { dest, next: i + 1 };
    dest += ch;
    i += 1;
  }
  return null;
};

/**
 * Skip optional quoted/parenthesized title. Advances past closing delimiter.
 */
const skipOptionalTitle = (text: string, start: number): number | null => {
  const opener = text[start];
  if (opener !== '"' && opener !== "'" && opener !== "(") return start;
  const closer = opener === "(" ? ")" : opener;
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (ch === "\\" && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (ch === "\n" || ch === "\r") return null;
    if (ch === closer) return i + 1;
    i += 1;
  }
  return null;
};

/**
 * Parse `![alt](dest "title")` starting at bangIndex (`!`).
 */
const parseMarkdownImageAt = (
  text: string,
  bangIndex: number
): DiscoveredImageRef | null => {
  if (text[bangIndex] !== "!" || text[bangIndex + 1] !== "[") return null;
  // Obsidian embeds are handled separately.
  if (text[bangIndex + 2] === "[") return null;

  const linkText = parseLinkText(text, bangIndex + 2);
  if (!linkText) return null;
  let i = linkText.next;
  if (text[i] !== "(") return null;
  i += 1;
  i = skipAsciiWhitespace(text, i);

  let destResult: { dest: string; next: number } | null;
  if (text[i] === "<") {
    destResult = parseAngleDestination(text, i);
  } else {
    destResult = parseUnbracketedDestination(text, i);
  }
  if (!destResult) return null;
  i = destResult.next;
  i = skipAsciiWhitespace(text, i);

  if (text[i] === '"' || text[i] === "'" || text[i] === "(") {
    const afterTitle = skipOptionalTitle(text, i);
    if (afterTitle === null) return null;
    i = skipAsciiWhitespace(text, afterTitle);
  }

  if (text[i] !== ")") return null;
  return {
    alt: linkText.alt,
    end: i + 1,
    kind: "markdown",
    sourceRef: destResult.dest.trim(),
    start: bangIndex,
  };
};

/**
 * Discover Obsidian embeds and CommonMark inline images, skipping excluded ranges.
 * Results are sorted by start offset (stable for equal starts by end).
 */
export const discoverImageOccurrences = (
  markdown: string
): DiscoveredImageRef[] => {
  const excluded = getExcludedRanges(markdown);
  const found: DiscoveredImageRef[] = [];
  let i = 0;
  while (i < markdown.length) {
    const bang = markdown.indexOf("!", i);
    if (bang < 0) break;
    if (isEscapedMarker(markdown, bang)) {
      i = bang + 1;
      continue;
    }

    let parsed: DiscoveredImageRef | null = null;
    if (markdown.slice(bang, bang + 3) === "![[") {
      parsed = parseObsidianEmbedAt(markdown, bang);
    } else if (markdown[bang + 1] === "[") {
      parsed = parseMarkdownImageAt(markdown, bang);
    }

    if (!parsed) {
      i = bang + 1;
      continue;
    }
    if (rangeIntersectsExcluded(parsed.start, parsed.end, excluded)) {
      i = parsed.end;
      continue;
    }
    found.push(parsed);
    i = parsed.end;
  }

  return found.sort((a, b) => a.start - b.start || a.end - b.end);
};
