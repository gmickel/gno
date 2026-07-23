import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "../../src/mcp/server";

import { registerTools } from "../../src/mcp/tools/index";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

describe("Context Capsule MCP transport contract", () => {
  let root: string;
  let store: SqliteAdapter;
  let server: McpServer;
  let client: Client;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-context-mcp-schema-"));
    store = new SqliteAdapter();
    expect((await store.open(join(root, "test.db"), "unicode61")).ok).toBe(
      true
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    server = new McpServer(
      { name: "context-schema-test", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );
    const context: ToolContext = {
      store,
      config: {
        version: "1.0",
        ftsTokenizer: "unicode61",
        collections: [],
        contexts: [],
      },
      collections: [],
      actualConfigPath: join(root, "config.yml"),
      indexName: "default",
      toolMutex: { acquire: async () => () => {} } as ToolContext["toolMutex"],
      jobManager: {} as ToolContext["jobManager"],
      serverInstanceId: "schema-test",
      writeLockPath: join(root, ".lock"),
      enableWrite: false,
      isShuttingDown: () => false,
    };
    registerTools(server, context);
    await server.connect(serverTransport);
    client = new Client({ name: "context-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    await store.close();
    await safeRm(root);
  });

  test("publishes a closed object schema", async () => {
    const tools = await client.listTools();
    const contextTool = tools.tools.find((tool) => tool.name === "gno_context");
    expect(contextTool?.inputSchema.type).toBe("object");
    expect(contextTool?.inputSchema.additionalProperties).toBe(false);
    expect(contextTool?.inputSchema.required).toContain("goal");
    expect(contextTool?.inputSchema.required).toContain("budgetTokens");
  });

  test("rejects unknown fields at MCP validation before the GNO handler", async () => {
    const result = await client.callTool({
      name: "gno_context",
      arguments: {
        goal: "find the owner",
        budgetTokens: 1000,
        injected: true,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ text?: string }>;
    const text = content[0]?.text;
    expect(text).toContain("Input validation error");
    expect(text).toContain("Unrecognized key");
    // SDK InvalidParams validation is surfaced as an MCP tool error. Because
    // the handler never runs, this is intentionally not a GNO error taxonomy.
    expect(result.structuredContent).toBeUndefined();
  });
});
