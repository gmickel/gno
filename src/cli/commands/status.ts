/**
 * gno status command implementation.
 * Display index status and health information.
 *
 * @module src/cli/commands/status
 */

import type { ActivationStatus } from "../../core/activation-status";
import type { IndexStatus } from "../../store/types";

import { getIndexDbPath, getModelsCachePath } from "../../app/constants";
import { getConfigPaths, isInitialized, loadConfig } from "../../config";
import { isConnectorActivationComplete } from "../../core/activation-connector-health";
import { buildActivationStatus } from "../../core/activation-status";
import { ModelCache } from "../../llm/cache";
import { getActivePreset, resolveModelUri } from "../../llm/registry";
import { getConnectorVerificationTargets } from "../../serve/connectors";
import { createStandaloneResidentStatus } from "../../serve/resident-status";
import { SqliteAdapter } from "../../store/sqlite/adapter";

/**
 * Options for status command.
 */
export interface StatusOptions {
  /** Override config path */
  configPath?: string;
  /** Index name */
  indexName?: string;
  /** Output as JSON */
  json?: boolean;
  /** Output as Markdown */
  md?: boolean;
}

/**
 * Result of status command.
 */
export type StatusResult =
  | { success: true; status: IndexStatus; activation: ActivationStatus }
  | { success: false; error: string };

function connectorProjectionLine(activation: ActivationStatus): string | null {
  const { projected, total, truncated } = activation.connectorProjection;
  if (!truncated) {
    return null;
  }
  return `Connector projection: ${projected}/${total} target/collection checks shown; ${total - projected} omitted`;
}

function isStatusHealthy(
  indexStatus: IndexStatus,
  activation: ActivationStatus
): boolean {
  return (
    indexStatus.healthy &&
    activation.healthy &&
    isConnectorActivationComplete(activation)
  );
}

/**
 * Format status as terminal output.
 */
function formatTerminal(
  indexStatus: IndexStatus,
  activation: ActivationStatus
): string {
  const lines: string[] = [];

  lines.push(`Index: ${indexStatus.indexName}`);
  lines.push(`Config: ${indexStatus.configPath}`);
  lines.push(`Database: ${indexStatus.dbPath}`);
  lines.push("");

  if (indexStatus.collections.length === 0) {
    lines.push("No collections configured.");
  } else {
    lines.push("Collections:");
    for (const c of indexStatus.collections) {
      lines.push(
        `  ${c.name}: ${c.activeDocuments} docs, ${c.totalChunks} chunks` +
          (c.embeddedChunks > 0 ? `, ${c.embeddedChunks} embedded` : "")
      );
    }
  }

  lines.push("");
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

  lines.push(
    `Health: ${isStatusHealthy(indexStatus, activation) ? "OK" : "DEGRADED"}`
  );
  lines.push("");
  lines.push(
    `Lexical activation: ${activation.healthy ? "READY" : activation.usable ? "DEGRADED" : "BLOCKED"}`
  );
  for (const collection of activation.collections) {
    const failedStage = collection.remediation?.stage;
    const suffix = failedStage
      ? ` (${failedStage}: ${collection.remediation?.code}; ${collection.remediation?.command})`
      : ` (semantic: ${collection.semanticAvailability.code})`;
    lines.push(
      `  ${collection.collection}: ${collection.ready ? "lexical ready" : "not ready"}${suffix}`
    );
  }
  if (activation.connectors.length > 0) {
    lines.push("Connector proofs:");
    for (const connector of activation.connectors) {
      lines.push(
        `  ${connector.target}/${connector.collection}: ${connector.status}${connector.code ? ` (${connector.code})` : ""}`
      );
    }
  }
  const projectionLine = connectorProjectionLine(activation);
  if (projectionLine) {
    lines.push(projectionLine);
  }

  return lines.join("\n");
}

/**
 * Format status as Markdown.
 */
