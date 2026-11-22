import type {
  Icon,
  McpServer,
  StandardSchemaWithJSON,
  ToolAnnotations,
  ToolCallback,
  ServerContext,
} from "@modelcontextprotocol/server";
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

import { z } from "zod";

import { withInferenceScope } from "../llm/inference-scope";
import {
  DEFAULT_MCP_TOOL_PROFILE,
  isMcpToolProfile,
  MCP_CORE_READ_TOOL_NAMES,
  MCP_CORE_WRITE_TOOL_NAMES,
  MCP_TOOL_PROFILES,
  type McpToolProfile,
  mcpToolProfileAllowlist,
  parseMcpToolProfile,
} from "./tool-profile-types";

export {
  DEFAULT_MCP_TOOL_PROFILE,
  isMcpToolProfile,
  MCP_CORE_READ_TOOL_NAMES,
  MCP_CORE_WRITE_TOOL_NAMES,
  MCP_TOOL_PROFILES,
  type McpToolProfile,
  mcpToolProfileAllowlist,
  parseMcpToolProfile,
};

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
  const connection = new AbortController();
  const previousClose = server.server.onclose;
  server.server.onclose = () => {
    connection.abort();
    previousClose?.();
  };
  return (name, config, cb) => {
    if (allowlist !== null && !allowlist.has(name)) return;
    // The SDK callback is conditional on schema presence: the last argument
    // is always ServerContext, while a schema-bearing call also has input.
    const wrapped = (...args: unknown[]) => {
      const request = args.at(-1) as ServerContext;
      return withInferenceScope(
        {
          signal: AbortSignal.any([connection.signal, request.mcpReq.signal]),
        },
        async () =>
          args.length === 1
            ? (cb as ToolCallback<undefined>)(request)
            : (cb as ToolCallback<StandardSchemaWithJSON>)(args[0], request)
      );
    };
    server.registerTool(
      name,
      { ...config, inputSchema: rejectUnknownKeys(config.inputSchema) },
      wrapped as unknown as typeof cb
    );
  };
}

const strictSchemaCache = new WeakMap<z.ZodObject, z.ZodObject>();

/**
 * Unknown argument keys fail validation with the key named instead of being
 * dropped: a misspelled scope or receipt key must not silently widen a read
 * or skip a write fence.
 */
export function rejectUnknownKeys<T>(schema: T): T {
  if (!(schema instanceof z.ZodObject)) {
    return schema;
  }
  let strict = strictSchemaCache.get(schema);
  if (!strict) {
    strict = schema.strict();
    strictSchemaCache.set(schema, strict);
  }
  return strict as unknown as T;
}
