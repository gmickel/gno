/**
 * MCP gno_recall / gno_remember tests (fn-130.3).
 *
 * Live in-memory MCP client against the real tool surface: registration
 * gating, remember → recall → fence loop, R4 refusals, identity mapping, and
 * the no-adapter-lease contract.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// node:fs/promises for temp fixtures (no Bun equivalent for mkdtemp/mkdir)
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os provides the temporary root
import { tmpdir } from "node:os";
// node:path has no Bun path utilities
import { join } from "node:path";

import type { Collection, Config } from "../../src/config/types";
import type { RecallResult, RememberResult } from "../../src/core/memory";
import type { ToolContext } from "../../src/mcp/server";

import { createDefaultConfig } from "../../src/config/defaults";
import { acquireWriteLock } from "../../src/core/file-lock";
import { MEMORY_EMPTY_RECALL_HINT } from "../../src/core/memory";
import { createMcpServerSurface } from "../../src/mcp/context";
import { MCP_HTTP_EGRESS_TOOLS } from "../../src/mcp/http-egress";
import { MCP_WRITE_TOOL_NAMES } from "../../src/mcp/tools/index";
import { handleRecall } from "../../src/mcp/tools/memory-recall";
import { handleRemember } from "../../src/mcp/tools/memory-remember";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const CLIENT_NAME = "memory-live-client";
const SERVER_INSTANCE_ID = "memory-test-server";
const SCOPES = ["project:gno"];

interface LiveSurface {
  client: Client;
  close: () => Promise<void>;
}

let root: string;
let store: SqliteAdapter;
let config: Config;
let collections: Collection[];
let lockPath: string;
let contentMutations = 0;

function toolContext(enableWrite: boolean): ToolContext {
  return {
    indexName: "default",
    store,
    config,
    collections,
    actualConfigPath: join(root, "config.yml"),
    toolMutex: { acquire: async () => () => {} },
    jobManager: {} as ToolContext["jobManager"],
    serverInstanceId: SERVER_INSTANCE_ID,
    writeLockPath: lockPath,
    enableWrite,
    isShuttingDown: () => false,
    markContentMutation: () => {
      contentMutations += 1;
    },
  };
}

async function liveSurface(enableWrite: boolean): Promise<LiveSurface> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createMcpServerSurface(toolContext(enableWrite), {
    name: "memory-live",
    version: "1.0.0",
  });
  await server.connect(serverSide);
  const client = new Client({ name: CLIENT_NAME, version: "1.0.0" });
  await client.connect(clientSide);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Tool results arrive as a wide SDK union; structuredContent is what we assert on. */
function structured<T>(result: unknown): T {
  return (result as { structuredContent?: unknown }).structuredContent as T;
}

function errorCode(result: unknown): string {
  return structured<{ error: string }>(result).error;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "gno-mcp-memory-"));
  await mkdir(join(root, "memory"), { recursive: true });
  await mkdir(join(root, "notes"), { recursive: true });
  collections = [
    {
      name: "memory",
      path: join(root, "memory"),
      pattern: "**/*.md",
      include: [],
      exclude: [],
      memoryManaged: true,
    },
    {
      name: "notes",
      path: join(root, "notes"),
      pattern: "**/*.md",
      include: [],
      exclude: [],
    },
  ];
  config = { ...createDefaultConfig(), collections };
  store = new SqliteAdapter();
  expect((await store.open(join(root, "index.sqlite"), "porter")).ok).toBe(
    true
  );
  expect((await store.syncCollections(collections)).ok).toBe(true);
  lockPath = join(root, ".mcp-write.lock");
});

afterAll(async () => {
  await store.close();
  await safeRm(root);
});

