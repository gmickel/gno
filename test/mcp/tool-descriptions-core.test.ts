/**
 * Core-profile description variants.
 *
 * `core` serves a micro-instruction for each of its nine tools; `full` keeps
 * the original strings byte-for-byte (pinned to the 2025-11-25 golden). The
 * set of tools whose description differs between the profiles must be exactly
 * the core set, and every core description must carry the when-to-call and
 * what-comes-back shape under the copy rules.
 */

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import { createMcpServerSurface } from "../../src/mcp/context";
import {
  MCP_CORE_TOOL_DESCRIPTIONS,
  MCP_CORE_TOOL_NAMES,
  profileToolDescription,
} from "../../src/mcp/tool-descriptions-core";
import { type McpToolProfile } from "../../src/mcp/tool-profile";
import {
  createLegacyParityToolContext,
  LEGACY_PARITY_SERVER_IDENTITY,
} from "../fixtures/mcp/legacy-parity-context";

const GOLDEN_PATH = join(
  dirname(import.meta.dir),
  "fixtures",
  "mcp",
  "legacy-2025-11-25.json"
);

interface ListedTool {
  name: string;
  description?: string;
}

interface LegacyGolden {
  stdio: Record<"read" | "write", { toolsList: string }>;
}

async function goldenDescriptions(): Promise<Map<string, string>> {
  const golden = (await Bun.file(GOLDEN_PATH).json()) as LegacyGolden;
  const parsed = JSON.parse(golden.stdio.write.toolsList) as {
    result: { tools: ListedTool[] };
  };
  return new Map(
    parsed.result.tools.map(({ name, description }) => [
      name,
      description ?? "",
    ])
  );
}

async function listDescriptions(
  toolProfile: McpToolProfile
): Promise<Map<string, string>> {
  const ctx = createLegacyParityToolContext(true);
  ctx.toolProfile = toolProfile;
  const server = createMcpServerSurface(ctx, LEGACY_PARITY_SERVER_IDENTITY);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "description-test", version: "1.0.0" });
  await client.connect(clientSide);
  try {
    const { tools } = await client.listTools();
    return new Map(tools.map((t) => [t.name, t.description ?? ""]));
  } finally {
    await client.close();
    await server.close();
  }
}

/** Negated framings the copy rules forbid, plus promotional vocabulary. */
const BANNED_COPY = [
  /\bnot (just|merely|only|simply)\b/i,
  /\bisn't\b|\bdoesn't\b|\bdon't\b/i,
  /\brather than\b|\binstead of\b/i,
  /\b(powerful|seamless|robust|comprehensive|cutting-edge|effortless)\b/i,
];

describe("core-profile description variants", () => {
  test("the variants table names exactly the core read and write tools", () => {
    expect(new Set(Object.keys(MCP_CORE_TOOL_DESCRIPTIONS))).toEqual(
      new Set(MCP_CORE_TOOL_NAMES)
    );
  });

  test("full serves the golden strings; core differs on exactly the core tools", async () => {
    const golden = await goldenDescriptions();
    const full = await listDescriptions("full");
    const core = await listDescriptions("core");

    expect(full).toEqual(golden);
    expect(new Set(core.keys())).toEqual(new Set(MCP_CORE_TOOL_NAMES));

    const changed = [...core]
      .filter(([name, description]) => description !== full.get(name))
      .map(([name]) => name);
    expect(new Set(changed)).toEqual(new Set(MCP_CORE_TOOL_NAMES));
    for (const [name, description] of core) {
      expect(description).toBe(MCP_CORE_TOOL_DESCRIPTIONS[name] ?? "");
    }
  });

  test("profileToolDescription passes the original through for full and for unlisted tools", () => {
    expect(profileToolDescription("full", "gno_query", "original")).toBe(
      "original"
    );
    expect(profileToolDescription("core", "gno_status", "original")).toBe(
      "original"
    );
    expect(profileToolDescription("core", "gno_query", "original")).toBe(
      MCP_CORE_TOOL_DESCRIPTIONS.gno_query ?? ""
    );
  });

  test.each([...MCP_CORE_TOOL_NAMES])(
    "%s reads as a when-to-call micro-instruction under the copy rules",
    (name) => {
      const description = MCP_CORE_TOOL_DESCRIPTIONS[name] ?? "";
      expect(description.startsWith("Call ")).toBe(true);
      expect(description).toMatch(/\breturns\b/i);
      for (const pattern of BANNED_COPY) {
        expect(description).not.toMatch(pattern);
      }
      expect(description.length).toBeLessThanOrEqual(900);
    }
  );
});
