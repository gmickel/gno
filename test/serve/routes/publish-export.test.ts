import { describe, expect, test } from "bun:test";

import { handlePublishExport } from "../../../src/serve/routes/api";

const config = {
  version: "1.0",
  ftsTokenizer: "unicode61",
  collections: [],
  contexts: [],
};

const store = {} as never;

describe("POST /api/publish/export", () => {
  test("rejects invalid visibility values", async () => {
    const req = new Request("http://localhost/api/publish/export", {
      method: "POST",
      body: JSON.stringify({
        target: "atlas",
        visibility: "friends-only",
      }),
    });

    const res = await handlePublishExport(config as never, store, req);
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("visibility");
  });
});
