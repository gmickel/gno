/**
 * Markdown chunker implementation.
 * Char-based chunking with line tracking.
 *
 * @module src/ingestion/chunker
 */

import { defaultLanguageDetector } from './language';
import type { ChunkerPort, ChunkOutput, ChunkParams } from './types';
import { DEFAULT_CHUNK_PARAMS } from './types';

/** Approximate chars per token (conservative estimate) */
const CHARS_PER_TOKEN = 4;

/** Minimum valid maxTokens to prevent degenerate behavior */
const MIN_MAX_TOKENS = 10;

/** Maximum valid overlap percentage */
const MAX_OVERLAP_PERCENT = 0.5;

/** Regex for sentence ending followed by whitespace and capital letter (global) */
const SENTENCE_END_REGEX = /[.!?](\s+)[A-Z]/g;

/**
 * Line index for O(1) line number lookups.
 * Stores positions of all newline characters.
 */
type LineIndex = {
  /** Positions of '\n' characters in the text */
  newlines: number[];
};

/**
 * Build a line index from text (O(n) once).
 */
function buildLineIndex(text: string): LineIndex {
  const newlines: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      newlines.push(i);
    }
  }
  return { newlines };
}

/**
 * Find line number at character position using binary search (O(log n)).
 * Returns 1-based line number.
 */
function lineAtPosition(index: LineIndex, pos: number): number {
  const { newlines } = index;

  // Binary search for the number of newlines before pos
  let low = 0;
  let high = newlines.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const newlinePos = newlines[mid];
    if (newlinePos !== undefined && newlinePos < pos) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low + 1; // 1-based line number
}

/**
 * Normalize chunk parameters to valid ranges.
 * Prevents degenerate behavior from invalid inputs.
 */
function normalizeChunkParams(params?: ChunkParams): Required<ChunkParams> {
  const maxTokens = Math.max(
    MIN_MAX_TOKENS,
    Math.floor(params?.maxTokens ?? DEFAULT_CHUNK_PARAMS.maxTokens)
  );
  const overlapPercent = Math.max(
    0,
    Math.min(
      MAX_OVERLAP_PERCENT,
      params?.overlapPercent ?? DEFAULT_CHUNK_PARAMS.overlapPercent
    )
  );
  return { maxTokens, overlapPercent };
}

/**
 * Find a good break point near target position.
 * Prefers paragraph breaks, then sentence endings, then word boundaries.
 */
function findBreakPoint(
  text: string,
  target: number,
  windowSize: number
): number {
  const start = Math.max(0, target - windowSize);
  const end = Math.min(text.length, target + windowSize);
  const windowText = text.slice(start, end);

  // Look for paragraph break (double newline) - prefer last one
  const paraBreak = windowText.lastIndexOf('\n\n');
  if (paraBreak !== -1) {
    return start + paraBreak + 2;
  }

  // Look for sentence ending - find the LAST match before target
  // Reset regex state for fresh search
  SENTENCE_END_REGEX.lastIndex = 0;
  let lastSentenceMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null = null;

  while (true) {
    match = SENTENCE_END_REGEX.exec(windowText);
    if (!match) {
      break;
    }

    // Only consider matches that would give us a break point before or near target
    const whitespace = match[1] ?? '';
    const breakPos = start + match.index + 1 + whitespace.length;
    if (breakPos <= target + windowSize) {
      lastSentenceMatch = match;
    }
  }

  if (lastSentenceMatch) {
    // Break after the punctuation and whitespace, before the capital
    const whitespace = lastSentenceMatch[1] ?? '';
    return start + lastSentenceMatch.index + 1 + whitespace.length;
  }

  // Look for single newline
  const lineBreak = windowText.lastIndexOf('\n');
  if (lineBreak !== -1) {
    return start + lineBreak + 1;
  }

  // Look for word boundary
  const wordBoundary = windowText.lastIndexOf(' ');
  if (wordBoundary !== -1) {
    return start + wordBoundary + 1;
  }

  // Fall back to target
  return target;
}

/**
 * Markdown chunker implementation.
 * Uses character-based chunking with semantic break points.
 *
 * Note: Chunk text is preserved exactly as-is (no trimming) to maintain
 * accurate pos/line mappings and preserve Markdown semantics like
 * indented code blocks.
 */
export class MarkdownChunker implements ChunkerPort {
  chunk(
    markdown: string,
    params?: ChunkParams,
    documentLanguageHint?: string
  ): ChunkOutput[] {
    if (!markdown || markdown.trim().length === 0) {
      return [];
    }

    // Normalize params to prevent degenerate behavior
    const { maxTokens, overlapPercent } = normalizeChunkParams(params);

    const maxChars = maxTokens * CHARS_PER_TOKEN;
    const overlapChars = Math.floor(maxChars * overlapPercent);
    const windowSize = Math.floor(maxChars * 0.1); // 10% window for break search

    // Build line index once for O(log n) lookups
    const lineIndex = buildLineIndex(markdown);

    const chunks: ChunkOutput[] = [];
    let pos = 0;
    let seq = 0;

    while (pos < markdown.length) {
      // Calculate target end position
      const targetEnd = pos + maxChars;

      let endPos: number;
      if (targetEnd >= markdown.length) {
        // Last chunk - take rest
        endPos = markdown.length;
      } else {
        // Find a good break point
        endPos = findBreakPoint(markdown, targetEnd, windowSize);
      }

      // Extract chunk text - preserve exactly (no trim!)
      // This maintains accurate pos/line mappings and Markdown semantics
      const text = markdown.slice(pos, endPos);

      // Only skip truly empty chunks (all whitespace after full content consumed)
      if (text.trim().length > 0) {
        const startLine = lineAtPosition(lineIndex, pos);
        const endLine = lineAtPosition(lineIndex, endPos - 1);

        // Detect language for this chunk
        const language =
          documentLanguageHint ?? defaultLanguageDetector.detect(text);

        chunks.push({
          seq,
          pos,
          text,
          startLine,
          endLine,
          language,
          tokenCount: null, // Char-based, no exact token count
        });

        seq += 1;
      }

      // Move position, accounting for overlap
      if (endPos >= markdown.length) {
        break;
      }

      // Calculate next position with overlap
      const nextPos = endPos - overlapChars;
      pos = Math.max(pos + 1, nextPos); // Ensure we always advance
    }

    return chunks;
  }
}

/**
 * Default chunker instance.
 */
export const defaultChunker = new MarkdownChunker();
