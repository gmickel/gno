/**
 * Zero-dependency MCP tool profile types and parser.
 * Extracted from src/mcp/tool-profile so CLI startup and installers do not
 * pull in zod or LLM inference-scope modules just to parse profile flags.
 *
 * @module src/mcp/tool-profile-types
 */

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
