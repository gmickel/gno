/**
 * Non-content region detection for markdown.
 *
 * Identifies regions to exclude from link/tag extraction:
 * - YAML frontmatter
 * - Fenced code blocks (CommonMark backtick and tilde fences)
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
  start: number;
}

/** CommonMark code spans close only on a backtick run of equal length. */
const collectInlineCodeRanges = (
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
    if (closeIndex === undefined || !opener) {
      index += 1;
      continue;
    }
    const closer = runs[closeIndex];
    if (!closer) {
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

  // 4. Inline code. Pair delimiters only in visible prose so unmatched
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
