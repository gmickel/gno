/**
 * Non-content region detection for markdown.
 *
 * Identifies regions to exclude from link/tag extraction:
 * - YAML frontmatter
 * - Fenced code blocks (CommonMark backtick and tilde fences)
 * - Indented code blocks
 * - Inline code
 * - HTML comments
 *
 * Returns EXCLUDED RANGES on the original string - does NOT modify content.
 * This preserves position information for accurate line/column tracking.
 *
 * Code regions come from the CommonMark + GFM parser only for Markdown
 * sources within a size budget. GFM table parsing is quadratic in the cells
 * of one table (a 2,000-row table takes seconds, a converted spreadsheet
 * hours), so larger or table-heavy text, and any non-Markdown converted
 * output, uses a linear fence and code-span scanner instead.
 *
 * @module src/ingestion/strip
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ExcludedRangeKind =
  | "frontmatter"
  | "fenced_code"
  | "indented_code"
  | "inline_code"
  | "html_comment";

export interface ExcludedRange {
  /** String offset in original string (inclusive, UTF-16 code unit index) */
  start: number;
  /** String offset in original string (exclusive, UTF-16 code unit index) */
  end: number;
  /** Type of excluded region */
  kind: ExcludedRangeKind;
}

// ─────────────────────────────────────────────────────────────────────────────
// Regex Patterns
// ─────────────────────────────────────────────────────────────────────────────

/** Frontmatter at start of file (YAML between --- delimiters) */
const FRONTMATTER_REGEX = /^---\r?\n[\s\S]*?(?:\r?\n)?---(?:\r?\n|$)/;

/** HTML comments */
const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g;

/**
 * Largest text (UTF-16 code units) the CommonMark parser reads for code
 * regions. Parsing is linear on prose (~0.7 s and ~330 MB per million
 * characters); larger text uses the linear scanner.
 */
export const MAX_PARSED_CODE_REGION_CHARS = 1_000_000;

/**
 * Most `|` characters one blank-line-delimited block may hold before the
 * parser is skipped. A GFM table only ends at a blank line (or another
 * block), and its parse cost grows with the square of its cells: 5,000
 * cells take about 0.3 s, 26,000 about 8 s.
 */
export const MAX_PARSED_TABLE_CELLS = 5000;

/** CommonMark fence opener: 0–3 spaces, then 3+ backticks or tildes + info. */
const FENCE_OPEN_REGEX = /^ {0,3}(`{3,}|~{3,})(.*)$/u;

/** CommonMark fence closer: matching character, length ≥ opener, trailing space/tabs only. */
const FENCE_CLOSE_REGEX = /^ {0,3}(`{3,}|~{3,})[\t ]*$/u;

/** Backtick (code span or fence) or tilde fence anywhere in the text. */
const INLINE_OR_FENCE_TRIGGER_REGEX = /`|~~~/;
/** Blockquote markers and indentation before a line's content. */
const CONTAINER_PREFIX_REGEX = /^[\t >]*/;
/** Four columns of indentation after any blockquote markers. */
const INDENTED_LINE_REGEX = /^(?:>[\t ]?)*(?:\t| {4})/;
/**
 * Lines after which an indented line may start an indented code block: an
 * ATX heading, table row, HTML or definition line, or a thematic break or
 * setext underline. After prose or a list item it continues the paragraph.
 */
const BLOCK_END_LINE_REGEX =
  /^(?:[#|<[]|([-*_=])[\t ]*(?:\1[\t ]*){2,}$)|>[\t ]*$/u;

/**
 * Cheap superset test for code: a backtick, a tilde fence, or an indented
 * line that can open an indented code block (not a list continuation). When
 * it fails the note has no code and the parser is skipped.
 */
const mayContainCode = (markdown: string): boolean => {
  if (INLINE_OR_FENCE_TRIGGER_REGEX.test(markdown)) return true;
  let previous: string | null = null;
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const content = line.replace(CONTAINER_PREFIX_REGEX, "");
    if (
      content !== "" &&
      INDENTED_LINE_REGEX.test(line) &&
      (previous === null ||
        previous === "" ||
        BLOCK_END_LINE_REGEX.test(previous))
    ) {
      return true;
    }
    previous = content;
  }
  return false;
};

/**
 * Whether the parser's cost stays bounded for this text: within the size
 * budget, and no blank-line-delimited block holds more table-cell pipes than
 * the table budget. One linear pass, stopping as soon as a budget trips.
 */
const withinCodeParseBudget = (markdown: string): boolean => {
  if (markdown.length > MAX_PARSED_CODE_REGION_CHARS) return false;
  let blockPipes = 0;
  let lineHasContent = false;
  for (let index = 0; index < markdown.length; index += 1) {
    const code = markdown.charCodeAt(index);
    if (code === 10 /* \n */) {
      if (!lineHasContent) blockPipes = 0;
      lineHasContent = false;
    } else if (code === 124 /* | */) {
      blockPipes += 1;
      lineHasContent = true;
      if (blockPipes > MAX_PARSED_TABLE_CELLS) return false;
    } else if (code !== 32 && code !== 9 && code !== 13) {
      lineHasContent = true;
    }
  }
  return true;
};

interface OpenFence {
  marker: "`" | "~";
  length: number;
  start: number;
}

