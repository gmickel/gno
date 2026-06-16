import { afterEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CaptureReceipt } from "../../src/core/capture";
import type { ToolContext } from "../../src/mcp/server";

import { capture as cliCapture } from "../../src/cli/commands/capture";
import { handleCapture as handleMcpCapture } from "../../src/mcp/tools/capture";
import { createDefaultConfig, createGnoClient } from "../../src/sdk";
import { handleCreateCapture } from "../../src/serve/routes/api";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const SHARED_INPUT = {
  collection: "notes",
  content: "# Parity Capture\n\nShared body.",
  title: "Parity Capture",
  relPath: "captures/parity.md",
  tags: ["Inbox", "Project/GNO"],
  source: {
    kind: "web" as const,
    url: "https://example.com/parity",
    title: "Parity Source",
    author: "Ada",
    observedAt: "2026-06-04T12:00:00Z",
    externalId: "parity-1",
  },
};

const originalEnv = {
  configDir: process.env.GNO_CONFIG_DIR,
  dataDir: process.env.GNO_DATA_DIR,
  cacheDir: process.env.GNO_CACHE_DIR,
};

function normalizeCaptureContent(content: string): string {
  return content.replace(/  capturedAt: "[^"]+"/u, '  capturedAt: "<dynamic>"');
}

function stableReceipt(receipt: CaptureReceipt) {
  return {
    collection: receipt.collection,
    relPath: receipt.relPath,
    created: receipt.created,
    openedExisting: receipt.openedExisting,
    createdWithSuffix: receipt.createdWithSuffix,
    overwritten: receipt.overwritten ?? false,
    collisionPolicyResult: receipt.collisionPolicyResult,
    contentHash: receipt.contentHash,
    source: {
      ...receipt.source,
      capturedAt: "<dynamic>",
    },
    tags: receipt.tags,
    embedStatus: receipt.embed.status,
  };
}

async function openStore(root: string): Promise<SqliteAdapter> {
  const store = new SqliteAdapter();
  const open = await store.open(join(root, "index.sqlite"), "porter");
  expect(open.ok).toBe(true);
  const sync = await store.syncCollections([
    {
      name: "notes",
      path: join(root, "notes"),
      pattern: "**/*.md",
      include: [],
      exclude: [],
    },
  ]);
  expect(sync.ok).toBe(true);
  return store;
}

