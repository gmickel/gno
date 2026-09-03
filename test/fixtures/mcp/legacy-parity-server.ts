/**
 * Stdio server subprocess for the MCP legacy wire parity golden.
 *
 * Spawned by test/mcp/legacy-parity.test.ts; serves the real GNO tool and
 * resource surface over a real stdio transport so the captured bytes are the
 * ones a 2025-11-25 stdio client would see.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMcpServerSurface } from "../../../src/mcp/context";
import {
  createLegacyParityToolContext,
  LEGACY_PARITY_ENABLE_WRITE_ENV,
  LEGACY_PARITY_SERVER_IDENTITY,
} from "./legacy-parity-context";

const enableWrite = process.env[LEGACY_PARITY_ENABLE_WRITE_ENV] === "1";
const server = createMcpServerSurface(
  createLegacyParityToolContext(enableWrite),
  LEGACY_PARITY_SERVER_IDENTITY
);
await server.connect(new StdioServerTransport());
await new Promise<void>((resolve) => {
  process.stdin.once("end", resolve);
  process.stdin.once("close", resolve);
});
await server.close();