/**
 * Linear scanner: CommonMark fenced code ranges (backtick and tilde). A
 * closer must use the same character and be at least as long as the opener;
 * when omitted, CommonMark extends the fenced block through end of input.
 */
const scanFencedCodeRanges = (markdown: string): ExcludedRange[] => {
  const ranges: ExcludedRange[] = [];
  let offset = 0;
  let open: OpenFence | null = null;

  while (offset <= markdown.length) {
    const nextNl = markdown.indexOf("\n", offset);
    const lineEnd = nextNl === -1 ? markdown.length : nextNl;
    const rawLine = markdown.slice(offset, lineEnd);
    const logical = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (open) {
      const closeRun = FENCE_CLOSE_REGEX.exec(logical)?.[1];
      if (
        closeRun &&
        closeRun[0] === open.marker &&
        closeRun.length >= open.length
      ) {
        const end = nextNl === -1 ? markdown.length : nextNl + 1;
        ranges.push({ start: open.start, end, kind: "fenced_code" });
        open = null;
      }
    } else {
      const openMatch = FENCE_OPEN_REGEX.exec(logical);
      const run = openMatch?.[1];
      const suffix = openMatch?.[2] ?? "";
      // Backtick info strings cannot contain backticks (CommonMark).
      if (run && !(run[0] === "`" && suffix.includes("`"))) {
        open = {
          marker: run[0] as OpenFence["marker"],
          length: run.length,
          start: offset,
        };
      }
    }

    if (nextNl === -1) break;
    offset = nextNl + 1;
  }

  if (open) {
    ranges.push({
      start: open.start,
      end: markdown.length,
      kind: "fenced_code",
    });
  }

  return ranges;
};

interface BacktickRun {
  end: number;
  length: number;
  start: number;
}

/**
 * Linear scanner: code spans close only on a backtick run of equal length.
 * Delimiters pair only in visible text, so an unmatched backtick inside an
 * already-excluded block cannot consume later content.
 */
