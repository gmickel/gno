import { describe, expect, test } from "bun:test";

import { handleAsk, handleQuery } from "../../../src/serve/routes/api";

const mockStore = {
  searchFts: async () => ({ ok: true as const, value: [] }),
  getDocumentsByMirrorHashes: async () => ({ ok: true as const, value: [] }),
  getCollections: async () => ({ ok: true as const, value: [] }),
  getChunksBatch: async () => ({ ok: true as const, value: new Map() }),
  getTagsBatch: async () => ({ ok: true as const, value: new Map() }),
  getContent: async () => ({ ok: true as const, value: null }),
};

const baseContext = {
  store: mockStore,
  config: {
    version: "1.0",
    ftsTokenizer: "unicode61",
    collections: [],
    contexts: [],
  },
  vectorIndex: null,
  embedPort: null,
  genPort: null,
  rerankPort: null,
  capabilities: {
    bm25: true,
    vector: true,
    hybrid: true,
    answer: true,
  },
};

describe("POST /api/query", () => {
  test("rejects non-string exclude", async () => {
    const req = new Request("http://localhost/api/query", {
      method: "POST",
      body: JSON.stringify({
        query: "performance",
        exclude: 123,
      }),
    });

    const res = await handleQuery(baseContext as never, req);
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("exclude");
  });

  test("rejects candidateLimit below 1", async () => {
    const req = new Request("http://localhost/api/query", {
      method: "POST",
      body: JSON.stringify({
        query: "performance",
        candidateLimit: 0,
      }),
    });

    const res = await handleQuery(baseContext as never, req);
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("candidateLimit");
  });

  test("rejects multiple hyde queryModes", async () => {
    const req = new Request("http://localhost/api/query", {
      method: "POST",
      body: JSON.stringify({
        query: "performance",
        queryModes: [
          { mode: "hyde", text: "first" },
          { mode: "hyde", text: "second" },
        ],
      }),
    });

    const res = await handleQuery(baseContext as never, req);
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Only one hyde");
  });
});

describe("POST /api/ask", () => {
  test("rejects non-string exclude", async () => {
    const req = new Request("http://localhost/api/ask", {
      method: "POST",
      body: JSON.stringify({
        query: "performance",
        exclude: ["reviews"],
      }),
    });

    const res = await handleAsk(baseContext as never, req);
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("exclude");
  });

  test("accepts valid queryModes and passes them into retrieval", async () => {
    const req = new Request("http://localhost/api/ask", {
      method: "POST",
      body: JSON.stringify({
        query: "performance",
        queryModes: [
          { mode: "term", text: "web performance" },
          { mode: "intent", text: "latency budgets" },
        ],
      }),
    });

    const res = await handleAsk(baseContext as never, req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      meta: {
        expanded: boolean;
        queryModes?: { term: number; intent: number; hyde: boolean };
      };
    };
    expect(body.meta.expanded).toBe(true);
    expect(body.meta.queryModes).toEqual({ term: 1, intent: 1, hyde: false });
  });

  test("rejects multiple hyde queryModes", async () => {
    const req = new Request("http://localhost/api/ask", {
      method: "POST",
      body: JSON.stringify({
        query: "performance",
        queryModes: [
          { mode: "hyde", text: "first" },
          { mode: "hyde", text: "second" },
        ],
      }),
    });

    const res = await handleAsk(baseContext as never, req);
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Only one hyde");
  });
});
