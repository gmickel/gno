/**
 * MCP gno_peek tool — cheap peek@1.0 snapshot, model-free.
 *
 * @module src/mcp/tools/peek
 */

import type { PeekSnapshot } from "../../core/peek";
import type { ToolContext } from "../server";

import { buildPeekSnapshot } from "../../core/peek";
import { runTool, type ToolResult } from "./index";

type PeekInput = Record<string, never>;

export const PEEK_MCP_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function formatPeek(snapshot: PeekSnapshot): string {
  const lines = [
    `schema: ${snapshot.schemaVersion}`,
    `gno: ${snapshot.gnoVersion}`,
    `index: ${snapshot.indexName}`,
    `initialized: ${snapshot.initialized ? "yes" : "no"}`,
  ];
  if (snapshot.counts) {
    lines.push(
      `documents: ${snapshot.counts.documents}`,
      `collections: ${snapshot.counts.collections}`
    );
  }
  if (snapshot.backlog) {
    lines.push(
      `backlog: ${snapshot.backlog.pending} pending, ${snapshot.backlog.failed} failed`
    );
  }
  if (snapshot.lastIndexedAt) {
    lines.push(`lastIndexedAt: ${snapshot.lastIndexedAt}`);
  }
  lines.push(
    snapshot.serve.running && snapshot.serve.url
      ? `serve: ${snapshot.serve.url}`
      : "serve: down"
  );
  if (snapshot.recent.length > 0) {
    lines.push("recent:");
    for (const item of snapshot.recent) {
      const label = item.title ?? item.uri;
      lines.push(`  ${item.docid} ${label}`);
    }
  }
  return lines.join("\n");
}

/**
 * Handle gno_peek tool call.
 *
 * Uninitialized (no config / no store) is a success payload, not an error.
 * Never probes serve over HTTP; the shared builder uses pid-file liveness.
 */
export function handlePeek(
  _args: PeekInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_peek",
    async () =>
      buildPeekSnapshot({
        configPath: ctx.actualConfigPath,
        indexName: ctx.indexName,
      }),
    formatPeek
  );
}
