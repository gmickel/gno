/**
 * Deterministic Markdown/Obsidian image discovery for publish attachments.
 * Uses a state-machine for CommonMark-style inline image destinations;
 * excludes frontmatter/code via ingestion strip helpers.
 *
 * @module src/publish/attachment-discover
 */

import { decodeString } from "micromark-util-decode-string";

import {
  type ExcludedRange,
  rangeIntersectsExcluded,
} from "../ingestion/strip";
import {
  collectAttachmentExcludedRanges,
  stripAttachmentContainerPrefixes,
} from "./attachment-exclusions";
import { parseObsidianEmbedAt } from "./attachment-obsidian";

export interface DiscoveredImageRef {
  /** Raw alt/alias text between brackets (as authored). */
  alt: string;
  end: number;
  kind: "markdown" | "obsidian";
  /** Destination / embed path used for resolution (unescaped). */
  sourceRef: string;
  start: number;
}

export interface DiscoverImageOptions {
  excludeFrontmatter?: boolean;
}

const isAsciiWhitespace = (ch: string): boolean =>
  ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

const isAsciiPunctuation = (ch: string): boolean => {
  const code = ch.charCodeAt(0);
  return (
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e)
  );
};

const skipAsciiWhitespace = (text: string, index: number): number => {
  let i = index;
  while (i < text.length && isAsciiWhitespace(text[i] ?? "")) i += 1;
  return i;
};

const skipResourceWhitespace = (text: string, index: number): number | null => {
  let i = index;
  let sawLineEnding = false;
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (ch === " " || ch === "\t") {
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (sawLineEnding) return null;
      sawLineEnding = true;
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    break;
  }
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
    if (ch === "\n" || ch === "\r") {
      let afterLineEnding = ch === "\r" && text[i + 1] === "\n" ? i + 2 : i + 1;
      while (text[afterLineEnding] === " " || text[afterLineEnding] === "\t") {
        afterLineEnding += 1;
      }
      if (text[afterLineEnding] === "\n" || text[afterLineEnding] === "\r") {
        return null;
      }
      i = afterLineEnding;
      continue;
    }
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
      const next = text[i + 1] ?? "";
      if (isAsciiPunctuation(next)) {
        dest += next;
        i += 2;
      } else {
        dest += ch;
        i += 1;
      }
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
      const next = text[i + 1] ?? "";
      if (isAsciiPunctuation(next)) {
        dest += next;
        i += 2;
      } else {
        dest += ch;
        i += 1;
      }
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
      i += isAsciiPunctuation(text[i + 1] ?? "") ? 2 : 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      let afterLineEnding = ch === "\r" && text[i + 1] === "\n" ? i + 2 : i + 1;
      while (text[afterLineEnding] === " " || text[afterLineEnding] === "\t") {
        afterLineEnding += 1;
      }
      if (text[afterLineEnding] === "\n" || text[afterLineEnding] === "\r") {
        return null;
      }
      i = afterLineEnding;
      continue;
    }
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
  const destinationStart = skipResourceWhitespace(text, i);
  if (destinationStart === null) return null;
  i = destinationStart;

  let destResult: { dest: string; next: number } | null;
  if (text[i] === "<") {
    destResult = parseAngleDestination(text, i);
  } else {
    destResult = parseUnbracketedDestination(text, i);
  }
  if (!destResult) return null;
  i = destResult.next;
  const afterDestination = skipResourceWhitespace(text, i);
  if (afterDestination === null) return null;
  i = afterDestination;

  if (text[i] === '"' || text[i] === "'" || text[i] === "(") {
    const afterTitle = skipOptionalTitle(text, i);
    if (afterTitle === null) return null;
    const afterTitleWhitespace = skipResourceWhitespace(text, afterTitle);
    if (afterTitleWhitespace === null) return null;
    i = afterTitleWhitespace;
  }

  if (text[i] !== ")") return null;
  return {
    alt: linkText.alt,
    end: i + 1,
    kind: "markdown",
    sourceRef: decodeString(destResult.dest.trim()),
    start: bangIndex,
  };
};

const normalizeReferenceLabel = (label: string): string =>
  decodeString(label)
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/gu, "$1")
    .trim()
    .replace(/[ \t\r\n]+/gu, " ")
    .toLowerCase();

const parseReferenceDefinitionStart = (
  line: string
): { label: string; remainder: string } | null => {
  const indent = /^ {0,3}/u.exec(line)?.[0].length ?? 0;
  if (line[indent] !== "[") return null;
  let cursor = indent + 1;
  const labelStart = cursor;
  while (cursor < line.length) {
    if (line[cursor] === "\\" && cursor + 1 < line.length) {
      cursor += 2;
      continue;
    }
    if (line[cursor] === "]" && line[cursor + 1] === ":") {
      return {
        label: line.slice(labelStart, cursor),
        remainder: line.slice(cursor + 2).replace(/^[ \t]*/u, ""),
      };
    }
    cursor += 1;
  }
  return null;
};

