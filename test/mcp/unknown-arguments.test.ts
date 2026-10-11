/**
 * Every MCP tool rejects argument keys its schema does not declare, naming
 * the key, so a misspelled write fence or scope never runs as if absent.
 */

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, expect, test } from "bun:test";

import { createMcpServerSurface } from "../../src/mcp/context";
import {
  createLegacyParityToolContext,
  LEGACY_PARITY_SERVER_IDENTITY,
} from "../fixtures/mcp/legacy-parity-context";

let client: Client;
let close: () => Promise<void>;

beforeAll(async () => {
  const server = createMcpServerSurface(
    createLegacyParityToolContext(true),
    LEGACY_PARITY_SERVER_IDENTITY
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "unknown-arguments", version: "1.0.0" });
  await client.connect(clientSide);
  close = async () => {
    await client.close();
    await server.close();
  };
});

afterAll(() => close());

test("every advertised tool declares that extra keys are refused", async () => {
  const { tools } = await client.listTools();
  expect(tools.length).toBeGreaterThan(30);
  const closed = (schema: Record<string, unknown>): boolean =>
    schema.additionalProperties === false ||
    (Array.isArray(schema.oneOf) &&
      (schema.oneOf as Record<string, unknown>[]).every(closed));
  const open = tools
    .filter((tool) => !closed(tool.inputSchema as Record<string, unknown>))
    .map((tool) => tool.name);
  expect(open).toEqual([]);
});

test.each([
  [
    "gno_remember",
    {
      text: "The deploy window is Friday",
      scopes: ["project:x"],
      derived_from: "gno://memory/a.md",
    },
    "derived_from",
  ],
  ["gno_search", { query: "deploy", colection: "notes" }, "colection"],
  [
    "gno_rename_note",
    { action: "preview", ref: "notes/a.md", name: "b", dryRun: true },
    "dryRun",
  ],
])("%s names the unknown key and runs nothing", async (name, args, key) => {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text?: string }[];
  };
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain(key);
});

test("declared aliases still validate", async () => {
  // edgeType and relation are both declared; the handler, not the schema,
  // reports their mismatch, so both keys passed validation.
  const result = (await client.callTool({
    name: "gno_graph_query",
    arguments: { ref: "notes/a.md", edgeType: "mentions", relation: "cites" },
  })) as { content: { text?: string }[] };
  const text = result.content[0]?.text ?? "";
  expect(text).not.toContain("Unrecognized key");
  expect(text).toContain("aliases and must match");
});