describe("gno_recall / gno_remember registration", () => {
  test("gno_remember is a write tool; gno_recall is not", () => {
    expect(MCP_WRITE_TOOL_NAMES.has("gno_remember")).toBe(true);
    expect(MCP_WRITE_TOOL_NAMES.has("gno_recall")).toBe(false);
  });

  test("both tools carry the source egress content class (fact text leaves the store)", () => {
    expect(MCP_HTTP_EGRESS_TOOLS.gno_recall).toBe("source");
    expect(MCP_HTTP_EGRESS_TOOLS.gno_remember).toBe("source");
  });

  test("live listing: gno_recall without the write flag, gno_remember only with it", async () => {
    const readOnly = await liveSurface(false);
    try {
      const names = (await readOnly.client.listTools()).tools.map(
        (tool) => tool.name
      );
      expect(names).toContain("gno_recall");
      expect(names).not.toContain("gno_remember");
    } finally {
      await readOnly.close();
    }

    const writable = await liveSurface(true);
    try {
      const listed = await writable.client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toContain("gno_recall");
      expect(names).toContain("gno_remember");
      const recall = listed.tools.find((tool) => tool.name === "gno_recall");
      expect(recall?.annotations?.readOnlyHint).toBe(true);
      expect(recall?.description).toContain("gno_remember");
      const remember = listed.tools.find(
        (tool) => tool.name === "gno_remember"
      );
      expect(remember?.annotations?.readOnlyHint).toBe(false);
      expect(remember?.description).toContain("decision=supersede");
    } finally {
      await writable.close();
    }
  });

  test("direct remember dispatch with writes disabled is refused", async () => {
    const result = await handleRemember(
      { text: "Finn prefers trams.", collection: "memory", scopes: SCOPES },
      toolContext(false)
    );
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe("WRITE_DISABLED");
  });
});

