/**
 * MCP gno.status tool - Index status and health.
 *
 * @module src/mcp/tools/status
 */

import type { IndexStatus } from '../../store/types';
import type { ToolContext } from '../server';
import { runTool, type ToolResult } from './index';

type StatusInput = Record<string, never>;

/**
 * Format status as text for MCP content.
 */
function formatStatus(status: IndexStatus): string {
  const lines: string[] = [];

  lines.push(`Index: ${status.indexName}`);
  lines.push(`Config: ${status.configPath}`);
  lines.push(`Database: ${status.dbPath}`);
  lines.push(`Health: ${status.healthy ? 'OK' : 'DEGRADED'}`);
  lines.push('');

  if (status.collections.length === 0) {
    lines.push('No collections configured.');
  } else {
    lines.push('Collections:');
    for (const c of status.collections) {
      lines.push(
        `  ${c.name}: ${c.activeDocuments} docs, ${c.totalChunks} chunks` +
          (c.embeddedChunks > 0 ? `, ${c.embeddedChunks} embedded` : '')
      );
    }
  }

  lines.push('');
  lines.push(
    `Total: ${status.activeDocuments} documents, ${status.totalChunks} chunks`
  );

  if (status.embeddingBacklog > 0) {
    lines.push(`Embedding backlog: ${status.embeddingBacklog} chunks`);
  }

  if (status.recentErrors > 0) {
    lines.push(`Recent errors: ${status.recentErrors} (last 24h)`);
  }

  if (status.lastUpdatedAt) {
    lines.push(`Last updated: ${status.lastUpdatedAt}`);
  }

  return lines.join('\n');
}

/**
 * Handle gno.status tool call.
 */
export function handleStatus(
  _args: StatusInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    'gno.status',
    async () => {
      const result = await ctx.store.getStatus();
      if (!result.ok) {
        throw new Error(result.error.message);
      }

      // Override configPath with actual path from context
      return {
        ...result.value,
        configPath: ctx.actualConfigPath,
      };
    },
    formatStatus
  );
}
