import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, test } from "bun:test";

import { createMcpServerSurface } from "../../src/mcp/context";
import {
  createLegacyParityToolContext,
  LEGACY_PARITY_SERVER_IDENTITY,
} from "../fixtures/mcp/legacy-parity-context";

test("MCP advertises typed filters and rejects invalid predicates before retrieval", async () => {
  const server = createMcpServerSurface(
    createLegacyParityToolContext(false),
    LEGACY_PARITY_SERVER_IDENTITY
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "metadata-filter-test", version: "1.0.0" });
  await client.connect(clientSide);
  try {
    const { tools } = await client.listTools();
    for (const name of [
      "gno_search",
      "gno_vsearch",
      "gno_query",
      "gno_query_diagnose",
      "gno_ask",
      "gno_context",
    ]) {
      const tool = tools.find((entry) => entry.name === name);
      expect(tool).toBeDefined();
      const schema = tool?.inputSchema;
      expect(schema?.properties).toHaveProperty("filter");
      expect(JSON.stringify(schema?.properties?.filter)).toContain(
        "Incomplete coverage is not proof of absence"
      );
      expect(JSON.stringify(schema?.properties?.filter)).toContain(
        "Keep requested filters unchanged"
      );
      expect(JSON.stringify(schema?.properties?.filter)).toContain(
        "If an expected target is known"
      );
      expect(JSON.stringify(schema)).toContain('"gte"');
      expect(JSON.stringify(schema).length).toBeLessThan(100_000);
    }
    for (const name of ["gno_search", "gno_vsearch", "gno_query", "gno_ask"]) {
      const result = await client.callTool({
        name,
        arguments: {
          query: "needle",
          filter: { op: "gte", key: "confidence", value: "0.8" },
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("filter");
    }
  } finally {
    await client.close();
    await server.close();
  }
});
