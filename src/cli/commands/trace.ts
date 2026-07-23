/** Local retrieval-trace inspection, feedback, export, and deletion commands. */

import type {
  RetrievalTraceDeleteResult,
  RetrievalTraceDetail,
  RetrievalTraceLabelRequest,
  RetrievalTraceLabelResult,
  RetrievalTraceListResult,
  RetrievalTracePurgeResult,
} from "../../core/retrieval-trace-management";
import type { StoreResult } from "../../store/types";

import { atomicWrite } from "../../core/file-ops";
import { RetrievalTraceManagementService } from "../../core/retrieval-trace-management";
import { CliError } from "../errors";
import { initStore } from "./shared";

export type TraceOutputFormat = "json" | "md";

interface TraceCommandOptions {
  configPath?: string;
  indexName?: string;
  format?: TraceOutputFormat;
}

interface TraceExportOptions extends TraceCommandOptions {
  output?: string;
}

const unwrapTraceResult = <T>(result: StoreResult<T>): T => {
  if (result.ok) {
    return result.value;
  }
  throw new CliError(
    result.error.code === "INVALID_INPUT" ? "VALIDATION" : "RUNTIME",
    result.error.message,
    { details: { traceCode: result.error.code } }
  );
};

const withTraceService = async <T>(
  options: TraceCommandOptions,
  operation: (service: RetrievalTraceManagementService) => Promise<T>
): Promise<T> => {
  const initialized = await initStore({
    configPath: options.configPath,
    indexName: options.indexName,
    syncConfig: false,
    allowEmptyCollections: true,
  });
  if (!initialized.ok) {
    throw new CliError("RUNTIME", initialized.error);
  }
  try {
    return await operation(
      new RetrievalTraceManagementService(initialized.store)
    );
  } finally {
    await initialized.store.close();
  }
};

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const formatListMarkdown = (value: RetrievalTraceListResult): string => {
  const lines = [
    "# Retrieval traces",
    "",
    "| Trace | Status | Mode | Created |",
    "|---|---|---|---|",
  ];
  for (const trace of value.traces) {
    lines.push(
      `| \`${trace.traceId}\` | ${trace.status} | ${trace.redactionMode} | ${new Date(trace.createdAtMs).toISOString()} |`
    );
  }
  if (value.traces.length === 0) {
    lines.push("| — | — | — | — |");
  }
  if (value.nextCursor) {
    lines.push("", `Next cursor: \`${value.nextCursor}\``);
  }
  return `${lines.join("\n")}\n`;
};

const formatDetailMarkdown = (value: RetrievalTraceDetail): string => {
  const trace = value.trace;
  const lines = [
    `# Retrieval trace \`${trace.traceId}\``,
    "",
    `- Status: **${trace.status}**`,
    `- Redaction: **${trace.redactionMode}**`,
    `- Replay capable: **${trace.replayCapable ? "yes" : "no"}**`,
    `- Created: ${new Date(trace.createdAtMs).toISOString()}`,
    `- Updated: ${new Date(trace.updatedAtMs).toISOString()}`,
    "",
    "## Records",
    "",
    `- Runs: ${value.runs.length}`,
    `- Events: ${value.events.length}`,
    `- Judgments: ${value.judgments.length}`,
    `- Exports: ${value.exports.length}`,
  ];
  const truncatedSections = Object.entries(value.truncated)
    .filter(([, truncated]) => truncated)
    .map(([section]) => section);
  if (truncatedSections.length > 0) {
    lines.push(
      "",
      `Detail truncated: ${truncatedSections.join(", ")}. Request a larger bounded detail limit.`
    );
  }
  return `${lines.join("\n")}\n`;
};

const formatMutationMarkdown = (
  heading: string,
  value:
    | RetrievalTraceLabelResult
    | RetrievalTraceDeleteResult
    | RetrievalTracePurgeResult
): string =>
  `# ${heading}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;

export const traceList = async (
  input: { limit?: number; cursor?: string },
  options: TraceCommandOptions = {}
): Promise<string> => {
  const value = await withTraceService(options, async (service) =>
    unwrapTraceResult(await service.list(input))
  );
  return options.format === "md" ? formatListMarkdown(value) : json(value);
};

export const traceShow = async (
  traceId: string,
  input: { detailLimit?: number },
  options: TraceCommandOptions = {}
): Promise<string> => {
  const value = await withTraceService(options, async (service) =>
    unwrapTraceResult(await service.show(traceId, input))
  );
  return options.format === "md" ? formatDetailMarkdown(value) : json(value);
};

export const traceLabel = async (
  input: RetrievalTraceLabelRequest,
  options: TraceCommandOptions = {}
): Promise<string> => {
  const value = await withTraceService(options, async (service) =>
    unwrapTraceResult(await service.label(input))
  );
  return options.format === "md"
    ? formatMutationMarkdown("Retrieval trace judgment", value)
    : json(value);
};

export const traceExport = async (
  traceIds: string[],
  options: TraceExportOptions = {}
): Promise<string> => {
  const value = await withTraceService(options, async (service) =>
    unwrapTraceResult(
      await service.export({ traceIds, format: "agentic-receipt" })
    )
  );
  const artifact = json(value.artifact);
  if (options.output) {
    await atomicWrite(options.output, artifact);
    return "";
  }
  return json(value);
};

export const traceDelete = async (
  traceId: string,
  options: TraceCommandOptions = {}
): Promise<string> => {
  const value = await withTraceService(options, async (service) =>
    unwrapTraceResult(await service.delete(traceId))
  );
  return options.format === "md"
    ? formatMutationMarkdown("Retrieval trace deleted", value)
    : json(value);
};

export const tracePurge = async (
  options: TraceCommandOptions = {}
): Promise<string> => {
  const value = await withTraceService(options, async (service) =>
    unwrapTraceResult(await service.purge())
  );
  return options.format === "md"
    ? formatMutationMarkdown("Retrieval traces purged", value)
    : json(value);
};
