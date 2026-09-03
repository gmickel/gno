/**
 * MCP tool profiles.
 *
 * A profile decides which tools a server advertises. `full` is today's whole
 * registry; `core` is the small read set the retrieval playbook already steers
 * agents to, plus an exact write allowlist behind `--enable-write`. The write
 * gate is orthogonal: a profile only ever narrows the set the gate exposes.
 *
 * @module src/mcp/tool-profile
 */

import type {
  Icon,
  McpServer,
  StandardSchemaWithJSON,
  ToolAnnotations,
  ToolCallback,
} from "@modelcontextprotocol/server";

export const MCP_TOOL_PROFILES = ["core", "full"] as const;

export type McpToolProfile = (typeof MCP_TOOL_PROFILES)[number];

export const DEFAULT_MCP_TOOL_PROFILE: McpToolProfile = "full";

/** Read tools the core profile advertises without `--enable-write`. */
export const MCP_CORE_READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  "gno_query",
  "gno_search",
  "gno_get",
  "gno_multi_get",
  "gno_context",
  "gno_changes",
  "gno_recall",
]);

/**
 * Write tools the core profile adds with `--enable-write`.
 *
 * `gno_job_status` is deliberately absent: `gno_capture` and `gno_remember`
 * complete synchronously (neither starts a JobManager job), so nothing the
 * core profile exposes ever returns a job ID to poll.
 */
export const MCP_CORE_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "gno_capture",
  "gno_remember",
]);

export function isMcpToolProfile(value: unknown): value is McpToolProfile {
  return (
    typeof value === "string" &&
    (MCP_TOOL_PROFILES as readonly string[]).includes(value)
  );
}

/** Parse a CLI/config value; `undefined` means "not given" (caller applies precedence). */
export function parseMcpToolProfile(
  value: unknown
): McpToolProfile | undefined {
  if (value === undefined) return undefined;
  if (isMcpToolProfile(value)) return value;
  throw new Error(
    `Invalid tool profile: ${JSON.stringify(value)}. Must be one of: ${MCP_TOOL_PROFILES.join(", ")}.`
  );
}

/** Tool names a profile advertises; `null` means every registered tool. */
export function mcpToolProfileAllowlist(
  profile: McpToolProfile
): ReadonlySet<string> | null {
  if (profile === "full") return null;
  return new Set([...MCP_CORE_READ_TOOL_NAMES, ...MCP_CORE_WRITE_TOOL_NAMES]);
}

/**
 * Registration through a profile. Mirrors `McpServer.registerTool`'s
 * schema-object overload minus the return value: a tool outside the profile
 * is never registered, so there is no `RegisteredTool` to hand back, and
 * `registerTools` never reads one.
 */
export type ProfileToolRegistrar = <
  OutputArgs extends StandardSchemaWithJSON,
  InputArgs extends StandardSchemaWithJSON | undefined = undefined,
>(
  name: string,
  config: {
    title?: string;
    description?: string;
    inputSchema?: InputArgs;
    outputSchema?: OutputArgs;
    annotations?: ToolAnnotations;
    icons?: Icon[];
    _meta?: Record<string, unknown>;
  },
  cb: ToolCallback<InputArgs>
) => void;

/**
 * Wrap `server.registerTool` so tools outside the profile are never
 * registered. `full` forwards every call unchanged, so registration order
 * and wire bytes stay identical to an unprofiled server.
 */
export function createProfileToolRegistrar(
  server: McpServer,
  profile: McpToolProfile
): ProfileToolRegistrar {
  const allowlist = mcpToolProfileAllowlist(profile);
  return (name, config, cb) => {
    if (allowlist !== null && !allowlist.has(name)) return;
    server.registerTool(name, config, cb);
  };
}
