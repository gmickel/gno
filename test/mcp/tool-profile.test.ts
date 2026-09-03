/**
 * MCP tool profiles: live listings through a real MCP client over the
 * in-memory (stdio-equivalent) and Streamable HTTP transports.
 *
 * `full` is pinned to the 2025-11-25 golden (names and descriptions);
 * `core` is pinned to the exact documented read set and write allowlist.
 */

import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import type { HttpMcpTransportRuntime } from "../../src/mcp/http-transport";

import { createMcpServerSurface } from "../../src/mcp/context";
import { resolveHttpGatewayConfig } from "../../src/mcp/http-security";
import { HttpMcpTransport } from "../../src/mcp/http-transport";
import {
  MCP_CORE_READ_TOOL_NAMES,
  MCP_CORE_WRITE_TOOL_NAMES,
  type McpToolProfile,
  parseMcpToolProfile,
} from "../../src/mcp/tool-profile";
import { MCP_WRITE_TOOL_NAMES } from "../../src/mcp/tools/index";
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

/** Documented core read set, in registry (wire) order. */
const CORE_READ_LISTING = [
  "gno_context",
  "gno_recall",
  "gno_search",
  "gno_query",
  "gno_get",
  "gno_multi_get",
  "gno_changes",
];
/** Core write allowlist, in registry (wire) order. */
const CORE_WRITE_LISTING = ["gno_remember", "gno_capture"];

interface ListedTool {
  name: string;
  description?: string;
}

interface LegacyGolden {
  stdio: Record<"read" | "write", { toolsList: string }>;
}

function goldenListing(set: "read" | "write"): Promise<ListedTool[]> {
  return Bun.file(GOLDEN_PATH)
    .json()
    .then((golden: LegacyGolden) => {
      const parsed = JSON.parse(golden.stdio[set].toolsList) as {
        result: { tools: ListedTool[] };
      };
      return parsed.result.tools.map(({ name, description }) => ({
        name,
        description,
      }));
    });
}

function profileContext(
  enableWrite: boolean,
  toolProfile: McpToolProfile | undefined
) {
  const ctx = createLegacyParityToolContext(enableWrite);
  ctx.toolProfile = toolProfile;
  return ctx;
}

async function listOverInMemory(
  enableWrite: boolean,
  toolProfile: McpToolProfile | undefined
): Promise<ListedTool[]> {
  const server = createMcpServerSurface(
    profileContext(enableWrite, toolProfile),
    LEGACY_PARITY_SERVER_IDENTITY
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "profile-test", version: "1.0.0" });
  await client.connect(clientSide);
  try {
    const { tools } = await client.listTools();
    return tools.map(({ name, description }) => ({ name, description }));
  } finally {
    await client.close();
    await server.close();
  }
}

async function withHttpClient<T>(
  enableWrite: boolean,
  toolProfile: McpToolProfile,
  run: (client: Client) => Promise<T>
): Promise<T> {
  const runtime: HttpMcpTransportRuntime = {
    mcpContext: profileContext(enableWrite, toolProfile),
    isShuttingDown: false,
    admitRequest: () => ({
      id: crypto.randomUUID(),
      signal: new AbortController().signal,
      finish: () => undefined,
    }),
    openSession: () => () => undefined,
  };
  const transport = new HttpMcpTransport(runtime, { enableWrite });
  const client = new Client({ name: "profile-http", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3210/mcp"), {
      fetch: (input, init) => transport.handleRequest(new Request(input, init)),
    })
  );
  try {
    return await run(client);
  } finally {
    await client.close();
    await transport.close();
  }
}

