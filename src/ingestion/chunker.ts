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

/** Regex for sentence ending followed by capital letter */
const SENTENCE_END_REGEX = /[.!?]\s+[A-Z]/;

/**
 * Find line number at character position.
 * Returns 1-based line number.
 */
function lineAtPosition(text: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos && i < text.length; i += 1) {
    if (text[i] === '\n') {
      line += 1;
    }
  }
  return line;
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

  // Look for paragraph break (double newline)
  const paraBreak = windowText.lastIndexOf('\n\n');
  if (paraBreak !== -1) {
    return start + paraBreak + 2;
  }

  // Look for sentence ending
  const sentenceEnd = windowText.search(SENTENCE_END_REGEX);
  if (sentenceEnd !== -1) {
    return start + sentenceEnd + 2;
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
 */
export class MarkdownChunker implements ChunkerPort {
  chunk(
    markdown: string,
    params: ChunkParams = DEFAULT_CHUNK_PARAMS,
    documentLanguageHint?: string
  ): ChunkOutput[] {
    if (!markdown || markdown.length === 0) {
      return [];
    }

    const maxChars = params.maxTokens * CHARS_PER_TOKEN;
    const overlapChars = Math.floor(maxChars * params.overlapPercent);
    const windowSize = Math.floor(maxChars * 0.1); // 10% window for break search

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

      // Extract chunk text
      const text = markdown.slice(pos, endPos).trim();

      if (text.length > 0) {
        const startLine = lineAtPosition(markdown, pos);
        const endLine = lineAtPosition(markdown, endPos - 1);

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
