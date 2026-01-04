/**
 * MCP gno_list_tags tool - List tags with counts.
 *
 * @module src/mcp/tools/list-tags
 */

import type { TagCount } from "../../store/types";
import type { ToolContext } from "../server";

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
      // Validate collection exists if specified
      if (args.collection) {
        const exists = ctx.collections.some((c) => c.name === args.collection);
        if (!exists) {
          throw new Error(`Collection not found: ${args.collection}`);
        }
      }

      const result = await ctx.store.getTagCounts({
        collection: args.collection,
        prefix: args.prefix,
      });

      if (!result.ok) {
        throw new Error(result.error.message);
      }

      return {
        tags: result.value,
        meta: {
          collection: args.collection,
          prefix: args.prefix,
          totalTags: result.value.length,
        },
      };
    },
    formatTagList
  );
}
