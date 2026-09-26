/**
 * MCP session tools follow the config file: a source added or removed by the
 * CLI while the server runs shows in gno_sessions_status without a restart,
 * over stdio and the resident HTTP endpoint, with the REST route's binding
 * checks and errors.
 */

import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises for temp fixtures (no Bun equivalent for cp/mkdir)
import { cp, mkdir } from "node:fs/promises";
// node:path has no Bun path utilities
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { ResidentRuntime } from "../../src/serve/resident-runtime";

import { initStore } from "../../src/cli/commands/shared";
import { loadConfig, saveConfigToPath } from "../../src/config";
import {
  createMcpServerSurface,
  createToolContext,
  Mutex,
} from "../../src/mcp/context";
import { HttpMcpTransport } from "../../src/mcp/http-transport";
import { startResidentRuntime } from "../../src/serve/resident-runtime";
import {
  addSessionSource,
  initSessionArchive,
  removeSessionSource,
} from "../../src/sessions/setup";
import { safeRm } from "../helpers/cleanup";
import { FIXTURES, snapshotSessionEnv, tempDir } from "../sessions/helpers";

const INDEX = "sessions";

let root: string;
let configPath: string;
let codexRoot: string;
const restoreEnv = snapshotSessionEnv();

interface StatusCall {
  isError?: boolean;
  structuredContent?: {
    error?: string;
    message?: string;
    sources?: Array<{ id: string }>;
  };
}

async function status(client: Client): Promise<StatusCall> {
  return (await client.callTool({
    name: "gno_sessions_status",
    arguments: {},
  })) as StatusCall;
}

async function sourceIds(client: Client): Promise<string[]> {
  const result = await status(client);
  expect(result.isError).toBeFalsy();
  return (result.structuredContent?.sources ?? []).map((source) => source.id);
}

/** Add then remove a source from outside the server, as the CLI does. */
async function expectCliChangesSeen(client: Client): Promise<void> {
  expect(await sourceIds(client)).toEqual(["codex-main"]);
  await addSessionSource({
    configPath,
    id: "codex-two",
    harness: "codex",
    path: codexRoot,
    collection: "work",
  });
  expect(await sourceIds(client)).toEqual(["codex-main", "codex-two"]);
  await removeSessionSource({ configPath, id: "codex-main" });
  expect(await sourceIds(client)).toEqual(["codex-two"]);
}

/** A stdio-shaped server: the context the `gno mcp serve` process builds. */
async function openStdio() {
  const opened = await initStore({ configPath, indexName: INDEX });
  if (!opened.ok) throw new Error(opened.error);
  let served = opened.config;
  const toolMutex = new Mutex();
  const ctx = createToolContext({
    store: opened.store,
    getConfig: () => served,
    setConfig: (config) => {
      served = config;
    },
    actualConfigPath: configPath,
    indexName: INDEX,
    toolMutex,
    jobManager: {} as never,
    serverInstanceId: "sessions-refresh",
    writeLockPath: join(root, ".mcp-write.lock"),
    enableWrite: false,
    isShuttingDown: () => false,
  });
  const server = createMcpServerSurface(ctx);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "sessions-refresh", version: "1.0.0" });
  await client.connect(clientSide);
  return {
    client,
    served: () => served,
    close: async () => {
      await client.close();
      await server.close();
      await opened.store.close();
    },
  };
}

beforeEach(async () => {
  root = await tempDir("gno-mcp-sessions-refresh-");
  process.env.GNO_CONFIG_DIR = join(root, "gno-config");
  process.env.GNO_DATA_DIR = join(root, "gno-data");
  process.env.GNO_CACHE_DIR = join(root, "gno-cache");
  configPath = join(root, "archive.yml");
  codexRoot = join(root, "sources", "codex");
  await mkdir(codexRoot, { recursive: true });
  await cp(join(FIXTURES, "codex"), codexRoot, { recursive: true });
  await initSessionArchive({
    configPath,
    indexName: INDEX,
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
});

afterEach(async () => {
  restoreEnv();
  await safeRm(root);
});

describe("gno_sessions_status follows the config file", () => {
  test("stdio sees CLI add and remove without a restart", async () => {
    const live = await openStdio();
    try {
      await expectCliChangesSeen(live.client);
    } finally {
      await live.close();
    }
  });

  test("resident HTTP sees CLI add and remove on one open session", async () => {
    const started = await startResidentRuntime({
      configPath,
      index: INDEX,
      offline: true,
    });
    if (!started.success) throw new Error(started.error);
    const runtime: ResidentRuntime = started.runtime;
    const transport = new HttpMcpTransport(runtime, { enableWrite: false });
    // As the production gateway wires it: a policy change closes sessions.
    runtime.setPolicySessionInvalidator(() =>
      transport.invalidateAuthenticatedSessions()
    );
    const client = new Client({ name: "sessions-http", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3000/mcp"), {
        fetch: (input, init) =>
          transport.handleRequest(new Request(input, init)),
      })
    );
    try {
      await expectCliChangesSeen(client);
      // The resident server adopted it too (Web UI and REST share it).
      expect(runtime.config.sessions?.sources.map((s) => s.id)).toEqual([
        "codex-two",
      ]);
    } finally {
      await client.close();
      await transport.close();
      await runtime.dispose();
    }
  });

  test("an unreadable config is an error, never served stale", async () => {
    const live = await openStdio();
    try {
      await Bun.write(configPath, "version: [not valid\n");
      const result = await status(live.client);
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.error).toBe("SESSIONS_RUNTIME_FAILURE");
      expect(result.structuredContent?.message).not.toContain(root);
    } finally {
      await live.close();
    }
  });

  test("a config rebound to another index is refused and not adopted", async () => {
    const live = await openStdio();
    try {
      const loaded = await loadConfig(configPath);
      if (!loaded.ok) throw new Error(loaded.error.message);
      const served = live.served();
      const rebound = {
        ...loaded.value,
        sessions: { ...loaded.value.sessions!, index: "other" },
      } as Config;
      await saveConfigToPath(rebound, configPath);
      const result = await status(live.client);
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.error).toBe("SESSIONS_BINDING_MISMATCH");
      expect(live.served()).toBe(served);
    } finally {
      await live.close();
    }
  });
});
