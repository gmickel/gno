/**
 * Memory fence loop, end to end (fn-130.5, R6).
 *
 * One GNO home shared by the CLI (`gno remember` / `gno recall` through
 * `runCli`) and a live in-memory MCP client (`gno_recall` / `gno_remember`).
 * Each surface recalls a fact, then tries to remember the recalled span with
 * the receipt attached (rejected: MEMORY_FENCED_REPLAY) and to remember a
 * paraphrase declaring a gno:// origin (rejected: MEMORY_FENCED_DERIVED).
 * A receipt issued by one surface fences the other, and nothing is written.
 */

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// node:fs/promises for temp fixtures (no Bun equivalent for mkdtemp/mkdir)
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os provides the temporary root
import { tmpdir } from "node:os";
// node:path has no Bun path utilities
import { join } from "node:path";

import type { Collection, Config } from "../src/config/types";
import type {
  MemoryRecallReceipt,
  RecallResult,
  RememberResult,
} from "../src/core/memory";
import type { ToolContext } from "../src/mcp/server";
import type { SqliteAdapter } from "../src/store/sqlite/adapter";

import { getIndexDbPath } from "../src/app/constants";
import { initStore } from "../src/cli/commands/shared";
import { runCli } from "../src/cli/run";
import { writeLeasePath } from "../src/core/write-lease";
import { createMcpServerSurface } from "../src/mcp/context";
import { safeRm } from "./helpers/cleanup";

const CLIENT_NAME = "fence-e2e-client";
const SERVER_INSTANCE_ID = "fence-e2e-server";
const SCOPE = "project:fence";
const FACT = "Deploys go out from the main branch only.";
const PARAPHRASE = "Only the main branch is deployed.";
const IDENTITY = ["--caller", "cli-fence", "--session", "cli-s1"] as const;

let stdoutData = "";
let stderrData = "";
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);

function captureOutput(): void {
  stdoutData = "";
  stderrData = "";
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdoutData += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderrData += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  console.log = (...args: unknown[]) => {
    stdoutData += `${args.join(" ")}\n`;
  };
  console.error = (...args: unknown[]) => {
    stderrData += `${args.join(" ")}\n`;
  };
}

function restoreOutput(): void {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
}

async function cli(
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  captureOutput();
  try {
    const code = await runCli(["node", "gno", ...args]);
    return { code, stdout: stdoutData, stderr: stderrData };
  } finally {
    restoreOutput();
  }
}

function memoryCode(stderr: string): string | undefined {
  const line = stderr.trim().split("\n").at(-1) ?? "{}";
  return JSON.parse(line).error?.details?.memoryCode;
}

function structured<T>(result: unknown): T {
  return (result as { structuredContent?: unknown }).structuredContent as T;
}

let testDir: string;
let memoryDir: string;
let store: SqliteAdapter;
let config: Config;
let collections: Collection[];
let client: Client;
let closeSurface: () => Promise<void>;
let cliReceipt: MemoryRecallReceipt;
let factUri = "";
let mcpReceipt: MemoryRecallReceipt;
const originalEnv = {
  configDir: process.env.GNO_CONFIG_DIR,
  dataDir: process.env.GNO_DATA_DIR,
  cacheDir: process.env.GNO_CACHE_DIR,
};

function memoryFiles(): string[] {
  return Array.from(new Bun.Glob("**/*.md").scanSync(memoryDir)).sort();
}

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "gno-memory-fence-"));
  memoryDir = join(testDir, "memory");
  await mkdir(memoryDir, { recursive: true });
  process.env.GNO_CONFIG_DIR = join(testDir, "config");
  process.env.GNO_DATA_DIR = join(testDir, "data");
  process.env.GNO_CACHE_DIR = join(testDir, "cache");

  expect((await cli("init", memoryDir, "--name", "memory")).code).toBe(0);
  const configPath = join(testDir, "config", "index.yml");
  const parsed = Bun.YAML.parse(await Bun.file(configPath).text()) as {
    collections: Array<{ name: string; memoryManaged?: boolean }>;
  };
  for (const collection of parsed.collections) {
    if (collection.name === "memory") collection.memoryManaged = true;
  }
  await Bun.write(configPath, Bun.YAML.stringify(parsed));

  // The CLI stores the fact; both surfaces recall it from the same index.
  const added = await cli(
    "remember",
    FACT,
    "--scope",
    SCOPE,
    ...IDENTITY,
    "--add",
    "--json"
  );
  expect(added.code).toBe(0);
  expect((JSON.parse(added.stdout) as RememberResult).outcome).toBe("added");
  expect(memoryFiles()).toHaveLength(1);

  const storeInit = await initStore({ syncConfig: true });
  if (!storeInit.ok) throw new Error(storeInit.error);
  ({ store, config, collections } = storeInit);
  const ctx: ToolContext = {
    indexName: "default",
    store,
    config,
    collections,
    actualConfigPath: configPath,
    toolMutex: { acquire: async () => () => {} },
    jobManager: {} as ToolContext["jobManager"],
    serverInstanceId: SERVER_INSTANCE_ID,
    writeLockPath: writeLeasePath(getIndexDbPath()),
    enableWrite: true,
    isShuttingDown: () => false,
    markContentMutation: () => {},
  };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createMcpServerSurface(ctx, {
    name: "memory-fence",
    version: "1.0.0",
  });
  await server.connect(serverSide);
  client = new Client({ name: CLIENT_NAME, version: "1.0.0" });
  await client.connect(clientSide);
  closeSurface = async () => {
    await client.close();
    await server.close();
    await store.close();
  };
});

