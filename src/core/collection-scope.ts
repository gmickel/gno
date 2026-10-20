/**
 * Request-level collection allowlist shared by search, vsearch and query on
 * every surface (CLI, MCP, REST, SDK).
 *
 * @module src/core/collection-scope
 */

/** Most collections one request may list; matches the audit scope bound. */
export const MAX_REQUEST_COLLECTIONS = 256;

export type CollectionListResult =
  | { ok: true; value: string[] }
  | { ok: false; message: string };

/**
 * Normalize a `collections` allowlist: trim, lowercase, de-duplicate, sort.
 * Rejects non-arrays, non-string or blank members, an empty list, and lists
 * longer than {@link MAX_REQUEST_COLLECTIONS} after normalization.
 */
export function normalizeCollectionList(input: unknown): CollectionListResult {
  if (!Array.isArray(input)) {
    return { ok: false, message: "collections must be an array of names" };
  }
  const names = new Set<string>();
  for (const value of input) {
    if (typeof value !== "string" || value.trim() === "") {
      return {
        ok: false,
        message: "collections must contain only non-empty collection names",
      };
    }
    names.add(value.trim().toLowerCase());
  }
  if (names.size === 0) {
    return { ok: false, message: "collections must list at least one name" };
  }
  if (names.size > MAX_REQUEST_COLLECTIONS) {
    return {
      ok: false,
      message: `collections must list at most ${MAX_REQUEST_COLLECTIONS} names`,
    };
  }
  return {
    ok: true,
    value: [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  };
}

/** Error text when a request names both `collection` and `collections`. */
export const COLLECTION_AND_COLLECTIONS_MESSAGE =
  "Pass either collection or collections, not both";

/** Names in `requested` that are not configured, in request order. */
export function unknownCollections(
  requested: readonly string[],
  configured: readonly { name: string }[]
): string[] {
  const known = new Set(configured.map(({ name }) => name.toLowerCase()));
  return requested.filter((name) => !known.has(name));
}

/** The existing unknown-collection message, naming every unknown name. */
export function unknownCollectionsMessage(names: readonly string[]): string {
  return names.length === 1
    ? `Collection not found: ${names[0]}`
    : `Collections not found: ${names.join(", ")}`;
}

export type CollectionScopeResult =
  | { ok: true; collections: string[] | undefined }
  | { ok: false; kind: "validation" | "not_found"; message: string };

/**
 * Resolve a request's `collections` allowlist against the configured
 * collections. Absent `collections` resolves to undefined (unchanged
 * single-collection behaviour). Both inputs together, a malformed list, or
 * any unknown name is refused.
 */
export function resolveCollectionScope(
  input: { collection?: unknown; collections?: unknown },
  configured: readonly { name: string }[]
): CollectionScopeResult {
  if (input.collections === undefined)
    return { ok: true, collections: undefined };
  if (input.collection !== undefined) {
    return {
      ok: false,
      kind: "validation",
      message: COLLECTION_AND_COLLECTIONS_MESSAGE,
    };
  }
  const normalized = normalizeCollectionList(input.collections);
  if (!normalized.ok) {
    return { ok: false, kind: "validation", message: normalized.message };
  }
  const unknown = unknownCollections(normalized.value, configured);
  if (unknown.length > 0) {
    return {
      ok: false,
      kind: "not_found",
      message: unknownCollectionsMessage(unknown),
    };
  }
  return { ok: true, collections: normalized.value };
}