describe("gno_recall / gno_remember live loop", () => {
  let surface: LiveSurface;

  beforeAll(async () => {
    surface = await liveSurface(true);
  });

  afterAll(async () => {
    await surface.close();
  });

  test("empty recall returns the self-teaching hint and a receipt", async () => {
    const result = await surface.client.callTool({
      name: "gno_recall",
      arguments: { query: "trams", collection: "memory", scopes: SCOPES },
    });
    expect(result.isError).not.toBe(true);
    const payload = structured<RecallResult>(result);
    expect(payload.facts).toEqual([]);
    expect(payload.hint).toBe(MEMORY_EMPTY_RECALL_HINT);
    expect(payload.receipt.caller).toBe(CLIENT_NAME);
    expect(payload.receipt.session).toBe(SERVER_INSTANCE_ID);
  });

  test("remember(add) → recall returns the fact with cite + receipt; fence rejects replay", async () => {
    const before = contentMutations;
    const added = await surface.client.callTool({
      name: "gno_remember",
      arguments: {
        text: "Finn prefers trams over buses.",
        collection: "memory",
        scopes: SCOPES,
        decision: "add",
      },
    });
    expect(added.isError).not.toBe(true);
    const addedPayload = structured<RememberResult>(added);
    expect(addedPayload.outcome).toBe("added");
    if (addedPayload.outcome !== "added") throw new Error("unreachable");
    expect(addedPayload.sync.status).toBe("completed");
    expect(addedPayload.record.caller).toBe(CLIENT_NAME);
    expect(addedPayload.record.session).toBe(SERVER_INSTANCE_ID);
    expect(addedPayload.record.uri).toMatch(/^gno:\/\/memory\//);
    expect(contentMutations).toBe(before + 1);

    const recalled = await surface.client.callTool({
      name: "gno_recall",
      arguments: { query: "trams", collection: "memory", scopes: SCOPES },
    });
    expect(recalled.isError).not.toBe(true);
    const recallPayload = structured<RecallResult>(recalled);
    expect(recallPayload.facts).toHaveLength(1);
    const fact = recallPayload.facts[0];
    expect(fact?.uri).toBe(addedPayload.record.uri);
    expect(fact?.text).toBe("Finn prefers trams over buses.");

    expect(fact).toBeDefined();
    if (!fact) throw new Error("unreachable");
    expect(recallPayload.receipt.spanHashes).toContain(fact.spanHash);
    expect(recallPayload.budget.maxFacts).toBe(8);
    expect(recallPayload.budget.maxTokens).toBe(512);
    expect(recallPayload.hint).toBeUndefined();
    const text = (recalled.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toContain(`cite: ${addedPayload.record.uri}`);

    const replay = await surface.client.callTool({
      name: "gno_remember",
      arguments: {
        text: fact.text,
        collection: "memory",
        scopes: SCOPES,
        decision: "add",
        receipt: recallPayload.receipt,
      },
    });
    expect(replay.isError).toBe(true);
    expect(errorCode(replay)).toBe("MEMORY_FENCED_REPLAY");

    const derived = await surface.client.callTool({
      name: "gno_remember",
      arguments: {
        text: "Finn likes trams more than buses.",
        collection: "memory",
        scopes: SCOPES,
        decision: "add",
        derivedFrom: [addedPayload.record.uri],
      },
    });
    expect(derived.isError).toBe(true);
    expect(errorCode(derived)).toBe("MEMORY_FENCED_DERIVED");
  });

  test("exact duplicate returns the existing record without writing", async () => {
    const before = contentMutations;
    const result = await surface.client.callTool({
      name: "gno_remember",
      arguments: {
        text: "Finn prefers trams over buses.",
        collection: "memory",
        scopes: SCOPES,
        decision: "add",
      },
    });
    expect(result.isError).not.toBe(true);
    expect(structured<RememberResult>(result).outcome).toBe("existing");
    expect(contentMutations).toBe(before);
  });

  test("R4: unscoped calls fail validation; unmanaged collection is refused", async () => {
    const unscopedRecall = await surface.client.callTool({
      name: "gno_recall",
      arguments: { query: "trams", collection: "memory", scopes: [] },
    });
    expect(unscopedRecall.isError).toBe(true);
    const unscopedRemember = await surface.client.callTool({
      name: "gno_remember",
      arguments: { text: "Unscoped fact.", collection: "memory" },
    });
    expect(unscopedRemember.isError).toBe(true);

    const unmanaged = await surface.client.callTool({
      name: "gno_recall",
      arguments: { query: "trams", collection: "notes", scopes: SCOPES },
    });
    expect(unmanaged.isError).toBe(true);
    expect(errorCode(unmanaged)).toBe("MEMORY_COLLECTION_UNMANAGED");
    const unmanagedWrite = await surface.client.callTool({
      name: "gno_remember",
      arguments: {
        text: "Fact for notes.",
        collection: "notes",
        scopes: SCOPES,
        decision: "add",
      },
    });
    expect(unmanagedWrite.isError).toBe(true);
    expect(errorCode(unmanagedWrite)).toBe("MEMORY_COLLECTION_UNMANAGED");
  });
});

describe("memory tools never acquire ctx.writeLockPath themselves", () => {
  test("adapter sources import no lock primitives", async () => {
    for (const file of ["memory-recall.ts", "memory-remember.ts"]) {
      const source = await Bun.file(
        join(import.meta.dir, "../../src/mcp/tools", file)
      ).text();
      expect(source).not.toContain("file-lock");
      expect(source).not.toContain("withWriteLock");
      expect(source).not.toContain("acquireWriteLock");
      expect(source).not.toContain("write-lease");
    }
  });

  test("a concurrent external lease holder serialises with MCP remember via the core lease", async () => {
    const held = await acquireWriteLock(lockPath, 1_000);
    expect(held).not.toBeNull();
    if (!held) throw new Error("unreachable");
    const pending = handleRemember(
      {
        text: "Ivan prefers ferries.",
        collection: "memory",
        scopes: SCOPES,
        decision: "add",
      },
      toolContext(true)
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Bun.sleep(250);
    expect(settled).toBe(false);
    await held.release();
    const result = await pending;
    expect(result.isError).not.toBe(true);
    expect(structured<RememberResult>(result).outcome).toBe("added");

    const recalled = await handleRecall(
      { query: "ferries", collection: "memory", scopes: SCOPES },
      toolContext(false),
      { clientName: "  ", sessionId: "http-session-1" }
    );
    expect(recalled.isError).not.toBe(true);
    const payload = structured<RecallResult>(recalled);
    expect(payload.facts.map((fact) => fact.text)).toEqual([
      "Ivan prefers ferries.",
    ]);
    expect(payload.receipt.caller).toBe("mcp");
    expect(payload.receipt.session).toBe("http-session-1");
  });
});
