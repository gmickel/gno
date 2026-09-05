import { expect, test } from "bun:test";

import { handleSearch } from "../../src/serve/routes/api";
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
