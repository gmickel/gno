/**
 * MCP gno_sessions_status / gno_sessions_import (fn-171).
 *
 * Registration gating, source-ID-only import (no host paths), and path-free
 * status over a live in-memory MCP client.
 */

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// node:fs/promises for temp fixtures (no Bun equivalent for cp/mkdir)
import { cp, mkdir } from "node:fs/promises";
// node:path has no Bun path utilities
import { join } from "node:path";

import type { ToolContext } from "../../src/mcp/server";
import type { SessionImportReceipt } from "../../src/sessions/types";
import type { SqliteAdapter } from "../../src/store/sqlite/adapter";

import { initStore } from "../../src/cli/commands/shared";
import { createMcpServerSurface } from "../../src/mcp/context";
import {
  handleSessionsAutomationRun,
  handleSessionsImport,
} from "../../src/mcp/tools/sessions";
import { setAutomationProfile } from "../../src/sessions/automation";
import { addSessionSource, initSessionArchive } from "../../src/sessions/setup";
import { safeRm } from "../helpers/cleanup";
import { FIXTURES, tempDir } from "../sessions/helpers";

let root: string;
let configPath: string;
let store: SqliteAdapter;
let ctxBase: Omit<ToolContext, "enableWrite">;
const env = {
  config: process.env.GNO_CONFIG_DIR,
  data: process.env.GNO_DATA_DIR,
  cache: process.env.GNO_CACHE_DIR,
};

async function surface(enableWrite: boolean) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createMcpServerSurface(
    { ...ctxBase, enableWrite },
    { name: "sessions-live", version: "1.0.0" }
  );
  await server.connect(serverSide);
  const client = new Client({ name: "sessions-client", version: "1.0.0" });
  await client.connect(clientSide);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

beforeAll(async () => {
  root = await tempDir("gno-mcp-sessions-");
  process.env.GNO_CONFIG_DIR = join(root, "gno-config");
  process.env.GNO_DATA_DIR = join(root, "gno-data");
  process.env.GNO_CACHE_DIR = join(root, "gno-cache");
  configPath = join(root, "archive.yml");
  const codexRoot = join(root, "sources", "codex");
  await mkdir(codexRoot, { recursive: true });
  await cp(join(FIXTURES, "codex"), codexRoot, { recursive: true });
  await initSessionArchive({
    configPath,
    indexName: "sessions",
    archiveRoot: join(root, "archive"),
    collection: "work",
  });
  await addSessionSource({
    configPath,
    id: "codex-main",
    harness: "codex",
    path: codexRoot,
    collection: "work",
  });
  const opened = await initStore({ configPath, indexName: "sessions" });
  if (!opened.ok) throw new Error(opened.error);
  store = opened.store;
  ctxBase = {
    indexName: "sessions",
    store,
    config: opened.config,
    collections: opened.collections,
    actualConfigPath: configPath,
    toolMutex: { acquire: async () => () => {} },
    jobManager: {} as ToolContext["jobManager"],
    serverInstanceId: "sessions-test",
    writeLockPath: join(root, ".mcp-write.lock"),
    isShuttingDown: () => false,
  };
});

afterAll(async () => {
  await store.close();
  process.env.GNO_CONFIG_DIR = env.config;
  process.env.GNO_DATA_DIR = env.data;
  process.env.GNO_CACHE_DIR = env.cache;
  await safeRm(root);
});