async function makeRoot(prefix: string): Promise<string> {
  const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random()}`);
  await mkdir(join(root, "notes"), { recursive: true });
  return root;
}

async function runCliSurface(): Promise<{
  receipt: CaptureReceipt;
  content: string;
  root: string;
}> {
  const root = await makeRoot("gno-capture-cli-parity");
  process.env.GNO_CONFIG_DIR = join(root, "config");
  process.env.GNO_DATA_DIR = join(root, "data");
  process.env.GNO_CACHE_DIR = join(root, "cache");
  const config = createDefaultConfig();
  config.collections = [
    {
      name: "notes",
      path: join(root, "notes"),
      pattern: "**/*.md",
      include: [],
      exclude: [],
    },
  ];
  await mkdir(join(root, "config"), { recursive: true });
  await Bun.write(
    join(root, "config", "index.yml"),
    Bun.YAML.stringify(config)
  );

  const receipt = await cliCapture({
    collection: SHARED_INPUT.collection,
    inlineContent: SHARED_INPUT.content,
    title: SHARED_INPUT.title,
    path: SHARED_INPUT.relPath,
    tags: SHARED_INPUT.tags.join(","),
    sourceKind: SHARED_INPUT.source.kind,
    sourceUrl: SHARED_INPUT.source.url,
    sourceTitle: SHARED_INPUT.source.title,
    sourceAuthor: SHARED_INPUT.source.author,
    sourceDate: SHARED_INPUT.source.observedAt,
    sourceId: SHARED_INPUT.source.externalId,
  });
  return {
    receipt,
    content: await Bun.file(join(root, "notes", receipt.relPath)).text(),
    root,
  };
}

async function runApiSurface(): Promise<{
  receipt: CaptureReceipt;
  content: string;
  root: string;
  store: SqliteAdapter;
}> {
  const root = await makeRoot("gno-capture-api-parity");
  const store = await openStore(root);
  const config = {
    version: "1.0",
    ftsTokenizer: "porter",
    collections: [
      {
        name: "notes",
        path: join(root, "notes"),
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ],
    contexts: [],
  };
  const ctxHolder = {
    current: {},
    config,
    scheduler: null,
    eventBus: null,
    watchService: null,
  };
  const req = new Request("http://localhost/api/capture", {
    method: "POST",
    body: JSON.stringify({
      ...SHARED_INPUT,
      tags: SHARED_INPUT.tags,
    }),
  });
  const res = await handleCreateCapture(
    ctxHolder as never,
    store as never,
    req
  );
  expect(res.status).toBe(202);
  const receipt = (await res.json()) as CaptureReceipt;
  return {
    receipt,
    content: await Bun.file(join(root, "notes", receipt.relPath)).text(),
    root,
    store,
  };
}

async function runMcpSurface(): Promise<{
  receipt: CaptureReceipt;
  content: string;
  root: string;
  store: SqliteAdapter;
}> {
  const root = await makeRoot("gno-capture-mcp-parity");
  const store = await openStore(root);
  const ctx: ToolContext = {
    store,
    config: {
      version: "1.0",
      ftsTokenizer: "porter",
      collections: [],
      contexts: [],
    },
    collections: [
      {
        name: "notes",
        path: join(root, "notes"),
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ],
    actualConfigPath: join(root, "config.yml"),
    toolMutex: {
      acquire: async () => () => {},
    } as ToolContext["toolMutex"],
    jobManager: {} as ToolContext["jobManager"],
    serverInstanceId: "550e8400-e29b-41d4-a716-446655440000",
    writeLockPath: join(root, ".lock"),
    enableWrite: true,
    isShuttingDown: () => false,
  };
  const result = await handleMcpCapture(
    {
      collection: SHARED_INPUT.collection,
      content: SHARED_INPUT.content,
      title: SHARED_INPUT.title,
      path: SHARED_INPUT.relPath,
      tags: SHARED_INPUT.tags,
      source: SHARED_INPUT.source,
    },
    ctx
  );
  expect(result.isError).toBeUndefined();
  const receipt = result.structuredContent as unknown as CaptureReceipt;
  return {
    receipt,
    content: await Bun.file(join(root, "notes", receipt.relPath)).text(),
    root,
    store,
  };
}

async function runSdkSurface(): Promise<{
  receipt: CaptureReceipt;
  content: string;
  root: string;
  close: () => Promise<void>;
}> {
  const root = await makeRoot("gno-capture-sdk-parity");
  const config = createDefaultConfig();
  config.collections = [
    {
      name: "notes",
      path: join(root, "notes"),
      pattern: "**/*.md",
      include: [],
      exclude: [],
    },
  ];
  const client = await createGnoClient({
    config,
    dbPath: join(root, "index.sqlite"),
    downloadPolicy: { offline: false, allowDownload: false },
  });
  const receipt = await client.capture({
    ...SHARED_INPUT,
    tags: SHARED_INPUT.tags,
  });
  return {
    receipt,
    content: await Bun.file(join(root, "notes", receipt.relPath)).text(),
    root,
    close: () => client.close(),
  };
}

describe("capture surface parity", () => {
  const roots: string[] = [];
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) {
      await close();
    }
    for (const root of roots.splice(0)) {
      await safeRm(root);
    }
    process.env.GNO_CONFIG_DIR = originalEnv.configDir;
    process.env.GNO_DATA_DIR = originalEnv.dataDir;
    process.env.GNO_CACHE_DIR = originalEnv.cacheDir;
  });

  test(
    "CLI, REST, MCP, and SDK write equivalent capture receipts and frontmatter",
    async () => {
      const cli = await runCliSurface();
      roots.push(cli.root);
      const api = await runApiSurface();
      roots.push(api.root);
      closers.push(() => api.store.close());
      const mcp = await runMcpSurface();
      roots.push(mcp.root);
      closers.push(() => mcp.store.close());
      const sdk = await runSdkSurface();
      roots.push(sdk.root);
      closers.push(sdk.close);

      const stable = [
        stableReceipt(cli.receipt),
        stableReceipt(api.receipt),
        stableReceipt(mcp.receipt),
        stableReceipt(sdk.receipt),
      ];
      for (const receipt of stable) {
        expect(receipt).toMatchObject({
          collection: "notes",
          relPath: SHARED_INPUT.relPath,
          created: true,
          openedExisting: false,
          createdWithSuffix: false,
          overwritten: false,
          collisionPolicyResult: "created",
          tags: ["inbox", "project/gno"],
          embedStatus: "not_requested",
        });
        expect(receipt.source).toMatchObject({
          kind: "web",
          url: SHARED_INPUT.source.url,
          title: SHARED_INPUT.source.title,
          author: SHARED_INPUT.source.author,
          observedAt: "2026-06-04T12:00:00.000Z",
          externalId: SHARED_INPUT.source.externalId,
        });
      }

      expect(stable[0]?.contentHash).toBe(stable[1]?.contentHash);
      expect(stable[0]?.contentHash).toBe(stable[2]?.contentHash);
      expect(stable[0]?.contentHash).toBe(stable[3]?.contentHash);
      expect(cli.receipt.sync.status).toBe("completed");
      expect(api.receipt.sync.status).toBe("pending");
      expect(mcp.receipt.sync.status).toBe("completed");
      expect(sdk.receipt.sync.status).toBe("completed");

      const normalizedContent = [
        normalizeCaptureContent(cli.content),
        normalizeCaptureContent(api.content),
        normalizeCaptureContent(mcp.content),
        normalizeCaptureContent(sdk.content),
      ];
      expect(normalizedContent[0]).toBe(normalizedContent[1]);
      expect(normalizedContent[0]).toBe(normalizedContent[2]);
      expect(normalizedContent[0]).toBe(normalizedContent[3]);
    },
    { timeout: 60_000 }
  );
});
