/**
 * Reference parser for document refs.
 * Pure lexical parsing - NO store/config access.
 *
 * @module src/cli/commands/ref-parser
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type RefType = 'docid' | 'uri' | 'collPath';

export type ParsedRef = {
  type: RefType;
  /** Normalized ref (without :line suffix) */
  value: string;
  /** For collPath type */
  collection?: string;
  /** For collPath type */
  relPath?: string;
  /** Parsed :line suffix (1-indexed) */
  line?: number;
};

export type ParseRefResult = ParsedRef | { error: string };

// ─────────────────────────────────────────────────────────────────────────────
// Top-level regex patterns (perf: avoid recreating in functions)
// ─────────────────────────────────────────────────────────────────────────────

const DOCID_PATTERN = /^#[a-f0-9]{6,8}$/;
const LINE_SUFFIX_PATTERN = /:(\d+)$/;
const GLOB_PATTERN = /[*?[\]]/;

// ─────────────────────────────────────────────────────────────────────────────
// Parser Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a single ref string.
 * - Docid: starts with # (no :line suffix allowed)
 * - URI: starts with gno:// (optional :N suffix)
 * - Else: collection/path (optional :N suffix)
 */
export function parseRef(ref: string): ParseRefResult {
  // 1. DocID: starts with #, validate pattern
  if (ref.startsWith('#')) {
    if (ref.includes(':')) {
      return { error: 'Docid refs cannot have :line suffix' };
    }
    if (!DOCID_PATTERN.test(ref)) {
      return { error: `Invalid docid format: ${ref}` };
    }
    return { type: 'docid', value: ref };
  }

  // 2. Parse optional :line suffix for URI and collPath
  let line: number | undefined;
  let baseRef = ref;
  const lineMatch = ref.match(LINE_SUFFIX_PATTERN);
  if (lineMatch?.[1]) {
    const parsed = Number.parseInt(lineMatch[1], 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return { error: `Invalid line suffix (must be >= 1): ${ref}` };
    }
    line = parsed;
    baseRef = ref.slice(0, -lineMatch[0].length);
  }

  // 3. URI: starts with gno://
  if (baseRef.startsWith('gno://')) {
    return { type: 'uri', value: baseRef, line };
  }

  // 4. Collection/path: must contain /
  const slashIdx = baseRef.indexOf('/');
  if (slashIdx === -1) {
    return { error: `Invalid ref format (missing /): ${ref}` };
  }
  const collection = baseRef.slice(0, slashIdx);
  const relPath = baseRef.slice(slashIdx + 1);

  return { type: 'collPath', value: baseRef, collection, relPath, line };
}

/**
 * Split comma-separated refs. Does NOT expand globs.
 */
export function splitRefs(refs: string[]): string[] {
  const result: string[] = [];
  for (const r of refs) {
    for (const part of r.split(',')) {
      const trimmed = part.trim();
      if (trimmed) {
        result.push(trimmed);
      }
    }
  }
  return result;
}

/**
 * Check if a ref contains glob characters.
 */
export function isGlobPattern(ref: string): boolean {
  return GLOB_PATTERN.test(ref);
}
