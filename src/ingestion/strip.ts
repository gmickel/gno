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
 * @module src/ingestion/strip
 */

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

/** CommonMark fence opener: 0–3 spaces, then 3+ backticks or tildes + info. */
const FENCE_OPEN_REGEX = /^ {0,3}(`{3,}|~{3,})(.*)$/u;

/** CommonMark fence closer: matching character, length ≥ opener, trailing space/tabs only. */
const FENCE_CLOSE_REGEX = /^ {0,3}(`{3,}|~{3,})[\t ]*$/u;

/** HTML comments */
const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g;

interface OpenFence {
  marker: "`" | "~";
  length: number;
  start: number;
}

/**
 * Collect CommonMark fenced code ranges (backtick and tilde). A closer must
 * use the same character and be at least as long as the opener; when omitted,
 * CommonMark extends the fenced block through end of input.
 */
const collectFencedCodeRanges = (markdown: string): ExcludedRange[] => {
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
  /** Paragraph-like block the run sits in; spans never cross blocks. */
  block: number;
  /** Preceded by an odd number of backslashes: its first backtick is literal. */
  escaped: boolean;
  start: number;
}

/** Blank line: ends the current paragraph. */
const BLANK_LINE_REGEX = /^[\t ]*$/;

/**
 * Lines that always start a new block (ATX heading, list item, blockquote,
 * table row). A code span in them cannot pair with a backtick on an earlier
 * line; a heading or table row also ends before the next line.
 */
