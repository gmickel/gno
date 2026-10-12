/**
 * Scoped tool profile and the per-request tool gate for non-admin gateway
 * principals.
 */

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, test } from "bun:test";

import type { RequestPrincipal } from "../../src/mcp/context";

import { createMcpServerSurface } from "../../src/mcp/context";
import {
  MCP_SCOPED_TOOL_NAMES,
  type McpToolProfile,
  parseMcpToolProfile,
} from "../../src/mcp/tool-profile";
import {
  createLegacyParityToolContext,
  LEGACY_PARITY_SERVER_IDENTITY,
} from "../fixtures/mcp/legacy-parity-context";

const NOT_FOUND = {
  isError: true,
  content: [{ type: "text", text: "Error: NOT_FOUND: Not found" }],
  structuredContent: { error: "NOT_FOUND", message: "Not found" },
};

async function withClient<T>(
  profile: McpToolProfile,
  principal: () => RequestPrincipal | undefined,
  run: (client: Client) => Promise<T>
): Promise<T> {
  const ctx = createLegacyParityToolContext(true);
  ctx.toolProfile = profile;
  ctx.getRequestPrincipal = principal;
  const server = createMcpServerSurface(ctx, LEGACY_PARITY_SERVER_IDENTITY);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "scoped-profile", version: "1.0.0" });
  await client.connect(clientSide);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const member: RequestPrincipal = {
  name: "assistant",
  admin: false,
  mayAssertSubject: true,
};
const admin: RequestPrincipal = { ...member, name: "sweep", admin: true };

describe("scoped tool profile", () => {
  test("advertises exactly the scoped set, without gno_changes", async () => {
    expect(parseMcpToolProfile("scoped")).toBe("scoped");
    const names = await withClient(
      "scoped",
      () => undefined,
      async (client) =>
        (await client.listTools()).tools.map((tool) => tool.name)
    );
    expect(new Set(names)).toEqual(new Set(MCP_SCOPED_TOOL_NAMES));
    expect(names).not.toContain("gno_changes");
  });

  test("a non-admin principal gets NOT_FOUND from metadata tools in any profile", async () => {
    // gno_list_metadata aggregates keys across every collection, so it stays
    // outside the scoped set.
    const names = [
      "gno_changes",
      "gno_status",
      "gno_list_tags",
      "gno_list_metadata",
    ];
    const refused = new Set<string>();
    for (const profile of ["core", "full"] as const) {
      await withClient(
        profile,
        () => member,
        async (client) => {
          for (const name of names) {
            const listed = (await client.listTools()).tools.some(
              (tool) => tool.name === name
            );
            if (!listed) continue;
            const result = await client.callTool({ name, arguments: {} });
            expect(result as unknown).toEqual(NOT_FOUND);
            refused.add(name);
          }
        }
      );
    }
    expect([...refused].sort()).toEqual([...names].sort());
  });

  test("an admin principal and an unnamed caller are not refused", async () => {
    for (const principal of [admin, undefined]) {
      await withClient(
        "core",
        () => principal,
        async (client) => {
          const result = await client.callTool({
            name: "gno_changes",
            arguments: {},
          });
          expect(result as unknown).not.toEqual(NOT_FOUND);
        }
      );
    }
  });
});
