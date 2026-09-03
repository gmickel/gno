/**
 * Helpers shared by the MCP gno_recall / gno_remember tools: identity
 * mapping from the server session, service construction, error rethrow in
 * the shape runTool parses, and the common scopes input schema.
 *
 * The service owns the shared write lease; this module never touches
 * `ctx.writeLockPath` beyond naming the lease file for the service.
 *
 * @module src/mcp/tools/memory-shared
 */

import { z } from "zod";

import type { ToolContext } from "../server";

import {
  MemoryError,
  type MemoryIdentity,
  MemoryService,
} from "../../core/memory";
import { MEMORY_MAX_SCOPES } from "../../core/memory-record";

/** Caller name when the MCP client sent no implementation name. */
const DEFAULT_MCP_CALLER = "mcp";

/** Server-side identity inputs resolved at dispatch time by the registry. */
export interface McpMemorySessionInfo {
  /** `clientInfo.name` from the MCP initialize handshake. */
  clientName?: string;
  /** Transport session id (2025-era Streamable HTTP); absent on stdio and on the 2026-07-28 sessionless leg. */
  sessionId?: string;
  /** Opaque per-caller identity the HTTP boundary derived (`ctx.getRequestIdentity`); absent on stdio. */
  requestIdentity?: string;
}

export const memoryScopesInputSchema = z
  .array(z.string().trim().min(1))
  .min(1, "At least one explicit scope is required")
  .max(MEMORY_MAX_SCOPES)
  .describe(
    `Explicit scopes (1-${MEMORY_MAX_SCOPES}, e.g. "project:gno"). Visibility is any-intersection; there is no implicit global scope`
  );

/**
 * Map the MCP server session to the core identity contract.
 *
 * caller = MCP client implementation name; session = transport session id
 * when the transport has one (2025-era Streamable HTTP), else the per-caller
 * identity the HTTP boundary derived (2026-07-28 sessionless leg), else the
 * per-process server instance id (stdio: one process is one session).
 */
export function resolveMcpMemoryIdentity(
  ctx: ToolContext,
  info: McpMemorySessionInfo
): MemoryIdentity {
  const caller = info.clientName?.trim() || DEFAULT_MCP_CALLER;
  const session =
    info.sessionId?.trim() ||
    info.requestIdentity?.trim() ||
    ctx.serverInstanceId;
  return { caller, session };
}

/**
 * Construct the core service for one MCP call.
 *
 * The lease path names the same `.mcp-write.lock` file the rest of the MCP
 * write surface uses, so a memory write and a capture serialise on one lease.
 * Acquisition happens inside the service only.
 */
export function createMcpMemoryService(ctx: ToolContext): MemoryService {
  return new MemoryService({
    store: ctx.store,
    config: ctx.config,
    collections: ctx.collections,
    lockPath: ctx.writeLockPath,
  });
}

/** Re-throw a core memory error in the `CODE: message` shape runTool parses. */
export function rethrowMemoryError(error: unknown): never {
  if (error instanceof MemoryError) {
    throw new Error(`${error.code}: ${error.message}`);
  }
  throw error;
}