const BLOCK_START_REGEX =
  /^ {0,3}(?:#{1,6}(?:[\t ]|$)|[-*+][\t ]|\d{1,9}[.)][\t ]|>|\|)/;
const SINGLE_LINE_BLOCK_REGEX = /^ {0,3}(?:#{1,6}(?:[\t ]|$)|\|)/;

/**
 * Block index for every line start. Code spans are inline: CommonMark pairs
 * backtick runs only within one paragraph, heading, list item or table row,
 * so a stray backtick earlier in a note never swallows a later span.
 */
const collectLineBlocks = (
  markdown: string
): { lineStarts: number[]; blocks: number[] } => {
  const lineStarts: number[] = [];
  const blocks: number[] = [];
  let block = 0;
  let closeAfter = false;
  let offset = 0;
  while (offset <= markdown.length) {
    const nextNl = markdown.indexOf("\n", offset);
    const lineEnd = nextNl === -1 ? markdown.length : nextNl;
    const line = markdown.slice(offset, lineEnd).replace(/\r$/u, "");
    if (
      closeAfter ||
      BLANK_LINE_REGEX.test(line) ||
      BLOCK_START_REGEX.test(line)
    ) {
      block += 1;
    }
    closeAfter = SINGLE_LINE_BLOCK_REGEX.test(line);
    lineStarts.push(offset);
    blocks.push(block);
    if (nextNl === -1) break;
    offset = nextNl + 1;
  }
  return { lineStarts, blocks };
};

/** Index of the line containing `offset` (binary search over line starts). */
const lineIndexAt = (lineStarts: readonly number[], offset: number): number => {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((lineStarts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
};

/** First element of a sorted index list greater than `after`, or undefined. */
const firstIndexAfter = (
  indices: readonly number[] | undefined,
  after: number
): number | undefined => {
  if (!indices) return undefined;
  let low = 0;
  let high = indices.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((indices[mid] ?? 0) <= after) low = mid + 1;
    else high = mid;
  }
  return indices[low];
};

/**
 * CommonMark code spans close only on a backtick run of equal length in the
 * same block. A backslash escapes an opening backtick, but inside a span it
 * is literal, so `` `C:\dir\` `` closes on the backtick after the backslash.
 */
const collectInlineCodeRanges = (
  markdown: string,
  excludedRanges: ExcludedRange[]
): ExcludedRange[] => {
  const { lineStarts, blocks } = collectLineBlocks(markdown);
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
    runs.push({
      start,
      end: cursor,
      length: cursor - start,
      block: blocks[lineIndexAt(lineStarts, start)] ?? 0,
      escaped: backslashes % 2 === 1,
    });
  }

  // Run indices per (block, length), ascending, for closer lookup.
  const byKey = new Map<string, number[]>();
  for (const [index, run] of runs.entries()) {
    const key = `${run.block}:${run.length}`;
    const indices = byKey.get(key) ?? [];
    indices.push(index);
    byKey.set(key, indices);
  }

  const ranges: ExcludedRange[] = [];
  let index = 0;
  while (index < runs.length) {
    const opener = runs[index]!;
    // An escaped run opens with its remaining backticks, if any.
    const openLength = opener.escaped ? opener.length - 1 : opener.length;
    const closeIndex =
      openLength > 0
        ? firstIndexAfter(byKey.get(`${opener.block}:${openLength}`), index)
        : undefined;
    const closer = closeIndex === undefined ? undefined : runs[closeIndex];
    if (closeIndex === undefined || !closer) {
      index += 1;
      continue;
    }
    ranges.push({
      start: opener.escaped ? opener.start + 1 : opener.start,
      end: closer.end,
      kind: "inline_code",
    });
    index = closeIndex + 1;
  }
  return ranges;
};

/** List item marker; indented lines after a list item continue the item. */
const LIST_ITEM_REGEX = /^[\t ]*(?:[-*+]|\d{1,9}[.)])(?:[\t ]|$)/;
/** Four columns of indentation (spaces or a tab). */
const INDENTED_LINE_REGEX = /^(?: {4}| {0,3}\t)/;

/**
 * Indented code blocks: a run of lines indented four or more columns that
 * follows a blank line after a paragraph or heading (or starts the note).
 * Indented lines that belong to a list stay prose, since that is how
 * Obsidian renders nested list items; lines inside other excluded ranges
 * (fences, frontmatter) are ignored.
 */
const collectIndentedCodeRanges = (
  markdown: string,
  excludedRanges: ExcludedRange[]
): ExcludedRange[] => {
  const ranges: ExcludedRange[] = [];
  let offset = 0;
  /** Previous line was blank (or start of note / end of an excluded block). */
  let afterBlank = true;
  /** Nearest earlier non-blank prose line was a list item or its continuation. */
  let inList = false;
  let open: { start: number; end: number } | null = null;
  let excludedIndex = 0;
  while (offset <= markdown.length) {
    const nextNl = markdown.indexOf("\n", offset);
    const lineEnd = nextNl === -1 ? markdown.length : nextNl;
    const next = nextNl === -1 ? markdown.length : nextNl + 1;
    const line = markdown.slice(offset, lineEnd).replace(/\r$/u, "");
    while (
      excludedRanges[excludedIndex] &&
      excludedRanges[excludedIndex]!.end <= offset
    ) {
      excludedIndex += 1;
    }
    const candidate = excludedRanges[excludedIndex];
    const covered =
      candidate && offset >= candidate.start ? candidate : undefined;
    if (covered) {
      if (open) {
        ranges.push({ ...open, kind: "indented_code" });
        open = null;
      }
      afterBlank = true;
      inList = false;
      if (covered.end >= markdown.length) break;
      offset = covered.end;
      continue;
    }
    const blank = BLANK_LINE_REGEX.test(line);
    const indented = !blank && INDENTED_LINE_REGEX.test(line);
    if (open) {
      if (blank || indented) {
        if (indented) open.end = next;
      } else {
        ranges.push({ ...open, kind: "indented_code" });
        open = null;
      }
    } else if (indented && afterBlank && !inList) {
      open = { start: offset, end: next };
    }
    if (!blank && !open) {
      inList = LIST_ITEM_REGEX.test(line) || (inList && indented);
    }
    afterBlank = blank;
    if (nextNl === -1) break;
    offset = next;
  }
  if (open) ranges.push({ ...open, kind: "indented_code" });
  return ranges;
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get excluded ranges for markdown content.
 * Returns ranges sorted by start position.
 * Ranges may overlap (e.g., inline code inside frontmatter).
 */
export function getExcludedRanges(markdown: string): ExcludedRange[] {
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

  // 2. Fenced code blocks (backtick + tilde, CommonMark matching rules)
  ranges.push(...collectFencedCodeRanges(markdown));

  // 3. HTML comments
  HTML_COMMENT_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HTML_COMMENT_REGEX.exec(markdown)) !== null) {
    ranges.push({
      start: match.index,
      end: match.index + match[0].length,
      kind: "html_comment",
    });
  }

  // 4. Indented code blocks, outside fences and frontmatter.
  ranges.sort((a, b) => a.start - b.start);
  ranges.push(...collectIndentedCodeRanges(markdown, ranges));

  // 5. Inline code. Pair delimiters only in visible prose so unmatched
  // backticks inside already-excluded blocks cannot consume later content.
  ranges.sort((a, b) => a.start - b.start);
  ranges.push(...collectInlineCodeRanges(markdown, ranges));

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