function formatMarkdown(
  indexStatus: IndexStatus,
  activation: ActivationStatus
): string {
  const lines: string[] = [];

  lines.push(`# Index Status: ${indexStatus.indexName}`);
  lines.push("");
  lines.push(`- **Config**: ${indexStatus.configPath}`);
  lines.push(`- **Database**: ${indexStatus.dbPath}`);
  lines.push(
    `- **Health**: ${isStatusHealthy(indexStatus, activation) ? "✓ OK" : "⚠ DEGRADED"}`
  );
  lines.push("");

  if (indexStatus.collections.length > 0) {
    lines.push("## Collections");
    lines.push("");
    lines.push("| Name | Path | Docs | Chunks | Embedded |");
    lines.push("|------|------|------|--------|----------|");
    for (const c of indexStatus.collections) {
      lines.push(
        `| ${c.name} | ${c.path} | ${c.activeDocuments} | ${c.totalChunks} | ${c.embeddedChunks} |`
      );
    }
    lines.push("");
  }

  lines.push("## Summary");
  lines.push("");
  lines.push(`- **Documents**: ${indexStatus.activeDocuments}`);
  lines.push(`- **Chunks**: ${indexStatus.totalChunks}`);
  lines.push(`- **Embedding backlog**: ${indexStatus.embeddingBacklog}`);
  lines.push(`- **Recent errors**: ${indexStatus.recentErrors}`);

  if (indexStatus.lastUpdatedAt) {
    lines.push(`- **Last updated**: ${indexStatus.lastUpdatedAt}`);
  }

  lines.push("");
  lines.push("## Lexical activation");
  lines.push("");
  lines.push(`- **Usable**: ${activation.usable}`);
  lines.push(`- **Lexically healthy**: ${activation.healthy}`);
  for (const collection of activation.collections) {
    lines.push(
      `- **${collection.collection}**: ${collection.ready ? "lexical ready" : `${collection.remediation?.stage ?? "index"} ${collection.remediation?.code ?? "index_query_failed"}`}`
    );
  }
  for (const connector of activation.connectors) {
    lines.push(
      `- **${connector.target}/${connector.collection}**: ${connector.status}${connector.code ? ` (${connector.code})` : ""}`
    );
  }
  const projectionLine = connectorProjectionLine(activation);
  if (projectionLine) {
    lines.push(`- **${projectionLine}**`);
  }

  return lines.join("\n");
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
    return { success: false, error: "GNO not initialized. Run: gno init" };
  }

  // Load config
  const configResult = await loadConfig(options.configPath);
  if (!configResult.ok) {
    return { success: false, error: configResult.error.message };
  }
  const config = configResult.value;

  // Open database
  const store = new SqliteAdapter();
  const dbPath = getIndexDbPath(options.indexName);
  const paths = getConfigPaths();

  // Set configPath for status output
  store.setConfigPath(options.configPath ?? paths.configFile);

  const openResult = await store.open(dbPath, config.ftsTokenizer);
  if (!openResult.ok) {
    return { success: false, error: openResult.error.message };
  }

  try {
    const statusResult = await store.getStatus({
      embedModel: resolveModelUri(config, "embed"),
    });
    if (!statusResult.ok) {
      return { success: false, error: statusResult.error.message };
    }

    const preset = getActivePreset(config);
    const embedModelCached = await new ModelCache(
      getModelsCachePath()
    ).isCached(preset.embed);
    const activation = await buildActivationStatus(
      store,
      config.collections.map(({ name }) => name),
      {
        semantic: {
          modelsCached: embedModelCached,
          embeddingBacklog: statusResult.value.embeddingBacklog,
        },
        connectorTargets: await getConnectorVerificationTargets(),
      }
    );

    return { success: true, status: statusResult.value, activation };
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
      ? JSON.stringify({ error: { code: "RUNTIME", message: result.error } })
      : `Error: ${result.error}`;
  }

  if (options.json) {
    // Transform to match CLI spec output format
    const s = result.status;
    return JSON.stringify(
      {
        resident: createStandaloneResidentStatus("direct-cli"),
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
        healthy: isStatusHealthy(s, result.activation),
        activation: result.activation,
      },
      null,
      2
    );
  }

  if (options.md) {
    return formatMarkdown(result.status, result.activation);
  }

  return formatTerminal(result.status, result.activation);
}
