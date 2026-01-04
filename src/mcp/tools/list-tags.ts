/**
 * MCP gno_list_tags tool - List tags with counts.
 *
 * @module src/mcp/tools/list-tags
 */

import type { TagCount } from "../../store/types";
import type { ToolContext } from "../server";

import { MCP_ERRORS } from "../../core/errors";
import { normalizeTag, validateTag } from "../../core/tags";
import { normalizeCollectionName } from "../../core/validation";
import { runTool, type ToolResult } from "./index";

interface ListTagsInput {
  collection?: string;
  prefix?: string;
}

interface ListTagsResult {
  tags: TagCount[];
  meta: {
    collection?: string;
    prefix?: string;
    totalTags: number;
  };
}

/**
 * Format tag list as text for MCP content.
 */
function formatTagList(data: ListTagsResult): string {
  if (data.tags.length === 0) {
    const filters: string[] = [];
    if (data.meta.collection) {
      filters.push(`collection=${data.meta.collection}`);
    }
    if (data.meta.prefix) {
      filters.push(`prefix=${data.meta.prefix}`);
    }
    const filterText = filters.length > 0 ? ` (${filters.join(", ")})` : "";
    return `No tags found${filterText}`;
  }

  const lines: string[] = [];
  lines.push(`Found ${data.tags.length} tags:`);
  lines.push("");

  for (const t of data.tags) {
    lines.push(`  ${t.tag} (${t.count})`);
  }

  return lines.join("\n");
}

/**
 * Handle gno_list_tags tool call.
 */
export function handleListTags(
  args: ListTagsInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_list_tags",
    async () => {
      // Normalize and validate collection (case-insensitive)
      let collection: string | undefined;
      if (args.collection) {
        collection = normalizeCollectionName(args.collection);
        const exists = ctx.collections.some(
          (c) => c.name.toLowerCase() === collection
        );
        if (!exists) {
          throw new Error(
            `${MCP_ERRORS.NOT_FOUND.code}: Collection not found: ${args.collection}`
          );
        }
      }

      // Normalize and validate prefix
      let prefix: string | undefined;
      if (args.prefix) {
        const trimmed = args.prefix.trim().replace(/\/+$/, "");
        if (trimmed.length > 0) {
          prefix = normalizeTag(trimmed);
          if (!validateTag(prefix)) {
            throw new Error(
              `${MCP_ERRORS.INVALID_INPUT.code}: Invalid tag prefix "${args.prefix}"`
            );
          }
        }
      }

      const result = await ctx.store.getTagCounts({ collection, prefix });

      if (!result.ok) {
        throw new Error(result.error.message);
      }

      return {
        tags: result.value,
        meta: {
          collection,
          prefix,
          totalTags: result.value.length,
        },
      };
    },
    formatTagList
  );
}
