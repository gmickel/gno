import { expect, test } from "bun:test";

import type { ServerContext } from "../../src/serve/context";

import {
  handleSearch,
  handleQuery,
  handleQueryDiagnose,
  handleAsk,
} from "../../src/serve/routes/api";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";

test("lexical input failures return validation 400 while store failures remain runtime 500", async () => {
  const store = new SqliteAdapter();
  expect((await store.open(":memory:", "unicode61")).ok).toBe(true);
  const request = (query: string): Request =>
    new Request("http://localhost/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
  try {
    const invalid = await handleSearch(store, request('"unterminated'));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: {
        code: "VALIDATION",
        message: expect.stringContaining("unmatched double quote"),
      },
    });
    await store.close();
    const failed = await handleSearch(store, request("needle"));
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ error: { code: "RUNTIME" } });
  } finally {
    await store.close();
  }
});

test("REST retrieval rejects invalid typed filters with a stable field path before storage or models", async () => {
  const store = new SqliteAdapter();
  const ctx = { store } as ServerContext;
  for (const [index, handler] of [
    (req: Request) => handleSearch(store, req),
    (req: Request) => handleQuery(ctx, req),
    (req: Request) => handleQueryDiagnose(ctx, req),
    (req: Request) => handleAsk(ctx, req),
  ].entries()) {
    const response = await handler(
      new Request("http://localhost/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "needle",
          ...(index === 2 ? { target: "gno://notes/needle.md" } : {}),
          filter: { op: "gte", key: "confidence", value: "0.8" },
        }),
      })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "VALIDATION",
        message: expect.stringContaining("filter"),
        details: { field: expect.stringContaining("filter") },
      },
    });
  }
});

test("REST search and query validate the collections allowlist before retrieval", async () => {
  const store = new SqliteAdapter();
  expect((await store.open(":memory:", "unicode61")).ok).toBe(true);
  const collections = ["alpha", "beta"].map((name) => ({
    name,
    path: `/tmp/${name}`,
    pattern: "**/*.md",
    include: [],
    exclude: [],
  }));
  expect((await store.syncCollections(collections)).ok).toBe(true);
  const ctx = {
    store,
    config: {
      version: "1.0",
      ftsTokenizer: "unicode61",
      collections,
      contexts: [],
    },
  } as unknown as ServerContext;
  const post = (body: Record<string, unknown>) =>
    new Request("http://localhost/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "needle", ...body }),
    });
  try {
    for (const handler of [
      (req: Request) => handleSearch(store, req),
      (req: Request) => handleSearch(ctx, req),
      (req: Request) => handleQuery(ctx, req),
    ]) {
      const both = await handler(
        post({ collection: "alpha", collections: ["beta"] })
      );
      expect(both.status).toBe(400);
      expect(await both.json()).toMatchObject({
        error: {
          code: "VALIDATION",
          message: "Pass either collection or collections, not both",
        },
      });
      for (const collectionsInput of [[], "alpha", [1]]) {
        const invalid = await handler(post({ collections: collectionsInput }));
        expect(invalid.status).toBe(400);
      }
      const unknown = await handler(post({ collections: ["alpha", "nope"] }));
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toMatchObject({
        error: { code: "NOT_FOUND", message: "Collection not found: nope" },
      });
    }
    const served = await handleSearch(
      store,
      post({ collections: ["Beta", "alpha"] })
    );
    expect(served.status).toBe(200);
    expect(
      ((await served.json()) as { meta: { collections: string[] } }).meta
        .collections
    ).toEqual(["alpha", "beta"]);
  } finally {
    await store.close();
  }
});
