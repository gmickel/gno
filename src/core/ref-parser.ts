/**
 * Reference parser and resolver for document refs.
 * Pure parsing helpers stay store-free; resolution depends only on StorePort.
 *
 * @module src/core/ref-parser
 */

import type { DocumentRow, StorePort } from "../store/types";

export type RefType = "docid" | "uri" | "collPath";

export interface ParsedRef {
  type: RefType;
  /** Normalized ref (without :line suffix) */
  value: string;
  /** For collPath type */
  collection?: string;
  /** For collPath type */
  relPath?: string;
  /** Parsed :line suffix (1-indexed) */
  line?: number;
}

export type ParseRefResult = ParsedRef | { error: string };

export type ResolvedDocRef =
  | { doc: DocumentRow }
  | { error: string; isValidation: boolean };

const DOCID_PATTERN = /^#[a-f0-9]{6,}$/;
const LINE_SUFFIX_PATTERN = /:(\d+)$/;
const GLOB_PATTERN = /[*?[\]]/;

/**
 * Parse a single ref string.
 * - Docid: starts with # (no :line suffix allowed)
 * - URI: starts with gno:// (optional :N suffix)
 * - Else: collection/path (optional :N suffix)
 */
export function parseRef(ref: string): ParseRefResult {
  if (ref.startsWith("#")) {
    if (ref.includes(":")) {
      return { error: "Docid refs cannot have :line suffix" };
    }
    if (!DOCID_PATTERN.test(ref)) {
      return { error: `Invalid docid format: ${ref}` };
    }
    return { type: "docid", value: ref };
  }

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

  if (baseRef.startsWith("gno://")) {
    return { type: "uri", value: baseRef, line };
  }

  const slashIdx = baseRef.indexOf("/");
  if (slashIdx === -1) {
    return { error: `Invalid ref format (missing /): ${ref}` };
  }
  const collection = baseRef.slice(0, slashIdx);
  const relPath = baseRef.slice(slashIdx + 1);

  return { type: "collPath", value: baseRef, collection, relPath, line };
}

/**
 * Resolve a document reference against the store.
 */
export async function resolveDocRef(
  store: StorePort,
  docRef: string
): Promise<ResolvedDocRef> {
  const parsed = parseRef(docRef);

  if ("error" in parsed) {
    return { error: parsed.error, isValidation: true };
  }

  let doc: DocumentRow | null = null;

  switch (parsed.type) {
    case "docid": {
      const result = await store.getDocumentByDocid(parsed.value);
      if (result.ok && result.value) {
        doc = result.value;
      }
      break;
    }
    case "uri": {
      const result = await store.getDocumentByUri(parsed.value);
      if (result.ok && result.value) {
        doc = result.value;
      }
      break;
    }
    case "collPath": {
      const uri = `gno://${parsed.collection}/${parsed.relPath}`;
      const result = await store.getDocumentByUri(uri);
      if (result.ok && result.value) {
        doc = result.value;
      }
      break;
    }
  }

  if (!doc) {
    return { error: `Document not found: ${docRef}`, isValidation: true };
  }

  return { doc };
}

/**
 * Split comma-separated refs. Does NOT expand globs.
 */
export function splitRefs(refs: string[]): string[] {
  const result: string[] = [];
  for (const r of refs) {
    for (const part of r.split(",")) {
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
