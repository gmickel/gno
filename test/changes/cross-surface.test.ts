import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "../../src/mcp/server";
import type { GnoClient } from "../../src/sdk/types";
import type { DocumentInput } from "../../src/store/types";

import {
  changesRead,
  diffRead,
  impactRead,
} from "../../src/cli/commands/changes";
import { createDefaultConfig } from "../../src/config";
import {
  handleChanges as handleMcpChanges,
  handleDiff as handleMcpDiff,
  handleImpact as handleMcpImpact,
} from "../../src/mcp/tools/changes";
import { createGnoClient } from "../../src/sdk/client";
import {
  handleChanges as handleRestChanges,
  handleDiff as handleRestDiff,
  handleImpact as handleRestImpact,
} from "../../src/serve/routes/changes";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";
import { assertValid, loadSchema } from "../spec/schemas/validator";

const hash = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

describe("knowledge delta cross-surface parity", () => {
  let directory = "";
  let dbPath = "";
  let store: SqliteAdapter;
  let client: GnoClient | null = null;
  const config = createDefaultConfig();

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "gno-delta-parity-"));
    dbPath = join(directory, "index.sqlite");
    config.ftsTokenizer = "porter";
    config.collections = [
      {
        name: "notes",
        path: directory,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ];
    store = new SqliteAdapter();
    expect((await store.open(dbPath, "porter")).ok).toBe(true);
    expect((await store.syncCollections(config.collections)).ok).toBe(true);
  });

  afterEach(async () => {
    await client?.close();
    await store.close();
    await safeRm(directory);
  });

  async function create(
    relPath: string,
    observedAtMs: number
  ): Promise<number> {
    const input: DocumentInput = {
      collection: "notes",
      relPath,
      sourceHash: hash(`source-${relPath}`),
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: 10,
      sourceMtime: new Date(observedAtMs).toISOString(),
      mirrorHash: hash(`mirror-${relPath}`),
      title: relPath,
      changeJournal: {
        observedAtMs,
        structureDelta: {
          headings: { added: [`# ${relPath}`], removed: [] },
        },
      },
    };
    const created = await store.upsertDocument(input);
    if (!created.ok) throw new Error(created.error.message);
    return created.value.id;
  }

  function context(): ToolContext {
    return {
      indexName: "default",
      store,
      config,
      collections: config.collections,
      actualConfigPath: join(directory, "config.yml"),
      toolMutex: {
        acquire: async () => () => {},
      },
      jobManager: {} as ToolContext["jobManager"],
      serverInstanceId: "test",
      writeLockPath: join(directory, ".lock"),
      enableWrite: false,
      isShuttingDown: () => false,
    };
  }

  test("changes, diff, and impact agree across CLI, REST, MCP, and SDK", async () => {
    const rootId = await create("root.md", 1000);
    const sourceId = await create("source.md", 2000);
    expect(
      (
        await store.setDocEdges(
          sourceId,
          [
            {
              targetDocId: rootId,
              edgeType: "mentions",
              confidence: "parsed",
            },
          ],
          "wikilink"
        )
      ).ok
    ).toBe(true);
    client = await createGnoClient({
      config,
      dbPath,
      downloadPolicy: { offline: true, allowDownload: false },
    });

    const changeInput = { limit: 100 };
    const cliChanges = await changesRead(store, changeInput);
    expect(cliChanges.success).toBe(true);
    if (!cliChanges.success) return;
    const restChanges = await (
      await handleRestChanges(
        store,
        new URL("http://localhost/api/changes?limit=100")
      )
    ).json();
    const mcpChanges = await handleMcpChanges(changeInput, context());
    const sdkChanges = await client.changes(changeInput);
    expect(restChanges).toEqual(cliChanges.data);
    expect(mcpChanges.structuredContent as unknown).toEqual(cliChanges.data);
    expect(sdkChanges).toEqual(cliChanges.data);
    expect(assertValid(cliChanges.data, await loadSchema("changes"))).toBe(
      true
    );

    const ref = "gno://notes/root.md";
    const cliDiff = await diffRead(store, ref);
    expect(cliDiff.success).toBe(true);
    if (!cliDiff.success) return;
    const restDiff = await (
      await handleRestDiff(
        store,
        new URL(`http://localhost/api/diff?ref=${encodeURIComponent(ref)}`)
      )
    ).json();
    const mcpDiff = await handleMcpDiff({ ref }, context());
    const sdkDiff = await client.diff(ref);
    expect(restDiff).toEqual(cliDiff.data);
    expect(mcpDiff.structuredContent as unknown).toEqual(cliDiff.data);
    expect(sdkDiff).toEqual(cliDiff.data);
    expect(assertValid(cliDiff.data, await loadSchema("document-diff"))).toBe(
      true
    );

    const impactInput = {
      maxDepth: 3,
      maxNodes: 100,
      maxEdges: 250,
      frontierLimit: 100,
      visitedLimit: 500,
    };
    const cliImpact = await impactRead(store, ref, impactInput);
    expect(cliImpact.success).toBe(true);
    if (!cliImpact.success) return;
    const restImpact = await (
      await handleRestImpact(
        store,
        new URL(
          `http://localhost/api/impact?ref=${encodeURIComponent(ref)}&maxDepth=3&maxNodes=100&maxEdges=250&frontierLimit=100&visitedLimit=500`
        )
      )
    ).json();
    const mcpImpact = await handleMcpImpact({ ref, ...impactInput }, context());
    const sdkImpact = await client.impact(ref, impactInput);
    expect(restImpact).toEqual(cliImpact.data);
    expect(mcpImpact.structuredContent as unknown).toEqual(cliImpact.data);
    expect(sdkImpact).toEqual(cliImpact.data);
    expect(assertValid(cliImpact.data, await loadSchema("impact"))).toBe(true);
  });
});
