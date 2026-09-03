/**
 * Shared fixture context for the MCP legacy (2025-11-25) wire parity golden.
 *
 * The context is registration-only: the golden captures the initialize
 * handshake and tools/list, neither of which touches the store, so the store
 * and job manager are inert stubs. Identity is pinned so the golden does not
 * drift with every package.json version bump.
 */

import type { Config } from "../../../src/config/types";
import type { ToolContext } from "../../../src/mcp/context";

import { createStandaloneResidentStatus } from "../../../src/serve/resident-status";

export const LEGACY_PARITY_PROTOCOL_VERSION = "2025-11-25";
export const LEGACY_PARITY_SERVER_IDENTITY = {
  name: "gno-legacy-parity",
  version: "0.0.0",
} as const;
export const LEGACY_PARITY_CLIENT_INFO = {
  name: "legacy-parity-client",
  version: "1.0.0",
} as const;
export const LEGACY_PARITY_ENABLE_WRITE_ENV = "GNO_LEGACY_PARITY_ENABLE_WRITE";

export function createLegacyParityToolContext(
  enableWrite: boolean
): ToolContext {
  const config: Config = {
    version: "1.0",
    ftsTokenizer: "unicode61" as const,
    collections: [],
    contexts: [],
  };
  return {
    store: {} as ToolContext["store"],
    config,
    collections: [],
    actualConfigPath: "/tmp/gno-legacy-parity/config.yml",
    indexName: "parity",
    toolMutex: { acquire: async () => () => undefined },
    jobManager: {} as ToolContext["jobManager"],
    serverInstanceId: "legacy-parity",
    writeLockPath: "/tmp/gno-legacy-parity/.lock",
    enableWrite,
    isShuttingDown: () => false,
    getResidentStatus: () => createStandaloneResidentStatus("stdio"),
  };
}

export function legacyInitializeRequest(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: LEGACY_PARITY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: LEGACY_PARITY_CLIENT_INFO,
    },
  };
}

export const LEGACY_INITIALIZED_NOTIFICATION = {
  jsonrpc: "2.0",
  method: "notifications/initialized",
} as const;

export function legacyToolsListRequest(id: number): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "tools/list", params: {} };
}
