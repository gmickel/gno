/**
 * MCP adapter for the shared request collection allowlist.
 *
 * @module src/mcp/tools/collection-scope
 */

import type { ToolContext } from "../server";

import { resolveCollectionScope } from "../../core/collection-scope";

/**
 * Resolve `collections` for gno_search, gno_vsearch and gno_query. Throws a
 * `VALIDATION:` error for malformed input or `collection` plus `collections`,
 * and the existing unknown-collection error for names not configured.
 */
export function requestCollections(
  args: { collection?: string; collections?: string[] },
  ctx: Pick<ToolContext, "collections">
): string[] | undefined {
  const scope = resolveCollectionScope(args, ctx.collections);
  if (scope.ok) return scope.collections;
  throw new Error(
    scope.kind === "validation" ? `VALIDATION: ${scope.message}` : scope.message
  );
}
