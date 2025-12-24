/**
 * gno status command implementation.
 * Display index status and health information.
 *
 * @module src/cli/commands/status
 */

import { getIndexDbPath } from '../../app/constants';
import { getConfigPaths, isInitialized, loadConfig } from '../../config';
import { SqliteAdapter } from '../../store/sqlite/adapter';
import type { IndexStatus } from '../../store/types';

/**
 * Options for status command.
 */
export type StatusOptions = {
  /** Override config path */
  configPath?: string;
  /** Output as JSON */
  json?: boolean;
  /** Output as Markdown */
  md?: boolean;
};

/**
 * Result of status command.
 */
export type StatusResult =
  | { success: true; status: IndexStatus }
  | { success: false; error: string };

/**
 * Format status as terminal output.
 */
function formatTerminal(indexStatus: IndexStatus): string {
  const lines: string[] = [];

  lines.push(`Index: ${indexStatus.indexName}`);
  lines.push(`Config: ${indexStatus.configPath}`);
  lines.push(`Database: ${indexStatus.dbPath}`);
  lines.push('');

  if (indexStatus.collections.length === 0) {
    lines.push('No collections configured.');
  } else {
    lines.push('Collections:');
    for (const c of indexStatus.collections) {
      lines.push(
        `  ${c.name}: ${c.activeDocuments} docs, ${c.totalChunks} chunks` +
          (c.embeddedChunks > 0 ? `, ${c.embeddedChunks} embedded` : '')
      );
    }
  }

  lines.push('');
  lines.push(
    `Total: ${indexStatus.activeDocuments} documents, ${indexStatus.totalChunks} chunks`
  );

  if (indexStatus.embeddingBacklog > 0) {
    lines.push(`Embedding backlog: ${indexStatus.embeddingBacklog} chunks`);
  }

  if (indexStatus.recentErrors > 0) {
    lines.push(`Recent errors: ${indexStatus.recentErrors} (last 24h)`);
  }

  if (indexStatus.lastUpdatedAt) {
    lines.push(`Last updated: ${indexStatus.lastUpdatedAt}`);
  }

  lines.push(`Health: ${indexStatus.healthy ? 'OK' : 'DEGRADED'}`);

  return lines.join('\n');
}

/**
 * Format status as Markdown.
 */
function formatMarkdown(indexStatus: IndexStatus): string {
  const lines: string[] = [];

  lines.push(`# Index Status: ${indexStatus.indexName}`);
  lines.push('');
  lines.push(`- **Config**: ${indexStatus.configPath}`);
  lines.push(`- **Database**: ${indexStatus.dbPath}`);
  lines.push(`- **Health**: ${indexStatus.healthy ? '✓ OK' : '⚠ DEGRADED'}`);
  lines.push('');

  if (indexStatus.collections.length > 0) {
    lines.push('## Collections');
    lines.push('');
    lines.push('| Name | Path | Docs | Chunks | Embedded |');
    lines.push('|------|------|------|--------|----------|');
    for (const c of indexStatus.collections) {
      lines.push(
        `| ${c.name} | ${c.path} | ${c.activeDocuments} | ${c.totalChunks} | ${c.embeddedChunks} |`
      );
    }
    lines.push('');
  }

  lines.push('## Summary');
  lines.push('');
  lines.push(`- **Documents**: ${indexStatus.activeDocuments}`);
  lines.push(`- **Chunks**: ${indexStatus.totalChunks}`);
  lines.push(`- **Embedding backlog**: ${indexStatus.embeddingBacklog}`);
  lines.push(`- **Recent errors**: ${indexStatus.recentErrors}`);

  if (indexStatus.lastUpdatedAt) {
    lines.push(`- **Last updated**: ${indexStatus.lastUpdatedAt}`);
  }

  return lines.join('\n');
}

/**
 * Execute gno status command.
 */
export async function status(
  options: StatusOptions = {}
): Promise<StatusResult> {
  // Check if initialized
  const initialized = await isInitialized(options.configPath);
  if (!initialized) {
    return { success: false, error: 'GNO not initialized. Run: gno init' };
  }

  // Load config
  const configResult = await loadConfig(options.configPath);
  if (!configResult.ok) {
    return { success: false, error: configResult.error.message };
  }
  const config = configResult.value;

  // Open database
  const store = new SqliteAdapter();
  const dbPath = getIndexDbPath();
  const paths = getConfigPaths();

  // Set configPath for status output
  store.setConfigPath(paths.configFile);

  const openResult = await store.open(dbPath, config.ftsTokenizer);
  if (!openResult.ok) {
    return { success: false, error: openResult.error.message };
  }

  try {
    const statusResult = await store.getStatus();
    if (!statusResult.ok) {
      return { success: false, error: statusResult.error.message };
    }

    return { success: true, status: statusResult.value };
  } finally {
    await store.close();
  }
}

/**
 * Format status result for output.
 */
export function formatStatus(
  result: StatusResult,
  options: StatusOptions
): string {
  if (!result.success) {
    return options.json
      ? JSON.stringify({ error: { code: 'RUNTIME', message: result.error } })
      : `Error: ${result.error}`;
  }

  if (options.json) {
    // Transform to match CLI spec output format
    const s = result.status;
    return JSON.stringify(
      {
        indexName: s.indexName,
        configPath: s.configPath,
        dbPath: s.dbPath,
        collections: s.collections.map((c) => ({
          name: c.name,
          path: c.path,
          documentCount: c.activeDocuments,
          chunkCount: c.totalChunks,
          embeddedCount: c.embeddedChunks,
        })),
        totalDocuments: s.activeDocuments,
        totalChunks: s.totalChunks,
        embeddingBacklog: s.embeddingBacklog,
        lastUpdated: s.lastUpdatedAt,
        healthy: s.healthy,
      },
      null,
      2
    );
  }

  if (options.md) {
    return formatMarkdown(result.status);
  }

  return formatTerminal(result.status);
}