afterAll(async () => {
  await closeSurface?.();
  await safeRm(testDir);
  process.env.GNO_CONFIG_DIR = originalEnv.configDir;
  process.env.GNO_DATA_DIR = originalEnv.dataDir;
  process.env.GNO_CACHE_DIR = originalEnv.cacheDir;
});

async function cliRemember(
  text: string,
  ...extra: string[]
): Promise<{ code: number; memoryCode: string | undefined }> {
  const result = await cli(
    "remember",
    text,
    "--scope",
    SCOPE,
    ...IDENTITY,
    "--add",
    ...extra,
    "--json"
  );
  return { code: result.code, memoryCode: memoryCode(result.stderr) };
}

async function mcpRemember(
  text: string,
  extra: Record<string, unknown>
): Promise<{ isError: boolean; code: string | undefined }> {
  const result = await client.callTool({
    name: "gno_remember",
    arguments: {
      text,
      collection: "memory",
      scopes: [SCOPE],
      decision: "add",
      ...extra,
    },
  });
  return {
    isError: result.isError === true,
    code: structured<{ error?: string }>(result)?.error,
  };
}

describe("fence loop on the CLI", () => {
  test("recall issues a receipt covering the fact's span", async () => {
    const recalled = await cli(
      "recall",
      "deploy branch",
      "--scope",
      SCOPE,
      ...IDENTITY,
      "--json"
    );
    expect(recalled.code).toBe(0);
    const payload = JSON.parse(recalled.stdout) as RecallResult;
    expect(payload.facts.map((fact) => fact.text)).toEqual([FACT]);
    expect(payload.receipt.spanHashes).toEqual([
      payload.facts[0]?.spanHash ?? "",
    ]);
    expect(payload.receipt.caller).toBe("cli-fence");
    cliReceipt = payload.receipt;
    factUri = payload.facts[0]?.uri ?? "";
    expect(factUri).toStartWith("gno://memory/");
    await Bun.write(join(testDir, "cli-receipt.json"), recalled.stdout);
  });

  test("replaying the recalled span with the receipt is rejected", async () => {
    const before = memoryFiles();
    const replay = await cliRemember(
      FACT,
      "--receipt",
      join(testDir, "cli-receipt.json")
    );
    expect(replay.code).toBe(1);
    expect(replay.memoryCode).toBe("MEMORY_FENCED_REPLAY");
    expect(memoryFiles()).toEqual(before);
  });

  test("declaring a gno:// origin is rejected", async () => {
    const before = memoryFiles();
    const derived = await cliRemember(PARAPHRASE, "--derived-from", factUri);
    expect(derived.code).toBe(1);
    expect(derived.memoryCode).toBe("MEMORY_FENCED_DERIVED");
    expect(memoryFiles()).toEqual(before);
  });
});

describe("fence loop on MCP", () => {
  test("gno_recall issues a receipt bound to the MCP identity", async () => {
    const recalled = await client.callTool({
      name: "gno_recall",
      arguments: {
        query: "deploy branch",
        collection: "memory",
        scopes: [SCOPE],
      },
    });
    expect(recalled.isError).not.toBe(true);
    const payload = structured<RecallResult>(recalled);
    expect(payload.facts.map((fact) => fact.text)).toEqual([FACT]);
    expect(payload.receipt.caller).toBe(CLIENT_NAME);
    expect(payload.receipt.session).toBe(SERVER_INSTANCE_ID);
    expect(payload.receipt.spanHashes).toEqual(cliReceipt.spanHashes);
    mcpReceipt = payload.receipt;
  });

  test("replaying the recalled span with the receipt is rejected", async () => {
    const before = memoryFiles();
    const replay = await mcpRemember(FACT, { receipt: mcpReceipt });
    expect(replay.isError).toBe(true);
    expect(replay.code).toBe("MEMORY_FENCED_REPLAY");
    expect(memoryFiles()).toEqual(before);
  });

  test("declaring a gno:// origin is rejected", async () => {
    const before = memoryFiles();
    const derived = await mcpRemember(PARAPHRASE, { derivedFrom: [factUri] });
    expect(derived.isError).toBe(true);
    expect(derived.code).toBe("MEMORY_FENCED_DERIVED");
    expect(memoryFiles()).toEqual(before);
  });
});

describe("fence loop across surfaces", () => {
  test("a receipt issued by MCP fences a CLI replay, and vice versa", async () => {
    const before = memoryFiles();
    const mcpReceiptPath = join(testDir, "mcp-receipt.json");
    await Bun.write(mcpReceiptPath, JSON.stringify({ receipt: mcpReceipt }));
    const cliReplay = await cliRemember(FACT, "--receipt", mcpReceiptPath);
    expect(cliReplay.code).toBe(1);
    expect(cliReplay.memoryCode).toBe("MEMORY_FENCED_REPLAY");

    const mcpReplay = await mcpRemember(FACT, { receipt: cliReceipt });
    expect(mcpReplay.isError).toBe(true);
    expect(mcpReplay.code).toBe("MEMORY_FENCED_REPLAY");
    expect(memoryFiles()).toEqual(before);
  });

  test("a paraphrase without receipt span or gno:// lineage is not fenced (documented limit)", async () => {
    const result = await mcpRemember(PARAPHRASE, {
      receipt: mcpReceipt,
      derivedFrom: ["https://example.com/deploy-policy"],
    });
    expect(result.isError).toBe(false);
    expect(memoryFiles()).toHaveLength(2);
  });
});
