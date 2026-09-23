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
