/**
 * MCP gno_remove_collection tool tests.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type { ToolContext } from "../../../src/mcp/server";

import { handleRemoveCollection } from "../../../src/mcp/tools/remove-collection";
import { safeRm } from "../../helpers/cleanup";

const removeCollectionInputSchema = z.object({
  collection: z.string().min(1),
});

describe("gno_remove_collection schema", () => {
  test("remove collection requires name", () => {
    const result = removeCollectionInputSchema.safeParse({
      collection: "notes",
    });
    expect(result.success).toBe(true);
  });
});

test("MCP collection removal advances resident content and index generations", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "gno-mcp-remove-"));
  const configPath = join(tempDir, "index.yml");
  await writeFile(
    configPath,
    Bun.YAML.stringify({
      version: "1.0",
      ftsTokenizer: "unicode61",
      collections: [
        {
          name: "notes",
          path: tempDir,
          pattern: "**/*.md",
          include: [],
          exclude: [],
        },
      ],
      contexts: [],
    })
  );
  let contentGeneration = 0;
  let indexGeneration = 0;
  const config = {
    version: "1.0" as const,
    ftsTokenizer: "unicode61" as const,
    collections: [
      {
        name: "notes",
        path: tempDir,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ],
    contexts: [],
  };
  const ctx = {
    store: {
      syncCollections: async () => ({ ok: true, value: undefined }),
      syncContexts: async () => ({ ok: true, value: undefined }),
    },
    config,
    collections: config.collections,
    actualConfigPath: configPath,
    indexName: "default",
    toolMutex: { acquire: async () => () => undefined },
    jobManager: {},
    serverInstanceId: "test-server",
    writeLockPath: join(tempDir, ".write.lock"),
    enableWrite: true,
    isShuttingDown: () => false,
    markContentMutation: () => {
      contentGeneration += 1;
    },
    markIndexMutation: () => {
      indexGeneration += 1;
    },
  } as unknown as ToolContext;

  try {
    const result = await handleRemoveCollection({ collection: "notes" }, ctx);
    expect(result.isError).toBeUndefined();
    expect(contentGeneration).toBe(1);
    expect(indexGeneration).toBe(1);
  } finally {
    await safeRm(tempDir);
  }
});
