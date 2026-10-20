/**
 * Shared bound for request-level collection allowlists.
 *
 * Deployments that keep one collection per access boundary routinely have
 * several hundred collections, and a caller scoped to all of them must still
 * fit in one `collections` allowlist. The value matches the collection egress
 * bound so a scope accepted here is never rejected later for its size.
 *
 * @module src/core/collection-limits
 */

/** Maximum names in one `collections` allowlist (MCP and REST). */
export const MAX_REQUEST_COLLECTIONS = 1024;
