/**
 * MCP gno_status tool - Index status and health.
 *
 * @module src/mcp/tools/status
 */

import type { CollectionStatus, IndexStatus } from "../../store/types";
import type { ToolContext } from "../server";

import { buildContentTypeBoostStatus } from "../../config/content-types";
import { formatChunkingStatus } from "../../core/chunking-status";
import { OWNER_CONFIG_PATH_FIELDS, withoutFields } from "../../core/host-paths";
import { formatVectorPartitionLines } from "../../core/vector-partition-status";
import { resolveModelUri } from "../../llm/registry";
import { createStandaloneResidentStatus } from "../../serve/resident-status";
import { exposesHostPaths } from "../context";
import { runTool, type ToolResult } from "./index";

type StatusInput = Record<string, never>;

/** Status as the caller sees it: HTTP callers get no owner config paths. */
type StatusView = Omit<IndexStatus, "configPath" | "dbPath" | "collections"> &
  Partial<Pick<IndexStatus, "configPath" | "dbPath">> & {
    collections: Array<
      Omit<CollectionStatus, "path"> & Partial<Pick<CollectionStatus, "path">>
    >;
  };

/**
 * Format status as text for MCP content.
 */
function formatStatus(status: StatusView): string {
  const lines: string[] = [];

  lines.push(`Index: ${status.indexName}`);
  if (status.configPath) lines.push(`Config: ${status.configPath}`);
  if (status.dbPath) lines.push(`Database: ${status.dbPath}`);
  lines.push(`Health: ${status.healthy ? "OK" : "DEGRADED"}`);
  if ("resident" in status) {
    const resident = status.resident as NonNullable<
      ReturnType<NonNullable<ToolContext["getResidentStatus"]>>
    >;
    lines.push(
      `Runtime: ${resident.mode}${resident.resident ? ` (${resident.transport.activeSessions} sessions)` : " (standalone)"}`
    );
  }
  lines.push("");

  if (status.collections.length === 0) {
    lines.push("No collections configured.");
  } else {
    lines.push("Collections:");
    for (const c of status.collections) {
      lines.push(
        `  ${c.name}: ${c.activeDocuments} docs, ${c.totalChunks} chunks` +
          (c.embeddedChunks > 0 ? `, ${c.embeddedChunks} embedded` : "")
      );
    }
  }

  lines.push("");
  lines.push(
    `Total: ${status.activeDocuments} documents, ${status.totalChunks} chunks`
  );

  if (status.typedMetadata)
    lines.push(
      `Typed metadata: ${status.typedMetadata.pending} pending sync, ${status.typedMetadata.invalid} invalid`
    );
  if (status.embeddingBacklog > 0) {
    lines.push(`Embedding backlog: ${status.embeddingBacklog} chunks`);
  }
  lines.push(
    ...formatVectorPartitionLines(status.vectorPartitions, status.vectorRuntime)
  );

  const chunking = formatChunkingStatus(status.chunking);
  if (chunking) lines.push(chunking);

  if (status.recentErrors > 0) {
    lines.push(`Recent errors: ${status.recentErrors} (last 24h)`);
  }

  if (status.lastUpdatedAt) {
    lines.push(`Last updated: ${status.lastUpdatedAt}`);
  }

  return lines.join("\n");
}

/**
 * Handle gno_status tool call.
 */
export function handleStatus(
  _args: StatusInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_status",
    async (): Promise<StatusView> => {
      const result = await ctx.store.getStatus({
        embedModel: resolveModelUri(ctx.config, "embed"),
        chunking: ctx.config.chunking ?? {},
      });
      if (!result.ok) {
        throw new Error(result.error.message);
      }

      // Override configPath with actual path from context
      const status = {
        ...result.value,
        configPath: ctx.actualConfigPath,
        contentTypeBoost: buildContentTypeBoostStatus(
          ctx.config.contentTypes ?? []
        ),
        resident:
          ctx.getResidentStatus?.() ?? createStandaloneResidentStatus("stdio"),
      };
      return exposesHostPaths(ctx)
        ? status
        : withoutFields(status, OWNER_CONFIG_PATH_FIELDS);
    },
    formatStatus
  );
}
