/**
 * Cross-surface session contract (fn-171): CLI --json, SDK and MCP import the
 * same registered source into identical fresh archives and return receipts
 * that validate against the shared schema and agree on every count. Status
 * and discovery validate against their schemas too. REST is covered by
 * test/serve/sessions-api.test.ts against the same schemas.
 */

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises for temp fixtures (no Bun equivalent for cp/mkdir/readdir)
import { cp, mkdir, readdir } from "node:fs/promises";
// node:path has no Bun path utilities
import { join } from "node:path";

import type { ToolContext } from "../../../src/mcp/server";
import type { SessionImportReceipt } from "../../../src/sessions/types";

import { initStore } from "../../../src/cli/commands/shared";
import { runCli } from "../../../src/cli/run";
import { createMcpServerSurface } from "../../../src/mcp/context";
import { createGnoClient } from "../../../src/sdk";
import {
  addSessionSource,
  initSessionArchive,
} from "../../../src/sessions/service";
import { safeRm } from "../../helpers/cleanup";
import { FIXTURES, tempDir } from "../../sessions/helpers";
import { assertValid, loadSchema } from "./validator";

let root: string;
const env = {
  config: process.env.GNO_CONFIG_DIR,
  data: process.env.GNO_DATA_DIR,
  cache: process.env.GNO_CACHE_DIR,
};

/** A fresh archive per surface so every receipt starts from the same state. */
async function freshArchive(name: string): Promise<{ configPath: string }> {
  const base = join(root, name);
  const codexRoot = join(base, "sources", "codex");
  await mkdir(codexRoot, { recursive: true });
  await cp(join(FIXTURES, "codex"), codexRoot, { recursive: true });
  const configPath = join(base, "archive.yml");
  await initSessionArchive({
    configPath,
    indexName: name,
    archiveRoot: join(base, "archive"),
    collection: "work",
  });
  await addSessionSource({
    configPath,
    id: "codex-main",
    harness: "codex",
    path: codexRoot,
    collection: "work",
  });
  return { configPath };
}

async function cliJson(args: string[]): Promise<unknown> {
  let stdout = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  try {
    const code = await runCli(["node", "gno", ...args]);
    expect(code).toBe(0);
  } finally {
    process.stdout.write = original;
  }
  return JSON.parse(stdout);
}

const comparable = (receipt: SessionImportReceipt) => ({
  status: receipt.status,
  counts: receipt.counts,
  turns: receipt.turns,
  outcomes: receipt.units
    .map((unit) => `${unit.locator} ${unit.outcome}`)
    .sort((left, right) => left.localeCompare(right)),
  lexical: receipt.lexical.status,
});

beforeEach(async () => {
  root = await tempDir("gno-sessions-contract-");
  process.env.GNO_CONFIG_DIR = join(root, "gno-config");
  process.env.GNO_DATA_DIR = join(root, "gno-data");
  process.env.GNO_CACHE_DIR = join(root, "gno-cache");
});

afterEach(async () => {
  process.env.GNO_CONFIG_DIR = env.config;
  process.env.GNO_DATA_DIR = env.data;
  process.env.GNO_CACHE_DIR = env.cache;
  await safeRm(root);
});

describe("session receipts agree across surfaces", () => {
  test("CLI, SDK and MCP import receipts validate and match", async () => {
    const receiptSchema = await loadSchema("sessions-import-receipt");
    const statusSchema = await loadSchema("sessions-status");

    const cli = await freshArchive("cli");
    const cliReceipt = (await cliJson([
      "--config",
      cli.configPath,
      "--index",
      "cli",
      "sessions",
      "import",
      "--source",
      "codex-main",
      "--json",
    ])) as SessionImportReceipt;
    const cliStatus = await cliJson([
      "--config",
      cli.configPath,
      "--index",
      "cli",
      "sessions",
      "status",
      "--json",
    ]);
    assertValid(cliStatus, statusSchema);

    const sdk = await freshArchive("sdk");
    const client = await createGnoClient({
      configPath: sdk.configPath,
      indexName: "sdk",
    });
    let sdkReceipt: SessionImportReceipt;
    try {
      sdkReceipt = await client.importSessions({ sourceId: "codex-main" });
      assertValid(await client.sessionsStatus(), statusSchema);
    } finally {
      await client.close();
    }

    const mcp = await freshArchive("mcp");
    const opened = await initStore({
      configPath: mcp.configPath,
      indexName: "mcp",
    });
    if (!opened.ok) throw new Error(opened.error);
    const ctx: ToolContext = {
      indexName: "mcp",
      store: opened.store,
      config: opened.config,
      collections: opened.collections,
      actualConfigPath: mcp.configPath,
      toolMutex: { acquire: async () => () => {} },
      jobManager: {} as ToolContext["jobManager"],
      serverInstanceId: "sessions-contract",
      writeLockPath: join(root, ".mcp-write.lock"),
      enableWrite: true,
      isShuttingDown: () => false,
    };
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createMcpServerSurface(ctx, {
      name: "contract",
      version: "1",
    });
    await server.connect(serverSide);
    const mcpClient = new Client({ name: "contract-client", version: "1" });
    await mcpClient.connect(clientSide);
    let mcpReceipt: SessionImportReceipt;
    try {
      const result = await mcpClient.callTool({
        name: "gno_sessions_import",
        arguments: { sourceId: "codex-main" },
      });
      mcpReceipt = result.structuredContent as unknown as SessionImportReceipt;
      const status = await mcpClient.callTool({
        name: "gno_sessions_status",
        arguments: {},
      });
      assertValid(status.structuredContent, statusSchema);
    } finally {
      await mcpClient.close();
      await server.close();
      await opened.store.close();
    }

    for (const receipt of [cliReceipt, sdkReceipt, mcpReceipt]) {
      assertValid(receipt, receiptSchema);
    }
    expect(comparable(sdkReceipt)).toEqual(comparable(cliReceipt));
    expect(comparable(mcpReceipt)).toEqual(comparable(cliReceipt));
    expect(cliReceipt.status).toBe("partial");
    expect(cliReceipt.counts.incomplete).toBe(1);
  });

  test("dry-run and discovery validate and write nothing", async () => {
    const archive = await freshArchive("dry");
    const receipt = await cliJson([
      "--config",
      archive.configPath,
      "--index",
      "dry",
      "sessions",
      "import",
      "--source",
      "codex-main",
      "--dry-run",
      "--json",
    ]);
    assertValid(receipt, await loadSchema("sessions-import-receipt"));
    expect(
      await readdir(join(root, "dry", "archive"), { recursive: true })
    ).toEqual(["work"]);
    // Discovery reads host roots; point every harness root at a synthetic home.
    const home = join(root, "home");
    const codexSessions = join(home, ".codex", "sessions");
    await mkdir(codexSessions, { recursive: true });
    await cp(join(FIXTURES, "codex"), codexSessions, { recursive: true });
    const saved = { ...process.env };
    process.env.HOME = home;
    for (const key of [
      "CODEX_HOME",
      "CLAUDE_CONFIG_DIR",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_HOME",
      "HERMES_HOME",
    ]) {
      delete process.env[key];
    }
    try {
      const discovery = (await cliJson(["sessions", "discover", "--json"])) as {
        candidates: Array<{ harness: string; units: number }>;
      };
      assertValid(discovery, await loadSchema("sessions-discovery"));
      expect(discovery.candidates).toMatchObject([
        { harness: "codex", units: 4 },
      ]);
    } finally {
      process.env = saved;
    }
  });
});
