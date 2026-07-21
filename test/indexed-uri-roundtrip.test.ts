import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../src/config/types";
import type { ToolContext } from "../src/mcp/server";

import { getIndexDbPath } from "../src/app/constants";
import { registerResources } from "../src/mcp/resources";
import { handleGet } from "../src/mcp/tools/get";
import { handleMultiGet } from "../src/mcp/tools/multi-get";
import { createGnoClient, type GnoClient } from "../src/sdk";
import { SqliteAdapter } from "../src/store/sqlite/adapter";
import { safeRm } from "./helpers/cleanup";

const originalDataDir = process.env.GNO_DATA_DIR;
let tmpDir: string;
let config: Config;
let activeStore: SqliteAdapter;
let sdkClient: GnoClient;

async function seedIndex(indexName: string, content: string): Promise<void> {
  const store = new SqliteAdapter();
  const openResult = await store.open(getIndexDbPath(indexName), "porter");
  expect(openResult.ok).toBe(true);
  const collectionsResult = await store.syncCollections(config.collections);
  expect(collectionsResult.ok).toBe(true);
  const mirrorHash = `${indexName}-mirror`;
  const documentResult = await store.upsertDocument({
    collection: "notes",
    relPath: "same.md",
    sourceHash: `${indexName}-source`,
    sourceMime: "text/markdown",
    sourceExt: ".md",
    sourceSize: content.length,
    sourceMtime: "2026-07-21T00:00:00Z",
    mirrorHash,
  });
  expect(documentResult.ok).toBe(true);
  const contentResult = await store.upsertContent(mirrorHash, content);
  expect(contentResult.ok).toBe(true);
  await store.close();
}

async function captureRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error(`Expected Error rejection, received ${String(error)}`);
  }
  throw new Error("Expected promise to reject");
}

function createToolContext(): ToolContext {
  return {
    store: activeStore,
    config,
    collections: config.collections,
    actualConfigPath: join(tmpDir, "config.yml"),
    indexName: "default",
    toolMutex: {
      acquire: () => Promise.resolve(() => undefined),
    } as ToolContext["toolMutex"],
    jobManager: {} as ToolContext["jobManager"],
    serverInstanceId: "indexed-uri-test",
    writeLockPath: join(tmpDir, ".write.lock"),
    enableWrite: false,
    isShuttingDown: () => false,
  };
}

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "gno-indexed-uri-"));
  process.env.GNO_DATA_DIR = join(tmpDir, "data");
  await mkdir(process.env.GNO_DATA_DIR, { recursive: true });
  config = {
    version: "1.0",
    ftsTokenizer: "porter",
    collections: [
      {
        name: "notes",
        path: tmpDir,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ],
    contexts: [],
  };

  await seedIndex("default", "content from default index");
  await seedIndex("alt", "content from alternate index");

  activeStore = new SqliteAdapter();
  const activeOpen = await activeStore.open(
    getIndexDbPath("default"),
    "porter"
  );
  expect(activeOpen.ok).toBe(true);
  sdkClient = await createGnoClient({ config, indexName: "default" });
});

afterAll(async () => {
  await sdkClient?.close();
  await activeStore?.close();
  await safeRm(tmpDir);
  process.env.GNO_DATA_DIR = originalDataDir;
});

describe("indexed URI roundtrip", () => {
  test("SDK get and multiGet read the explicitly requested index", async () => {
    const ref = "gno://notes/same.md?index=alt";
    const single = await sdkClient.get(ref);
    expect(single.content).toBe("content from alternate index");
    expect(single.uri).toBe(ref);

    const multiple = await sdkClient.multiGet([ref]);
    expect(multiple.documents).toHaveLength(1);
    expect(multiple.documents[0]?.content).toBe("content from alternate index");
    expect(multiple.documents[0]?.uri).toBe(ref);
  });

  test("SDK rejects ambiguous batches and does not create missing indexes", async () => {
    const ambiguousBatch = Promise.resolve(
      sdkClient.multiGet([
        "gno://notes/same.md?index=alt",
        "gno://notes/same.md",
      ])
    );
    const ambiguousError = await captureRejection(ambiguousBatch);
    expect(ambiguousError.message).toContain("cannot mix indexed refs");

    const missingPath = getIndexDbPath("missing");
    expect(await Bun.file(missingPath).exists()).toBe(false);
    const missingIndex = Promise.resolve(
      sdkClient.get("gno://notes/same.md?index=missing")
    );
    const missingError = await captureRejection(missingIndex);
    expect(missingError.message).toContain('Index "missing" does not exist');
    expect(await Bun.file(missingPath).exists()).toBe(false);
  });

  test("MCP get and multi-get read the explicitly requested index", async () => {
    const ref = "gno://notes/same.md?index=alt";
    const ctx = createToolContext();
    const single = await handleGet({ ref, lineNumbers: false }, ctx);
    expect(single.isError).toBeFalsy();
    expect(single.structuredContent?.content).toBe(
      "content from alternate index"
    );
    expect(single.structuredContent?.uri).toBe(ref);

    const multiple = await handleMultiGet(
      { refs: [ref], lineNumbers: false },
      ctx
    );
    expect(multiple.isError).toBeFalsy();
    const documents = multiple.structuredContent?.documents as Array<{
      uri: string;
      content: string;
    }>;
    expect(documents[0]).toEqual(
      expect.objectContaining({
        uri: ref,
        content: "content from alternate index",
      })
    );
  });

  test("MCP document resources read the explicitly requested index", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = new McpServer(
      { name: "indexed-uri-test", version: "1.0.0" },
      { capabilities: { resources: {} } }
    );
    registerResources(server, createToolContext());
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    try {
      const result = await client.readResource({
        uri: "gno://notes/same.md?index=alt",
      });
      const firstContent = result.contents[0];
      const text =
        firstContent && "text" in firstContent ? firstContent.text : "";
      expect(text).toContain("content from alternate index");
      expect(text).not.toContain("content from default index");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
