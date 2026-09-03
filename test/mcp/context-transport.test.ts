import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "../../src/mcp/server";

import { createMcpServerSurface } from "../../src/mcp/context";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

describe("Context Capsule MCP transport contract", () => {
  let root: string;
  let store: SqliteAdapter;
  let server: ReturnType<typeof createMcpServerSurface>;
  let client: Client;
  let context: ToolContext;
  let invalidations: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-context-mcp-schema-"));
    store = new SqliteAdapter();
    expect((await store.open(join(root, "test.db"), "unicode61")).ok).toBe(
      true
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    invalidations = 0;
    context = {
      store,
      config: {
        version: "1.0",
        ftsTokenizer: "unicode61",
        collections: [
          {
            name: "docs",
            path: join(root, "docs"),
            pattern: "**/*.md",
            include: [],
            exclude: [],
          },
        ],
        contexts: [],
      },
      collections: [
        {
          name: "docs",
          path: join(root, "docs"),
          pattern: "**/*.md",
          include: [],
          exclude: [],
        },
      ],
      actualConfigPath: join(root, "config.yml"),
      indexName: "test.db",
      toolMutex: { acquire: async () => () => {} } as ToolContext["toolMutex"],
      jobManager: {} as ToolContext["jobManager"],
      serverInstanceId: "schema-test",
      writeLockPath: join(root, ".lock"),
      enableWrite: true,
      isShuttingDown: () => false,
      invalidateEgressPolicy: async () => {
        invalidations += 1;
        return {
          policyEpoch: `egress-epoch-v1:${"a".repeat(64)}`,
          queuedJobsInvalidated: 0,
          sessionsInvalidated: 0,
          staleWorkMustRetry: true,
        };
      },
    };
    server = createMcpServerSurface(context, {
      name: "context-schema-test",
      version: "1.0.0",
    });
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

  test("shared surface preserves stdio tool and resource results", async () => {
    const status = await client.callTool({
      name: "gno_status",
      arguments: {},
    });
    expect(status.isError).not.toBe(true);
    expect(status.structuredContent).toMatchObject({
      indexName: "test.db",
    });

    const resources = await client.listResources();
    expect(resources.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: "gno://tags", name: "tags" }),
      ])
    );
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

  test("rejects unknown fields for every egress tool before reads or mutations", async () => {
    const invalidCalls = [
      {
        name: "gno_egress_policy_get",
        arguments: { collection: "docs", extra: true },
      },
      {
        name: "gno_egress_check",
        arguments: {
          action: "export",
          destinationZone: "remote",
          caller: { authenticated: true, operationAuthorized: true },
          collections: ["docs"],
          contentClass: "retrieval_trace",
          extra: true,
        },
      },
      {
        name: "gno_egress_audit_list",
        arguments: { extra: true },
      },
      {
        name: "gno_egress_audit_show",
        arguments: { auditId: "audit-opaque", extra: true },
      },
      {
        name: "gno_egress_audit_status",
        arguments: { extra: true },
      },
      {
        name: "gno_egress_policy_set",
        arguments: { collection: "docs", policy: "local_only", extra: true },
      },
      {
        name: "gno_egress_audit_delete",
        arguments: { auditId: "audit-opaque", extra: true },
      },
      {
        name: "gno_egress_audit_purge",
        arguments: { confirm: true, extra: true },
      },
    ] as const;

    for (const request of invalidCalls) {
      const result = await client.callTool(request);
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text?: string }>)[0]?.text).toContain(
        "Input validation error"
      );
      expect(result.structuredContent).toBeUndefined();
    }

    expect(context.config.collections[0]?.egressPolicy).toBeUndefined();
    expect(invalidations).toBe(0);
    const status = await client.callTool({
      name: "gno_egress_audit_status",
      arguments: {},
    });
    expect(status.isError).not.toBe(true);
    expect(status.structuredContent).toMatchObject({ receipts: 0 });

    const unrelated = await client.callTool({
      name: "gno_status",
      arguments: {},
    });
    expect(unrelated.isError).not.toBe(true);
  });
});
