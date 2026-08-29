/**
 * MCP gno_peek tool tests.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type { Config } from "../../../src/config/types";
import type { ToolContext } from "../../../src/mcp/server";

import { getConfigPath, VERSION } from "../../../src/app/constants";
import { runCli } from "../../../src/cli/run";
import { createMcpServerSurface } from "../../../src/mcp/context";
import { MCP_HTTP_EGRESS_TOOLS } from "../../../src/mcp/http-egress";
import {
  MCP_TOOL_DESCRIPTIONS,
  MCP_WRITE_TOOL_NAMES,
} from "../../../src/mcp/tools/index";
import { handlePeek, PEEK_MCP_ANNOTATIONS } from "../../../src/mcp/tools/peek";
import { safeRm } from "../../helpers/cleanup";
import { createMockContext } from "../../serve/helpers/activation-status-fixtures";
import { assertValid, loadSchema } from "../../spec/schemas/validator";

const peekInputSchema = z.object({});

function asToolContext(
  overrides: Partial<ToolContext> & { actualConfigPath: string }
): ToolContext {
  const serverContext = createMockContext();
  const store = {
    getStatus: async () => {
      throw new Error("gno_peek must not call store.getStatus");
    },
    listDocumentsPaginated: async () => {
      throw new Error("gno_peek must not call store.listDocumentsPaginated");
    },
  };
  return {
    ...serverContext,
    collections: serverContext.config.collections,
    toolMutex: { acquire: async () => () => undefined },
    jobManager: {} as ToolContext["jobManager"],
    serverInstanceId: "peek-test",
    writeLockPath: "/tmp/.lock",
    enableWrite: false,
    isShuttingDown: () => false,
    store: store as unknown as ToolContext["store"],
    ...overrides,
  } as ToolContext;
}

function withoutGeneratedAt(
  snapshot: Record<string, unknown>
): Record<string, unknown> {
  const { generatedAt: _generatedAt, ...rest } = snapshot;
  return rest;
}

function setOptionalEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }
  process.env[name] = value;
}

describe("gno_peek schema and registration", () => {
  test("peek input schema accepts empty object", () => {
    expect(peekInputSchema.safeParse({}).success).toBe(true);
  });

  test("is read-only metadata and not a write tool", () => {
    expect(MCP_WRITE_TOOL_NAMES.has("gno_peek")).toBe(false);
    expect(MCP_HTTP_EGRESS_TOOLS.gno_peek).toBe("metadata");
    expect(PEEK_MCP_ANNOTATIONS).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(MCP_TOOL_DESCRIPTIONS.peek).toContain("peek@1.0");
    expect(MCP_TOOL_DESCRIPTIONS.peek).toContain("gno_status");
  });

  test("handler source never touches model or activation APIs", async () => {
    const source = await Bun.file("src/mcp/tools/peek.ts").text();
    expect(source).not.toContain("ModelCache");
    expect(source).not.toContain("resolveModelUri");
    expect(source).not.toContain("buildActivationStatus");
    expect(source).not.toContain("initStore");
    expect(source).not.toContain("ctx.store");
    expect(source).toContain("buildPeekSnapshot");
  });
});

describe("gno_peek handler", () => {
  test("uninitialized without a store is success, not gno_status throw", async () => {
    const ctx = asToolContext({
      actualConfigPath: join(
        tmpdir(),
        `gno-peek-missing-${crypto.randomUUID()}.yml`
      ),
      indexName: "default",
    });
    const result = await handlePeek({}, ctx);
    expect(result.isError).not.toBe(true);
    const payload = result.structuredContent as Record<string, unknown>;
    expect(payload).toMatchObject({
      schemaVersion: "peek@1.0",
      gnoVersion: VERSION,
      initialized: false,
      indexName: "default",
      counts: null,
      backlog: null,
      lastIndexedAt: null,
      recent: [],
    });
    expect(assertValid(payload, await loadSchema("peek"))).toBe(true);
  });

  test("handler never calls embed, store, or activation APIs", async () => {
    let storeCalled = false;
    const ctx = asToolContext({
      actualConfigPath: join(
        tmpdir(),
        `gno-peek-missing-${crypto.randomUUID()}.yml`
      ),
      indexName: "default",
      store: {
        getStatus: async () => {
          storeCalled = true;
          throw new Error("store.getStatus");
        },
      } as unknown as ToolContext["store"],
    });
    const result = await handlePeek({}, ctx);
    expect(result.isError).not.toBe(true);
    expect(storeCalled).toBe(false);
  });
});

describe("gno_peek against a real store", () => {
  let root: string;
  let notes: string;
  let previousEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-mcp-peek-"));
    notes = join(root, "notes");
    await mkdir(notes, { recursive: true });
    previousEnv = {
      GNO_CONFIG_DIR: process.env.GNO_CONFIG_DIR,
      GNO_DATA_DIR: process.env.GNO_DATA_DIR,
      GNO_CACHE_DIR: process.env.GNO_CACHE_DIR,
    };
    process.env.GNO_CONFIG_DIR = join(root, "config");
    process.env.GNO_DATA_DIR = join(root, "data");
    process.env.GNO_CACHE_DIR = join(root, "cache");
  });

  afterEach(async () => {
    setOptionalEnv("GNO_CONFIG_DIR", previousEnv.GNO_CONFIG_DIR);
    setOptionalEnv("GNO_DATA_DIR", previousEnv.GNO_DATA_DIR);
    setOptionalEnv("GNO_CACHE_DIR", previousEnv.GNO_CACHE_DIR);
    await safeRm(root);
  });

  test("initialized snapshot matches gno peek --json and peek schema", async () => {
    await Bun.write(join(notes, "inbox.md"), "# Inbox\n\nhello\n");
    expect(await runCli(["bun", "gno", "init", notes, "--name", "notes"])).toBe(
      0
    );
    expect(await runCli(["bun", "gno", "index", "--no-embed"])).toBe(0);

    let stdoutData = "";
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      stdoutData += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };
    let cliCode: number;
    try {
      cliCode = await runCli(["bun", "gno", "peek", "--json"]);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(cliCode).toBe(0);
    const cliPayload = JSON.parse(stdoutData) as Record<string, unknown>;

    const ctx = asToolContext({
      actualConfigPath: getConfigPath(),
      indexName: "default",
    });
    const result = await handlePeek({}, ctx);
    expect(result.isError).not.toBe(true);
    const mcpPayload = result.structuredContent as Record<string, unknown>;
    expect(assertValid(mcpPayload, await loadSchema("peek"))).toBe(true);
    expect(withoutGeneratedAt(mcpPayload)).toEqual(
      withoutGeneratedAt(cliPayload)
    );
  });

  test("live MCP gno_peek is registered, annotated, and matches CLI", async () => {
    await Bun.write(join(notes, "inbox.md"), "# Inbox\n\nhello\n");
    expect(await runCli(["bun", "gno", "init", notes, "--name", "notes"])).toBe(
      0
    );
    expect(await runCli(["bun", "gno", "index", "--no-embed"])).toBe(0);

    const context = asToolContext({
      actualConfigPath: getConfigPath(),
      indexName: "default",
      config: {
        version: "1.0",
        ftsTokenizer: "unicode61",
        collections: [
          {
            name: "notes",
            path: notes,
            pattern: "**/*.md",
            include: [],
            exclude: [],
          },
        ],
        contexts: [],
      } satisfies Config,
    });

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createMcpServerSurface(context, {
      name: "peek-live",
      version: "1.0.0",
    });
    await server.connect(serverSide);
    const client = new Client({ name: "peek-live-client", version: "1.0.0" });
    await client.connect(clientSide);

    try {
      const listed = await client.listTools();
      const peekTool = listed.tools.find((tool) => tool.name === "gno_peek");
      expect(peekTool).toBeDefined();
      expect(peekTool?.annotations).toEqual(PEEK_MCP_ANNOTATIONS);
      expect(listed.tools.some((tool) => tool.name === "gno_status")).toBe(
        true
      );

      const mcpResult = await client.callTool({
        name: "gno_peek",
        arguments: {},
      });
      expect(mcpResult.isError).not.toBe(true);
      const mcpPayload = mcpResult.structuredContent as Record<string, unknown>;
      expect(assertValid(mcpPayload, await loadSchema("peek"))).toBe(true);

      let stdoutData = "";
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk: string | Uint8Array): boolean => {
        stdoutData += typeof chunk === "string" ? chunk : chunk.toString();
        return true;
      };
      try {
        expect(await runCli(["bun", "gno", "peek", "--json"])).toBe(0);
      } finally {
        process.stdout.write = originalWrite;
      }
      const cliPayload = JSON.parse(stdoutData) as Record<string, unknown>;
      expect(withoutGeneratedAt(mcpPayload)).toEqual(
        withoutGeneratedAt(cliPayload)
      );
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