const lineAllowsFollowingDefinition = (line: string): boolean =>
  line.trim().length === 0 ||
  /^ {0,3}#{1,6}(?:[ \t]|$)/u.test(line) ||
  /^ {0,3}(?:`{3,}|~{3,})/u.test(line) ||
  /^ {0,3}(?:=+|-+)[ \t]*$/u.test(line) ||
  /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/u.test(line);

const collectReferenceDefinitions = (
  markdown: string,
  excluded: ExcludedRange[]
): { definitions: Map<string, string>; ranges: ExcludedRange[] } => {
  const definitions = new Map<string, string>();
  const ranges: ExcludedRange[] = [];
  let start = 0;
  let previousContainerKey = "";
  let previousLineAllowsDefinition = true;
  while (start <= markdown.length) {
    const newline = markdown.indexOf("\n", start);
    const lineEnd = newline === -1 ? markdown.length : newline;
    const physicalLine = markdown.slice(start, lineEnd).replace(/\r$/u, "");
    const stripped = stripAttachmentContainerPrefixes(physicalLine);
    const containerStartsBlock =
      stripped.containerKey.length > 0 &&
      stripped.containerKey !== previousContainerKey;
    const definition =
      previousLineAllowsDefinition || containerStartsBlock
        ? parseReferenceDefinitionStart(stripped.content)
        : null;
    let end = lineEnd;
    if (!definition) {
      const lineIsExcludedBlock = excluded.some(
        (range) =>
          range.kind !== "inline_code" &&
          range.start <= start &&
          range.end >= lineEnd
      );
      previousLineAllowsDefinition =
        lineIsExcludedBlock || lineAllowsFollowingDefinition(stripped.content);
      previousContainerKey = stripped.containerKey;
      if (newline === -1) break;
      start = newline + 1;
      continue;
    }
    const label = normalizeReferenceLabel(definition.label);
    let remainder = definition.remainder;
    if (!remainder && markdown[end] === "\n") {
      const continuationStart = end + 1;
      const continuationEndIndex = markdown.indexOf("\n", continuationStart);
      const continuationEnd =
        continuationEndIndex === -1 ? markdown.length : continuationEndIndex;
      const continuationLine = markdown
        .slice(continuationStart, continuationEnd)
        .replace(/\r$/u, "");
      const continuation =
        stripAttachmentContainerPrefixes(continuationLine).content.match(
          /^ {0,3}(\S.*)$/u
        );
      if (continuation) {
        remainder = continuation[1] ?? "";
        end = continuationEnd;
      }
    }
    if (rangeIntersectsExcluded(start, end, excluded) || !label || !remainder) {
      if (newline === -1) break;
      start = newline + 1;
      continue;
    }
    const parsed =
      remainder[0] === "<"
        ? parseAngleDestination(remainder, 0)
        : parseUnbracketedDestination(remainder, 0);
    if (!parsed?.dest) {
      if (newline === -1) break;
      start = newline + 1;
      continue;
    }
    let cursor = skipAsciiWhitespace(remainder, parsed.next);
    if (
      remainder[cursor] === '"' ||
      remainder[cursor] === "'" ||
      remainder[cursor] === "("
    ) {
      const afterTitle = skipOptionalTitle(remainder, cursor);
      if (afterTitle === null) {
        if (newline === -1) break;
        start = newline + 1;
        continue;
      }
      cursor = skipAsciiWhitespace(remainder, afterTitle);
    }
    if (cursor === remainder.length) {
      if (markdown[end] === "\n") {
        const titleStart = end + 1;
        const titleEndIndex = markdown.indexOf("\n", titleStart);
        const titleEnd = titleEndIndex === -1 ? markdown.length : titleEndIndex;
        const physicalTitleLine = markdown
          .slice(titleStart, titleEnd)
          .replace(/\r$/u, "");
        const titleLine = stripAttachmentContainerPrefixes(
          physicalTitleLine
        ).content.replace(/^ {0,3}/u, "");
        const afterTitle = skipOptionalTitle(titleLine, 0);
        if (afterTitle !== null && afterTitle === titleLine.length) {
          end = titleEnd;
        }
      }
      ranges.push({ start, end, kind: "html_comment" });
      if (!definitions.has(label)) {
        definitions.set(label, decodeString(parsed.dest.trim()));
      }
    }
    previousLineAllowsDefinition = true;
    previousContainerKey = stripped.containerKey;
    if (newline === -1) break;
    start = newline + 1;
  }
  return { definitions, ranges };
};

const parseReferenceImageAt = (
  text: string,
  bangIndex: number,
  definitions: ReadonlyMap<string, string>
): DiscoveredImageRef | null => {
  if (text[bangIndex] !== "!" || text[bangIndex + 1] !== "[") return null;
  const linkText = parseLinkText(text, bangIndex + 2);
  if (!linkText || text[linkText.next] === "(") return null;

  let end = linkText.next;
  let label = linkText.alt;
  if (text[end] === "[") {
    const labelText = parseLinkText(text, end + 1);
    if (!labelText) return null;
    label = labelText.alt || linkText.alt;
    end = labelText.next;
  }
  const sourceRef = definitions.get(normalizeReferenceLabel(label));
  if (sourceRef === undefined) return null;
  return {
    alt: linkText.alt,
    end,
    kind: "markdown",
    sourceRef,
    start: bangIndex,
  };
};

/**
 * Discover Obsidian embeds and CommonMark inline images, skipping excluded ranges.
 * Results are sorted by start offset (stable for equal starts by end).
 */
export const discoverImageOccurrences = (
  markdown: string,
  options: DiscoverImageOptions = {}
): DiscoveredImageRef[] => {
  const baseExcluded = collectAttachmentExcludedRanges(
    markdown,
    options.excludeFrontmatter ?? true
  );
  const references = collectReferenceDefinitions(markdown, baseExcluded);
  const excluded = [...baseExcluded, ...references.ranges].sort(
    (left, right) => left.start - right.start
  );
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
      parsed =
        parseMarkdownImageAt(markdown, bang) ??
        parseReferenceImageAt(markdown, bang, references.definitions);
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
