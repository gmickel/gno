/**
 * `memory_search` / `memory_get` agent tools backed by GNO. Failure modes
 * (gno missing, below the pin, timeout, malformed output) come back as a
 * `disabled: true` response with a clear error, mirroring the memory-core
 * contract the prompt section tells the model to relay.
 */

import type { BackendLogger, GnoMemoryBackend, SearchOutcome } from "./backend";

import { GnoCliError } from "./gno-cli";

export interface ToolContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolContent[];
  details: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>
  ) => Promise<ToolResult>;
}

export interface ToolContext {
  workspaceDir?: string;
}

const SEARCH_PARAMETERS = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Search text. In keyword mode every term must match; in hybrid mode terms also match semantically, so plain natural-language phrasing works",
    },
    maxResults: { type: "integer", minimum: 1 },
    minScore: { type: "number" },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

const GET_PARAMETERS = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "gno:// URI from a search hit, or a workspace-relative path",
    },
    from: { type: "integer", minimum: 1 },
    lines: { type: "integer", minimum: 1 },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

export const MEMORY_SOURCES =
  "MEMORY.md, USER.md, and Markdown files under memory/ (indexed by GNO)";

function disabledResult(
  toolName: string,
  error: unknown,
  logger: BackendLogger
): ToolResult {
  const err =
    error instanceof GnoCliError
      ? error
      : new GnoCliError(
          "gno_command_failed",
          error instanceof Error ? error.message : String(error)
        );
  logger.error(
    `gno-memory: ${toolName} unavailable (${err.kind}): ${err.message}`
  );
  return {
    content: [
      {
        type: "text",
        text: `Memory unavailable (${err.kind}): ${err.message}`,
      },
    ],
    details: {
      disabled: true,
      error: { kind: err.kind, message: err.message, code: err.code },
    },
  };
}

export function formatSearchText(outcome: SearchOutcome): string {
  const lines: string[] = [];
  if (outcome.warning) lines.push(`Warning: ${outcome.warning}`);
  if (outcome.results.length === 0) {
    lines.push("No memory matches.");
    return lines.join("\n");
  }
  for (const hit of outcome.results) {
    lines.push(`- ${hit.snippet.trim()}`);
    lines.push(`  Source: ${hit.citation}`);
  }
  return lines.join("\n");
}

function textParam(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function intParam(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

export function createMemorySearchTool(
  backend: GnoMemoryBackend,
  logger: BackendLogger,
  ctx: ToolContext
): ToolDefinition {
  return {
    name: "memory_search",
    label: "Memory Search",
    description: `Mandatory recall step: search ${MEMORY_SOURCES} before answering questions about prior work, decisions, dates, people, preferences, or todos. Every hit carries a gno:// citation with a content hash. If the response has disabled=true or stale=true, tell the user and include the warning.`,
    parameters: SEARCH_PARAMETERS,
    async execute(_toolCallId, params) {
      try {
        const outcome = await backend.search(textParam(params.query), {
          workspaceDir: ctx.workspaceDir,
          maxResults: intParam(params.maxResults),
          minScore:
            typeof params.minScore === "number" ? params.minScore : undefined,
        });
        return {
          content: [{ type: "text", text: formatSearchText(outcome) }],
          details: {
            results: outcome.results,
            mode: outcome.mode,
            synced: outcome.synced,
            stale: outcome.stale !== null,
            ...(outcome.warning ? { warning: outcome.warning } : {}),
          },
        };
      } catch (error) {
        return disabledResult("memory_search", error, logger);
      }
    },
  };
}

export function createMemoryGetTool(
  backend: GnoMemoryBackend,
  logger: BackendLogger,
  ctx: ToolContext
): ToolDefinition {
  return {
    name: "memory_get",
    label: "Memory Get",
    description: `Exact excerpt read from ${MEMORY_SOURCES}. Pass the gno:// URI from a memory_search hit (or a workspace-relative path) plus optional from/lines to pull only the needed lines.`,
    parameters: GET_PARAMETERS,
    async execute(_toolCallId, params) {
      try {
        const excerpt = await backend.get(textParam(params.path), {
          workspaceDir: ctx.workspaceDir,
          from: intParam(params.from),
          lines: intParam(params.lines),
        });
        return {
          content: [
            {
              type: "text",
              text: `${excerpt.content}\nSource: ${excerpt.uri}`,
            },
          ],
          details: { ...excerpt, status: "ok" },
        };
      } catch (error) {
        return disabledResult("memory_get", error, logger);
      }
    },
  };
}
