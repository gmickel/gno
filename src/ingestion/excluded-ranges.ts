/**
 * Excluded-range types and binary-search lookup helpers.
 * Extracted from src/ingestion/strip so link/attachment utilities do not pull
 * in mdast/micromark parser packages at module load time.
 *
 * @module src/ingestion/excluded-ranges
 */

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

/**
 * Check if a string offset falls within any excluded range.
 * Uses binary search for O(log n) lookup.
 */
export function isExcluded(
  offset: number,
  excludedRanges: readonly ExcludedRange[]
): boolean {
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
 * Largest `end` among each prefix of a start-sorted range list, built once
 * per list. Ranges can overlap (a comment around a code span), so a range
 * list's ends are not sorted and the prefix maximum stands in for them.
 */
const prefixMaxEnds = new WeakMap<readonly ExcludedRange[], Int32Array>();

const getPrefixMaxEnds = (ranges: readonly ExcludedRange[]): Int32Array => {
  let maxEnds = prefixMaxEnds.get(ranges);
  if (maxEnds?.length !== ranges.length) {
    maxEnds = new Int32Array(ranges.length);
    let maxEnd = -1;
    for (const [index, range] of ranges.entries()) {
      maxEnd = Math.max(maxEnd, range.end);
      maxEnds[index] = maxEnd;
    }
    prefixMaxEnds.set(ranges, maxEnds);
  }
  return maxEnds;
};

/**
 * Check if a range [start, end) intersects any excluded range.
 * More precise than isExcluded for multi-character matches. Ranges must be
 * sorted by start, as getExcludedRanges returns them; one lookup is a binary
 * search, so checking every link of a large note stays linear.
 */
export function rangeIntersectsExcluded(
  start: number,
  end: number,
  excludedRanges: readonly ExcludedRange[]
): boolean {
  // Ranges starting before `end` form a prefix; one of them intersects
  // [start, end) exactly when the largest end among them passes `start`.
  let low = 0;
  let high = excludedRanges.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((excludedRanges[mid]?.start ?? end) < end) low = mid + 1;
    else high = mid;
  }
  if (low === 0) return false;
  return (getPrefixMaxEnds(excludedRanges)[low - 1] ?? -1) > start;
}
