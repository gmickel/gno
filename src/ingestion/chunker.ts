/**
 * Markdown chunker implementation.
 * Char-based chunking with line tracking.
 *
 * @module src/ingestion/chunker
 */

import type { ChunkerPort, ChunkOutput, ChunkParams } from "./types";

import { defaultLanguageDetector } from "./language";
import { buildLineOffsets } from "./position";
import { DEFAULT_CHUNK_PARAMS } from "./types";

/** Approximate chars per token (conservative estimate) */
const CHARS_PER_TOKEN = 4;

/** Minimum valid maxTokens to prevent degenerate behavior */
const MIN_MAX_TOKENS = 10;

/** Maximum valid overlap percentage */
const MAX_OVERLAP_PERCENT = 0.5;

/** Regex for sentence ending followed by whitespace and capital letter (global) */
const SENTENCE_END_REGEX = /[.!?](\s+)[A-Z]/g;
const NON_WHITESPACE_REGEX = /\S/;
const MIN_CODE_CHUNK_PERCENT = 0.35;

type CodeChunkLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "python"
  | "go"
  | "rust";

const CODE_CHUNK_MODE = "automatic";

const CODE_EXTENSION_MAP: Record<string, CodeChunkLanguage> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
};

const CODE_SUPPORTED_EXTENSIONS = Object.keys(CODE_EXTENSION_MAP);

