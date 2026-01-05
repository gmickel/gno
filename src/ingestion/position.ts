/**
 * Line/column position utilities.
 *
 * Efficient conversion from string offsets (UTF-16 code unit indices) to
 * 1-based line/column positions. Uses precomputed line offset arrays for O(log N) lookups.
 *
 * Positions are 1-based to match editor conventions and existing chunk metadata.
 * Column values are UTF-16 code units (JS string indices), not Unicode graphemes.
 *
 * @module src/ingestion/position
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Position {
  /** 1-based line number */
  line: number;
  /** 1-based column (UTF-16 code unit offset within line) */
  col: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Line Offset Computation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build array of line start offsets.
 * Each entry is the string offset (UTF-16 code unit index) where that line starts.
 * Line 1 starts at offset 0, etc.
 *
 * Handles both LF (\n) and CRLF (\r\n) line endings.
 *
 * @example
 * buildLineOffsets("abc\ndef\nghi") // [0, 4, 8]
 */
export function buildLineOffsets(content: string): number[] {
  const offsets: number[] = [0]; // Line 1 starts at offset 0

  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      // Next line starts after the newline
      offsets.push(i + 1);
    }
  }

  return offsets;
}

// ─────────────────────────────────────────────────────────────────────────────
// Offset to Position Conversion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert string offset to 1-based line/column position.
 * Uses binary search for O(log N) lookup.
 *
 * @param offset - String offset in content (0-based UTF-16 code unit index)
 * @param lineOffsets - Precomputed line start offsets from buildLineOffsets()
 * @returns 1-based line and column position
 *
 * @example
 * const offsets = buildLineOffsets("abc\ndef\nghi");
 * offsetToPosition(5, offsets) // { line: 2, col: 2 } ("e" in "def")
 */
export function offsetToPosition(
  offset: number,
  lineOffsets: number[]
): Position {
  if (lineOffsets.length === 0) {
    return { line: 1, col: 1 };
  }

  // Clamp offset to valid range
  if (offset < 0) {
    return { line: 1, col: 1 };
  }

  // Binary search for the line containing this offset
  let left = 0;
  let right = lineOffsets.length - 1;
  let lineIndex = 0;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const lineStart = lineOffsets[mid];
    if (lineStart === undefined) break;

    if (lineStart <= offset) {
      lineIndex = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  const lineStart = lineOffsets[lineIndex] ?? 0;

  // Line is 1-based, column is 1-based (offset within line + 1)
  return {
    line: lineIndex + 1,
    col: offset - lineStart + 1,
  };
}

/**
 * Convenience function to get position for both start and end offsets.
 */
export function offsetsToPositions(
  startOffset: number,
  endOffset: number,
  lineOffsets: number[]
): { start: Position; end: Position } {
  return {
    start: offsetToPosition(startOffset, lineOffsets),
    end: offsetToPosition(endOffset, lineOffsets),
  };
}
