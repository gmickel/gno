/**
 * MCP gno_status tool tests.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import type { ToolContext } from "../../../src/mcp/server";

import { handleStatus } from "../../../src/mcp/tools/status";
import { createMockContext } from "../../serve/helpers/activation-status-fixtures";

// Test the status input/output schemas match spec
describe("gno_status schema", () => {
  test("projects effective boost rules without path prefixes", async () => {
    const serverContext = createMockContext();
    serverContext.config.contentTypes = [
      {
        id: "decision",
        preset: "decision-note",
        prefixes: ["private/decisions/"],
        searchBoost: 1.25,
      },
    ];
    const ctx = {
      ...serverContext,
      collections: serverContext.config.collections,
      actualConfigPath: "/tmp/config.yml",
      toolMutex: { acquire: async () => () => undefined },
      jobManager: {},
      serverInstanceId: "status-test",
      writeLockPath: "/tmp/.lock",
      enableWrite: false,
      isShuttingDown: () => false,
    } as unknown as ToolContext;

    const result = await handleStatus({}, ctx);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.contentTypeBoost).toEqual({
      rulesFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      rules: [{ id: "decision", searchBoost: 1.25 }],
    });
    expect(
      JSON.stringify(result.structuredContent?.contentTypeBoost)
    ).not.toContain("private");
  });

  test("status input schema accepts empty object", () => {
    const schema = z.object({});
    const result = schema.safeParse({});
    expect(result.success).toBe(true);
  });

  test("status output schema structure", () => {
    // Define expected output schema per spec
    const statusOutputSchema = z.object({
      indexName: z.string(),
      configPath: z.string(),
      dbPath: z.string(),
      healthy: z.boolean(),
      activeDocuments: z.number(),
      totalChunks: z.number(),
      embeddingBacklog: z.number(),
      recentErrors: z.number(),
      lastUpdatedAt: z.string().optional(),
      collections: z.array(
        z.object({
          name: z.string(),
          path: z.string(),
          activeDocuments: z.number(),
          totalChunks: z.number(),
          embeddedChunks: z.number(),
        })
      ),
    });

    // Sample valid status response
    const validStatus = {
      indexName: "default",
      configPath: "/path/to/config.yml",
      dbPath: "/path/to/index-default.sqlite",
      healthy: true,
      activeDocuments: 100,
      totalChunks: 500,
      embeddingBacklog: 0,
      recentErrors: 0,
      collections: [
        {
          name: "docs",
          path: "/path/to/docs",
          activeDocuments: 50,
          totalChunks: 250,
          embeddedChunks: 200,
        },
      ],
    };

    const result = statusOutputSchema.safeParse(validStatus);
    expect(result.success).toBe(true);
  });
});
