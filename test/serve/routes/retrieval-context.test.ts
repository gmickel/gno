import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ToolContext } from "../../../src/mcp/server";
import type { SearchResults } from "../../../src/pipeline/types";

import { createDefaultConfig } from "../../../src/config/defaults";
import { handleSearch as handleMcpSearch } from "../../../src/mcp/tools/search";
import { handleSearch as handleRestSearch } from "../../../src/serve/routes/api";
import { SqliteAdapter } from "../../../src/store";

const EXPECTED_CONTEXT =
  "Global guidance\n\nNotes guidance\n\nSecurity guidance";

describe("retrieval context surface parity", () => {
  let store: SqliteAdapter;

  beforeEach(async () => {
    store = new SqliteAdapter();
    expect((await store.open(":memory:", "unicode61")).ok).toBe(true);
    expect(
      (
        await store.syncCollections([
          {
            name: "notes",
            path: "/tmp/notes",
            pattern: "**/*.md",
            include: [],
            exclude: [],
          },
        ])
      ).ok
    ).toBe(true);
    expect(
      (
        await store.syncContexts([
          { scopeType: "global", scopeKey: "/", text: "Global guidance" },
          {
            scopeType: "collection",
            scopeKey: "notes:",
            text: "Notes guidance",
          },
          {
            scopeType: "prefix",
            scopeKey: "gno://notes/security",
            text: "Security guidance",
          },
        ])
      ).ok
    ).toBe(true);

    const markdown = "# Authentication\nJWT token rotation policy.";
    expect(
      (
        await store.upsertDocument({
          collection: "notes",
          relPath: "security/authentication.md",
          sourceHash: "a".repeat(64),
          sourceMime: "text/markdown",
          sourceExt: ".md",
          sourceSize: markdown.length,
          sourceMtime: "2026-07-22T00:00:00.000Z",
          mirrorHash: "retrieval-context-surface",
          title: "Authentication",
        })
      ).ok
    ).toBe(true);
    expect(
      (await store.upsertContent("retrieval-context-surface", markdown)).ok
    ).toBe(true);
    expect(
      (
        await store.upsertChunks("retrieval-context-surface", [
          {
            seq: 0,
            pos: 0,
            text: "JWT token rotation policy.",
            startLine: 2,
            endLine: 2,
          },
        ])
      ).ok
    ).toBe(true);
    expect(
      (await store.rebuildFtsForHash("retrieval-context-surface")).ok
    ).toBe(true);
  });

  afterEach(async () => {
    await store.close();
  });

  test("REST and MCP expose identical context and source identity", async () => {
    const restResponse = await handleRestSearch(
      store,
      new Request("http://localhost/api/search", {
        method: "POST",
        body: JSON.stringify({ query: "JWT token", limit: 5 }),
      })
    );
    expect(restResponse.status).toBe(200);
    const rest = (await restResponse.json()) as SearchResults;

    const config = createDefaultConfig();
    const collections = [
      {
        name: "notes",
        path: "/tmp/notes",
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ];
    config.collections = collections;
    const mcpResponse = await handleMcpSearch(
      { query: "JWT token", limit: 5 },
      {
        store,
        config,
        collections,
        isShuttingDown: () => false,
        toolMutex: {
          acquire: async () => () => undefined,
        } as ToolContext["toolMutex"],
      } as unknown as ToolContext
    );
    const mcp = mcpResponse.structuredContent as unknown as SearchResults;

    expect(rest.results).toHaveLength(1);
    expect(mcp.results).toHaveLength(1);
    const expected = {
      docid: rest.results[0]?.docid,
      uri: "gno://notes/security/authentication.md",
      context: EXPECTED_CONTEXT,
    };
    expect(rest.results[0]).toMatchObject(expected);
    expect(mcp.results[0]).toMatchObject(expected);
  });
});