describe("MCP tool profiles (live listing)", () => {
  test("core advertises exactly the documented read set", async () => {
    const names = (await listOverInMemory(false, "core")).map((t) => t.name);
    expect(names).toEqual(CORE_READ_LISTING);
    expect(new Set(names)).toEqual(new Set(MCP_CORE_READ_TOOL_NAMES));
  });

  test("core with --enable-write adds exactly the write allowlist", async () => {
    const names = (await listOverInMemory(true, "core")).map((t) => t.name);
    expect(names).toEqual([...CORE_READ_LISTING, ...CORE_WRITE_LISTING]);
    expect(new Set(CORE_WRITE_LISTING)).toEqual(
      new Set(MCP_CORE_WRITE_TOOL_NAMES)
    );
  });

  test("core write allowlist is a subset of the write gate and excludes gno_job_status", () => {
    for (const name of MCP_CORE_WRITE_TOOL_NAMES) {
      expect(MCP_WRITE_TOOL_NAMES.has(name)).toBe(true);
    }
    expect(MCP_CORE_WRITE_TOOL_NAMES.has("gno_job_status")).toBe(false);
    expect(MCP_CORE_READ_TOOL_NAMES.has("gno_job_status")).toBe(false);
  });

  test("full matches the pre-change golden and the unprofiled default, descriptions included", async () => {
    for (const enableWrite of [false, true]) {
      const explicitFull = await listOverInMemory(enableWrite, "full");
      const unprofiled = await listOverInMemory(enableWrite, undefined);
      const golden = await goldenListing(enableWrite ? "write" : "read");
      expect(explicitFull).toEqual(unprofiled);
      expect(explicitFull).toEqual(golden);
    }
  });

  test("write tools never appear without --enable-write in either profile", async () => {
    for (const profile of ["core", "full"] as const) {
      const names = (await listOverInMemory(false, profile)).map((t) => t.name);
      expect(names.filter((n) => MCP_WRITE_TOOL_NAMES.has(n))).toEqual([]);
    }
  });

  test("resident HTTP gateway honors the profile for its clients", async () => {
    const readNames = await withHttpClient(false, "core", async (client) =>
      (await client.listTools()).tools.map((t) => t.name)
    );
    expect(readNames).toEqual(CORE_READ_LISTING);

    const writeNames = await withHttpClient(true, "core", async (client) =>
      (await client.listTools()).tools.map((t) => t.name)
    );
    expect(writeNames).toEqual([...CORE_READ_LISTING, ...CORE_WRITE_LISTING]);
  });

  test("tools outside the core profile are unknown, not merely hidden", async () => {
    const server = createMcpServerSurface(
      profileContext(true, "core"),
      LEGACY_PARITY_SERVER_IDENTITY
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "profile-call", version: "1.0.0" });
    await client.connect(clientSide);
    try {
      for (const name of ["gno_status", "gno_sync"]) {
        const rejection = await client.callTool({ name, arguments: {} }).then(
          () => undefined,
          (error: unknown) => error
        );
        expect(rejection).toBeInstanceOf(Error);
        expect((rejection as { code?: unknown }).code).toBe(-32_602);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("MCP tool profile selection", () => {
  test("gateway precedence: CLI override > gateway.toolProfile > default full", () => {
    expect(resolveHttpGatewayConfig(undefined).toolProfile).toBe("full");
    expect(resolveHttpGatewayConfig({ toolProfile: "core" }).toolProfile).toBe(
      "core"
    );
    expect(
      resolveHttpGatewayConfig({ toolProfile: "core" }, { toolProfile: "full" })
        .toolProfile
    ).toBe("full");
    expect(
      resolveHttpGatewayConfig({}, { toolProfile: "core" }).toolProfile
    ).toBe("core");
  });

  test("parseMcpToolProfile accepts core/full and rejects anything else", () => {
    expect(parseMcpToolProfile(undefined)).toBeUndefined();
    expect(parseMcpToolProfile("core")).toBe("core");
    expect(parseMcpToolProfile("full")).toBe("full");
    expect(() => parseMcpToolProfile("slim")).toThrow(
      'Invalid tool profile: "slim". Must be one of: core, full.'
    );
    expect(() => parseMcpToolProfile("CORE")).toThrow(/Invalid tool profile/);
  });
});
