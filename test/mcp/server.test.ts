/**
 * MCP Server tests.
 * Validates server lifecycle and basic protocol compliance.
 */

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { MCP_SERVER_NAME, VERSION } from "../../src/app/constants";

describe("MCP Server", () => {
  let server: McpServer;
  let client: Client;
  let serverTransport: ReturnType<typeof InMemoryTransport.createLinkedPair>[1];
  let clientTransport: ReturnType<typeof InMemoryTransport.createLinkedPair>[0];

  beforeAll(async () => {
    // Create linked transport pair
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    // Create minimal server (no store, just protocol test)
    server = new McpServer(
      {
        name: MCP_SERVER_NAME,
        version: VERSION,
      },
      {
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
      }
    );

    // Register a test tool using zod schema
    const { z } = await import("zod");
    server.registerTool(
      "test.echo",
      {
        description: "Echo test",
        inputSchema: z.object({ message: z.string() }),
      },
      (args) => ({
        content: [{ type: "text", text: `Echo: ${args.message}` }],
      })
    );

    await server.connect(serverTransport);

    // Create client
    client = new Client({
      name: "test-client",
      version: "1.0.0",
    });

    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  test("server info returns correct name and version", () => {
    const info = client.getServerVersion();
    expect(info?.name).toBe(MCP_SERVER_NAME);
    expect(info?.version).toBe(VERSION);
  });

  test("tools/list returns registered tools", async () => {
    const result = await client.listTools();
    expect(result.tools.length).toBeGreaterThan(0);

    const toolNames = result.tools.map((t) => t.name);
    expect(toolNames).toContain("test.echo");
  });

  test("tools/call executes tool and returns result", async () => {
    const result = await client.callTool({
      name: "test.echo",
      arguments: { message: "hello world" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({
      type: "text",
      text: "Echo: hello world",
    });
  });

  test("tools/call with unknown tool rejects with InvalidParams", async () => {
    // SDK v2 answers an unknown tool with a JSON-RPC -32602 error instead of
    // a CallToolResult carrying isError (v1 behavior).
    const rejection = await client
      .callTool({ name: "nonexistent.tool", arguments: {} })
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as { code?: unknown }).code).toBe(-32_602);
  });
});
