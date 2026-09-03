/**
 * Stdio server subprocess for the MCP wire tests.
 *
 * Spawned by test/mcp/legacy-parity.test.ts and test/mcp/protocol-2026.test.ts;
 * serves the real GNO tool and resource surface through the production
 * dual-era stdio entry (`serveMcpStdio`, the same one `gno mcp` uses) so the
 * captured bytes are the ones a 2025-11-25 or 2026-07-28 stdio client sees.
 */

import { serveMcpStdio } from "../../../src/mcp/stdio-serving";
import {
  createLegacyParityToolContext,
  LEGACY_PARITY_ENABLE_WRITE_ENV,
  LEGACY_PARITY_SERVER_IDENTITY,
} from "./legacy-parity-context";

const enableWrite = process.env[LEGACY_PARITY_ENABLE_WRITE_ENV] === "1";
const handle = serveMcpStdio(
  createLegacyParityToolContext(enableWrite),
  LEGACY_PARITY_SERVER_IDENTITY
);
await new Promise<void>((resolve) => {
  process.stdin.once("end", resolve);
  process.stdin.once("close", resolve);
});
await handle.close();
