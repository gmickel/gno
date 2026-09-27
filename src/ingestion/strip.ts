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
 * Code regions come from the CommonMark + GFM parser. GFM table parsing is
 * quadratic in the cells of one table (a 20,000-row table took minutes), so
 * text with a table over the cell budget is parsed without the table
 * extension: code spans, fences, indented code, blockquotes and lists keep
 * their CommonMark meaning, and only table-cell boundaries are lost.
 *
 * @module src/ingestion/strip
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfmAutolinkLiteralFromMarkdown } from "mdast-util-gfm-autolink-literal";
import { gfmFootnoteFromMarkdown } from "mdast-util-gfm-footnote";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTaskListItemFromMarkdown } from "mdast-util-gfm-task-list-item";
import { gfm } from "micromark-extension-gfm";
import { gfmAutolinkLiteral } from "micromark-extension-gfm-autolink-literal";
import { gfmFootnote } from "micromark-extension-gfm-footnote";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";

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
 * Most `|` characters one blank-line-delimited block may hold before the
 * GFM table extension is left out of the parse. A GFM table only ends at a
 * blank line (or another block), and its parse cost grows with the square
 * of its cells: 5,000 cells take about 0.3 s, 26,000 about 8 s.
 */
export const MAX_PARSED_TABLE_CELLS = 5000;

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
 * Whether any blank-line-delimited block holds more table-cell pipes than
 * the table budget. One linear pass, stopping as soon as the budget trips.
 */
const hasOversizedTable = (markdown: string): boolean => {
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
      if (blockPipes > MAX_PARSED_TABLE_CELLS) return true;
    } else if (code !== 32 && code !== 9 && code !== 13) {
      lineHasContent = true;
    }
  }
  return false;
};

/** GFM without tables: every GFM construct except table rows and cells. */
const GFM_WITHOUT_TABLES = {
  extensions: [
    gfmAutolinkLiteral(),
    gfmFootnote(),
    gfmStrikethrough(),
    gfmTaskListItem(),
  ],
  mdastExtensions: [
    gfmAutolinkLiteralFromMarkdown(),
    gfmFootnoteFromMarkdown(),
    gfmStrikethroughFromMarkdown(),
    gfmTaskListItemFromMarkdown(),
  ],
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
const collectCodeRanges = (
  markdown: string,
  frontmatterEnd: number
): ExcludedRange[] => {
  const source =
    frontmatterEnd > 0
      ? markdown.slice(0, frontmatterEnd).replace(/[^\r\n]/gu, " ") +
        markdown.slice(frontmatterEnd)
      : markdown;
  const root = fromMarkdown(
    source,
    hasOversizedTable(source)
      ? GFM_WITHOUT_TABLES
      : { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }
  ) as CodeNode;
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

  // 3. Code spans and fenced or indented code blocks, from the parser.
  const frontmatterEnd = frontmatterMatch?.[0].length ?? 0;
  if (mayContainCode(markdown.slice(frontmatterEnd))) {
    ranges.push(...collectCodeRanges(markdown, frontmatterEnd));
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