const CODE_BREAKPOINT_PATTERNS: Record<CodeChunkLanguage, RegExp[]> = {
  typescript: [
    /^\s*import\s.+$/gm,
    /^\s*export\s+(?:default\s+)?(?:class|function|interface|type|enum)\b.*$/gm,
    /^\s*(?:export\s+)?(?:async\s+)?function\s+\w+/gm,
    /^\s*(?:export\s+)?class\s+\w+/gm,
    /^\s*(?:export\s+)?interface\s+\w+/gm,
    /^\s*(?:export\s+)?type\s+\w+\s*=/gm,
    /^\s*(?:export\s+)?enum\s+\w+/gm,
    /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/gm,
  ],
  tsx: [
    /^\s*import\s.+$/gm,
    /^\s*export\s+(?:default\s+)?(?:class|function|interface|type|enum)\b.*$/gm,
    /^\s*(?:export\s+)?(?:async\s+)?function\s+\w+/gm,
    /^\s*(?:export\s+)?class\s+\w+/gm,
    /^\s*(?:export\s+)?interface\s+\w+/gm,
    /^\s*(?:export\s+)?type\s+\w+\s*=/gm,
    /^\s*(?:export\s+)?enum\s+\w+/gm,
    /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/gm,
  ],
  javascript: [
    /^\s*import\s.+$/gm,
    /^\s*export\s+(?:default\s+)?(?:class|function)\b.*$/gm,
    /^\s*(?:export\s+)?(?:async\s+)?function\s+\w+/gm,
    /^\s*(?:export\s+)?class\s+\w+/gm,
    /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/gm,
  ],
  jsx: [
    /^\s*import\s.+$/gm,
    /^\s*export\s+(?:default\s+)?(?:class|function)\b.*$/gm,
    /^\s*(?:export\s+)?(?:async\s+)?function\s+\w+/gm,
    /^\s*(?:export\s+)?class\s+\w+/gm,
    /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/gm,
  ],
  python: [
    /^\s*(?:from|import)\s+\w+/gm,
    /^\s*@[\w.]+/gm,
    /^\s*(?:async\s+def|def|class)\s+\w+/gm,
  ],
  go: [/^\s*import\s+(?:\(|")/gm, /^\s*(?:func|type|const|var)\s+\w+/gm],
  rust: [
    /^\s*use\s+[A-Za-z0-9_:{}*, ]+;/gm,
    /^\s*(?:pub\s+)?(?:fn|struct|enum|trait|impl)\b/gm,
  ],
};

export interface CodeChunkingStatus {
  mode: typeof CODE_CHUNK_MODE;
  supportedExtensions: string[];
}

export function getCodeChunkingStatus(): CodeChunkingStatus {
  return {
    mode: CODE_CHUNK_MODE,
    supportedExtensions: [...CODE_SUPPORTED_EXTENSIONS],
  };
}

function detectCodeChunkLanguage(
  sourcePath?: string
): CodeChunkLanguage | null {
  if (!sourcePath) {
    return null;
  }

  const normalized = sourcePath.toLowerCase();
  const matchedExtension = Object.keys(CODE_EXTENSION_MAP).find((extension) =>
    normalized.endsWith(extension)
  );

  if (!matchedExtension) {
    return null;
  }

  return CODE_EXTENSION_MAP[matchedExtension] ?? null;
}

function collectStructuralBreakPoints(
  text: string,
  sourcePath?: string
): number[] {
  const language = detectCodeChunkLanguage(sourcePath);
  if (!language) {
    return [];
  }

  const patterns = CODE_BREAKPOINT_PATTERNS[language];
  if (!patterns) {
    return [];
  }

  // Keep independent per-pattern scans so overlapping multiline matches (e.g.,
  // `export default\nclass Foo`, U+2028 line separators, and `export\nclass`)
  // produce bit-for-bit identical breakpoint offsets; findStructuralBreakPoint
  // uses binary search over the sorted result.
  const points = new Set<number>();
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null = null;
    while (true) {
      match = pattern.exec(text);
      if (!match) {
        break;
      }
      if (match.index > 0) {
        points.add(match.index);
      }
    }
  }

  return [...points].sort((a, b) => a - b);
}

function findStructuralBreakPoint(
  breakPoints: number[],
  currentPos: number,
  target: number,
  windowSize: number,
  minChunkChars: number
): number | null {
  const len = breakPoints.length;
  if (len === 0) {
    return null;
  }

  const minStart = currentPos + minChunkChars;
  const start = Math.max(minStart, target - windowSize);
  const end = target + windowSize;
  if (start > end) {
    return null;
  }

  // Lower bound: first index with breakPoints[idx] >= start
  let low = 0;
  let high = len;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((breakPoints[mid] ?? 0) < start) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  const first = breakPoints[low];
  if (first === undefined || first > end) {
    return null;
  }
  if (first > target) {
    return first;
  }

  // Upper bound: first index with breakPoints[idx] > target
  let uLow = low;
  let uHigh = len;
  const limit = Math.min(target, end);
  while (uLow < uHigh) {
    const mid = (uLow + uHigh) >>> 1;
    if ((breakPoints[mid] ?? 0) <= limit) {
      uLow = mid + 1;
    } else {
      uHigh = mid;
    }
  }

  return breakPoints[uLow - 1] ?? null;
}

/**
 * Find 1-based line number at character position using binary search (O(log n))
 * over line start offsets (`[0, nl0 + 1, nl1 + 1, ...]`).
 */
function lineAtPosition(lineStarts: readonly number[], pos: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  let lineIndex = 0;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    const lineStart = lineStarts[mid];
    if (lineStart === undefined) break;
    if (lineStart <= pos) {
      lineIndex = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return lineIndex + 1; // 1-based line number
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
  const paraBreak = windowText.lastIndexOf("\n\n");
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
    const whitespace = match[1] ?? "";
    const breakPos = start + match.index + 1 + whitespace.length;
    if (breakPos <= target + windowSize) {
      lastSentenceMatch = match;
    }
  }

  if (lastSentenceMatch) {
    // Break after the punctuation and whitespace, before the capital
    const whitespace = lastSentenceMatch[1] ?? "";
    return start + lastSentenceMatch.index + 1 + whitespace.length;
  }

  // Look for single newline
  const lineBreak = windowText.lastIndexOf("\n");
  if (lineBreak !== -1) {
    return start + lineBreak + 1;
  }

  // Look for word boundary
  const wordBoundary = windowText.lastIndexOf(" ");
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
    documentLanguageHint?: string,
    sourcePath?: string,
    precomputedLineOffsets?: readonly number[]
  ): ChunkOutput[] {
    if (!markdown || !NON_WHITESPACE_REGEX.test(markdown)) {
      return [];
    }

    // Normalize params to prevent degenerate behavior
    const { maxTokens, overlapPercent } = normalizeChunkParams(params);

    const maxChars = maxTokens * CHARS_PER_TOKEN;
    const overlapChars = Math.floor(maxChars * overlapPercent);
    const windowSize = Math.floor(maxChars * 0.1); // 10% window for break search
    const minCodeChunkChars = Math.floor(maxChars * MIN_CODE_CHUNK_PERCENT);

    // Reuse precomputed line start offsets when available; otherwise scan once.
    const lineStarts = precomputedLineOffsets ?? buildLineOffsets(markdown);
    const structuralBreakPoints = collectStructuralBreakPoints(
      markdown,
      sourcePath
    );

    const chunks: ChunkOutput[] = [];
    let pos = 0;
    let seq = 0;

    while (pos < markdown.length) {
      // Calculate target end position
      const targetEnd = pos + maxChars;

      let endPos: number;
      let usedStructuralBreak = false;
      if (targetEnd >= markdown.length) {
        // Last chunk - take rest
        endPos = markdown.length;
      } else {
        const structuralBreakPoint = findStructuralBreakPoint(
          structuralBreakPoints,
          pos,
          targetEnd,
          windowSize,
          minCodeChunkChars
        );
        usedStructuralBreak = structuralBreakPoint !== null;
        endPos =
          structuralBreakPoint ??
          // Find a good prose break point
          findBreakPoint(markdown, targetEnd, windowSize);
      }
      if (endPos <= pos) {
        endPos = Math.min(markdown.length, pos + maxChars);
      }
      if (endPos - pos > maxChars + windowSize) {
        endPos = Math.min(markdown.length, pos + maxChars);
      }

      // Extract chunk text - preserve exactly (no trim!)
      // This maintains accurate pos/line mappings and Markdown semantics
      const text = markdown.slice(pos, endPos);

      // Only skip truly empty chunks (all whitespace after full content consumed)
      if (NON_WHITESPACE_REGEX.test(text)) {
        const startLine = lineAtPosition(lineStarts, pos);
        const endLine = lineAtPosition(lineStarts, endPos - 1);

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

      // Structural chunks should begin on the detected boundary, not in the
      // middle of the previous code block due to overlap backtracking.
      const nextPos = usedStructuralBreak ? endPos : endPos - overlapChars;
      pos = Math.max(pos + 1, nextPos); // Ensure we always advance
    }

    return chunks;
  }
}

/**
 * Default chunker instance.
 */
export const defaultChunker = new MarkdownChunker();