const scanInlineCodeRanges = (
  markdown: string,
  excludedRanges: ExcludedRange[]
): ExcludedRange[] => {
  const runs: BacktickRun[] = [];
  let cursor = 0;
  let excludedIndex = 0;
  while (cursor < markdown.length) {
    while (
      excludedRanges[excludedIndex] &&
      excludedRanges[excludedIndex]!.end <= cursor
    ) {
      excludedIndex += 1;
    }
    const excluded = excludedRanges[excludedIndex];
    if (excluded && cursor >= excluded.start && cursor < excluded.end) {
      cursor = excluded.end;
      continue;
    }
    if (markdown[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    const start = cursor;
    while (markdown[cursor] === "`") cursor += 1;
    let backslashes = 0;
    for (let i = start - 1; i >= 0 && markdown[i] === "\\"; i -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) {
      runs.push({ start, end: cursor, length: cursor - start });
    }
  }

  const nextMatchingRun = Array.from<number | undefined>({
    length: runs.length,
  });
  const latestByLength = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (!run) continue;
    nextMatchingRun[index] = latestByLength.get(run.length);
    latestByLength.set(run.length, index);
  }

  const ranges: ExcludedRange[] = [];
  let index = 0;
  while (index < runs.length) {
    const closeIndex = nextMatchingRun[index];
    const opener = runs[index];
    const closer = closeIndex === undefined ? undefined : runs[closeIndex];
    if (closeIndex === undefined || !opener || !closer) {
      index += 1;
      continue;
    }
    ranges.push({
      start: opener.start,
      end: closer.end,
      kind: "inline_code",
    });
    index = closeIndex + 1;
  }
  return ranges;
};

/**
 * Code regions from the linear scanner: fenced blocks and code spans (no
 * indented code blocks, and no table-cell splitting of code spans). Used for
 * non-Markdown converted output and for text over the parser budget.
 */
const scanCodeRanges = (
  markdown: string,
  otherRanges: ExcludedRange[]
): ExcludedRange[] => {
  const fenced = scanFencedCodeRanges(markdown);
  const visible = [...otherRanges, ...fenced].sort((a, b) => a.start - b.start);
  return [...fenced, ...scanInlineCodeRanges(markdown, visible)];
};

/** Opening fence at the start of a code node: backtick or tilde fence. */
const FENCE_START_REGEX = /^[\t ]*(?:`{3,}|~{3,})/;

interface CodeNode {
  children?: CodeNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  type: string;
}

/**
 * Code regions as the CommonMark + GFM parser sees them: inline code spans,
 * fenced code blocks and indented code blocks, with their block context
 * (paragraphs, blockquotes, list items) handled by the parser. Frontmatter is
 * blanked first (same length, newlines kept) so it cannot open a fence.
 */
const parseCodeRanges = (
  markdown: string,
  frontmatterEnd: number
): ExcludedRange[] => {
  const source =
    frontmatterEnd > 0
      ? markdown.slice(0, frontmatterEnd).replace(/[^\r\n]/gu, " ") +
        markdown.slice(frontmatterEnd)
      : markdown;
  const root = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as CodeNode;
  const ranges: ExcludedRange[] = [];
  const visit = (node: CodeNode): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined && end > start) {
      if (node.type === "inlineCode") {
        ranges.push({ start, end, kind: "inline_code" });
        return;
      }
      if (node.type === "code") {
        ranges.push({
          start,
          end,
          kind: FENCE_START_REGEX.test(source.slice(start, end))
            ? "fenced_code"
            : "indented_code",
        });
        return;
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return ranges;
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Functions
// ─────────────────────────────────────────────────────────────────────────────

export interface ExcludedRangeOptions {
  /**
   * Whether the text is a Markdown source whose code regions may come from
   * the CommonMark parser (default true). Converted output from other
   * formats is never parsed as Markdown: it uses the linear scanner.
   */
  markdownSource?: boolean;
}

/**
 * Get excluded ranges for markdown content.
 * Returns ranges sorted by start position.
 * Ranges may overlap (e.g., inline code inside frontmatter).
 */
export function getExcludedRanges(
  markdown: string,
  options: ExcludedRangeOptions = {}
): ExcludedRange[] {
  const ranges: ExcludedRange[] = [];

  // 1. Frontmatter (must be at start of file)
  const frontmatterMatch = FRONTMATTER_REGEX.exec(markdown);
  if (frontmatterMatch) {
    ranges.push({
      start: 0,
      end: frontmatterMatch[0].length,
      kind: "frontmatter",
    });
  }

  // 2. HTML comments
  HTML_COMMENT_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HTML_COMMENT_REGEX.exec(markdown)) !== null) {
    ranges.push({
      start: match.index,
      end: match.index + match[0].length,
      kind: "html_comment",
    });
  }

  // 3. Code spans and fenced or indented code blocks: from the parser for
  // Markdown within budget, otherwise from the linear scanner.
  const frontmatterEnd = frontmatterMatch?.[0].length ?? 0;
  if (mayContainCode(markdown.slice(frontmatterEnd))) {
    const parse =
      options.markdownSource !== false && withinCodeParseBudget(markdown);
    ranges.push(
      ...(parse
        ? parseCodeRanges(markdown, frontmatterEnd)
        : scanCodeRanges(markdown, ranges))
    );
  }

  // Sort by start position for efficient lookup
  ranges.sort((a, b) => a.start - b.start);

  return ranges;
}

/**
 * Check if an offset is inside any excluded range.
 * Uses binary search for O(log N) lookup.
 */
export function isExcluded(
  offset: number,
  excludedRanges: ExcludedRange[]
): boolean {
  if (excludedRanges.length === 0) return false;

  // Binary search for the range that could contain offset
  let left = 0;
  let right = excludedRanges.length - 1;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const range = excludedRanges[mid];
    if (range === undefined) return false;

    if (offset < range.start) {
      right = mid - 1;
    } else if (offset >= range.end) {
      left = mid + 1;
    } else {
      // offset is in [start, end)
      return true;
    }
  }

  return false;
}

/**
 * Check if a range [start, end) intersects any excluded range.
 * More precise than isExcluded for multi-character matches.
 */
export function rangeIntersectsExcluded(
  start: number,
  end: number,
  excludedRanges: ExcludedRange[]
): boolean {
  for (const range of excludedRanges) {
    // Two ranges [a, b) and [c, d) intersect if a < d && c < b
    if (start < range.end && range.start < end) {
      return true;
    }
    // Early exit if we've passed the range (ranges are sorted)
    if (range.start >= end) {
      break;
    }
  }
  return false;
}