describe("MCP session tools", () => {
  test("status is read-only; import is registered only with write enabled", async () => {
    for (const [enableWrite, expected] of [
      [false, false],
      [true, true],
    ] as const) {
      const live = await surface(enableWrite);
      try {
        const names = (await live.client.listTools()).tools.map(
          (tool) => tool.name
        );
        expect(names).toContain("gno_sessions_status");
        expect(names.includes("gno_sessions_import")).toBe(expected);
      } finally {
        await live.close();
      }
    }
  });

  test("import refuses without write authorization", async () => {
    const result = await handleSessionsImport(
      { sourceId: "codex-main" },
      { ...ctxBase, enableWrite: false }
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: "WRITE_DISABLED" });
  });

  test("import takes a registered source ID only, never a host path", async () => {
    const live = await surface(true);
    try {
      const withPath = await live.client.callTool({
        name: "gno_sessions_import",
        arguments: { sourceId: "codex-main", paths: [root] },
      });
      expect(withPath.isError).toBe(true);
      const unknown = await live.client.callTool({
        name: "gno_sessions_import",
        arguments: { sourceId: "not-registered" },
      });
      expect(unknown.structuredContent).toMatchObject({
        error: "SESSIONS_UNKNOWN_SOURCE",
      });
      const imported = await live.client.callTool({
        name: "gno_sessions_import",
        arguments: { sourceId: "codex-main" },
      });
      const receipt =
        imported.structuredContent as unknown as SessionImportReceipt;
      expect(receipt.counts.imported).toBe(4);
      expect(receipt.counts.incomplete).toBe(1);
      expect(receipt.status).toBe("partial");
      expect(JSON.stringify(receipt)).not.toContain(root);
    } finally {
      await live.close();
    }
  });

  test("status reports sources and pending work without host paths", async () => {
    const live = await surface(false);
    try {
      const status = await live.client.callTool({
        name: "gno_sessions_status",
        arguments: {},
      });
      expect(status.structuredContent).toMatchObject({
        index: "sessions",
        sources: [{ id: "codex-main", harness: "codex", collection: "work" }],
      });
      expect(JSON.stringify(status.structuredContent)).not.toContain(root);
    } finally {
      await live.close();
    }
  });

  test("filesystem failures reach MCP callers as a typed, path-free error", async () => {
    const blocker = join(root, "not-a-directory");
    await Bun.write(blocker, "file");
    const sessions = ctxBase.config.sessions!;
    const config = {
      ...ctxBase.config,
      sessions: { ...sessions, archiveRoot: blocker },
      collections: ctxBase.config.collections.map((collection) => ({
        ...collection,
        path: join(blocker, collection.name),
      })),
    };
    const result = await handleSessionsImport(
      { sourceId: "codex-main" },
      { ...ctxBase, config, enableWrite: true }
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: "SESSIONS_RUNTIME_FAILURE",
    });
    expect(JSON.stringify(result)).not.toContain(root);
  });

  test("automation run is write-gated, runs a configured profile only, and takes no sources", async () => {
    const refused = await handleSessionsAutomationRun(
      { profileId: "main" },
      { ...ctxBase, enableWrite: false }
    );
    expect(refused.structuredContent).toMatchObject({
      error: "WRITE_DISABLED",
    });
    await setAutomationProfile(
      { configPath, indexName: "sessions" },
      { id: "main", sources: ["codex-main"] }
    );
    const live = await surface(true);
    try {
      const names = (await live.client.listTools()).tools.map(
        (tool) => tool.name
      );
      expect(names).toContain("gno_sessions_automation_run");
      const widened = await live.client.callTool({
        name: "gno_sessions_automation_run",
        arguments: { profileId: "main", sources: ["other"] },
      });
      expect(widened.isError).toBe(true);
      const unknown = await live.client.callTool({
        name: "gno_sessions_automation_run",
        arguments: { profileId: "ghost" },
      });
      expect(unknown.structuredContent).toMatchObject({
        error: "SESSIONS_UNKNOWN_PROFILE",
      });
      const ran = await live.client.callTool({
        name: "gno_sessions_automation_run",
        arguments: { profileId: "main" },
      });
      expect(ran.structuredContent).toMatchObject({
        profileId: "main",
        ran: true,
      });
      expect(JSON.stringify(ran.structuredContent)).not.toContain(root);
    } finally {
      await live.close();
    }
  });
});
