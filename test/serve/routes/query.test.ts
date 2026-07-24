import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChunkInput, DocumentRow } from "../../../src/store/types";

import { createDefaultConfig } from "../../../src/config/defaults";
import {
  handleAsk,
  handleQuery,
  handleQueryDiagnose,
  handleSearch,
} from "../../../src/serve/routes/api";
import { SqliteAdapter } from "../../../src/store";
import { safeRm } from "../../helpers/cleanup";
import { assertValid, loadSchema } from "../../spec/schemas/validator";

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
  expandPort: null,
  answerPort: null,
  rerankPort: null,
  capabilities: {
    bm25: true,
    vector: true,
    hybrid: true,
    answer: true,
  },
};

describe("POST /api/query", () => {
  test("ignores Ask-only verification controls without changing query", async () => {
    const req = new Request("http://localhost/api/query", {
      method: "POST",
      body: JSON.stringify({
        query: "performance",
        verify: "legacy-extra",
        contextBudgetTokens: "legacy-extra",
        maxAnswerTokens: "legacy-extra",
        noExpand: true,
        noRerank: true,
      }),
    });

    const res = await handleQuery(baseContext as never, req);
    expect(res.status).toBe(200);
  });

  test("accepts structured query documents in query text", async () => {
    const req = new Request("http://localhost/api/query", {
      method: "POST",
      body: JSON.stringify({
        query: "auth flow\nterm: JWT token\nintent: refresh token rotation",
        noExpand: true,
        noRerank: true,
      }),
    });

    const res = await handleQuery(baseContext as never, req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      meta: {
        query: string;
        queryModes?: { term: number; intent: number; hyde: boolean };
      };
    };
    expect(body.meta.query).toBe("auth flow");
    expect(body.meta.queryModes).toEqual({ term: 1, intent: 1, hyde: false });
  });

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

  test("keeps remote project hints zero-effect, private, and bounded", async () => {
    const makeRequest = (projectHints: string[]): Request =>
      new Request("http://localhost/api/query", {
        method: "POST",
        body: JSON.stringify({
          query: "performance",
          noExpand: true,
          noRerank: true,
          projectHints,
        }),
      });

    const baseline = await handleQuery(baseContext as never, makeRequest([]));
    const hinted = await handleQuery(
      baseContext as never,
      makeRequest([" private/rest-project "])
    );
    expect(hinted.status).toBe(200);
    expect(await hinted.json()).toEqual(await baseline.json());

    const malformed = await handleQuery(
      baseContext as never,
      makeRequest([" private/rest-project ", " "])
    );
    expect(malformed.status).toBe(400);
    const malformedBody = (await malformed.json()) as {
      error: { message: string };
    };
    expect(malformedBody.error.message).toContain(
      "must not contain empty values"
    );
    expect(malformedBody.error.message).not.toContain("private/rest-project");

    const tooMany = await handleQuery(
      baseContext as never,
      makeRequest(Array.from({ length: 17 }, (_, index) => `private-${index}`))
    );
    expect(tooMany.status).toBe(400);
    const tooManyBody = (await tooMany.json()) as {
      error: { message: string };
    };
    expect(tooManyBody.error.message).toContain("at most 16");
    expect(tooManyBody.error.message).not.toContain("private-0");
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

  test("rejects invalid structured query document prefixes", async () => {
    const req = new Request("http://localhost/api/query", {
      method: "POST",
      body: JSON.stringify({
        query: "term: JWT token\nvector: semantic expansion",
      }),
    });

    const res = await handleQuery(baseContext as never, req);
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain(
      "Unknown structured query line prefix"
    );
  });
});

describe("POST /api/query/diagnose", () => {
  let adapter: SqliteAdapter;
  let testDir: string;
  let counter = 0;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-rest-diagnose-test-"));
    adapter = new SqliteAdapter();
    const open = await adapter.open(join(testDir, "test.sqlite"), "unicode61");
    expect(open.ok).toBe(true);
    const sync = await adapter.syncCollections([
      {
        name: "notes",
        path: testDir,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ]);
    expect(sync.ok).toBe(true);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  async function setupDocument(
    relPath: string,
    markdown: string,
    chunks: ChunkInput[]
  ): Promise<DocumentRow> {
    counter += 1;
    const sourceHash = `${counter.toString(16).padStart(8, "0")}${"0".repeat(56)}`;
    const mirrorHash = `mirror-${counter}`;
    const upsert = await adapter.upsertDocument({
      collection: "notes",
      relPath,
      sourceHash,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: markdown.length,
      sourceMtime: "2026-01-01T00:00:00.000Z",
      mirrorHash,
      title: relPath,
    });
    expect(upsert.ok).toBe(true);
    await adapter.upsertContent(mirrorHash, markdown);
    await adapter.upsertChunks(mirrorHash, chunks);
    await adapter.rebuildFtsForHash(mirrorHash);
    const doc = await adapter.getDocument("notes", relPath);
    expect(doc.ok).toBe(true);
    if (!doc.ok || !doc.value) {
      throw new Error("document not created");
    }
    return doc.value;
  }

  test("returns schema-valid target diagnostics", async () => {
    const target = await setupDocument("alice.md", "Alice works at Acme", [
      {
        seq: 0,
        pos: 0,
        text: "Alice works at Acme",
        startLine: 1,
        endLine: 1,
      },
    ]);
    const ctx = {
      ...baseContext,
      store: adapter,
      config: createDefaultConfig(),
      capabilities: { bm25: true, vector: false, hybrid: false, answer: false },
    };
    const req = new Request("http://localhost/api/query/diagnose", {
      method: "POST",
      body: JSON.stringify({
        query: "Alice Acme",
        target: target.uri,
        noExpand: true,
        noRerank: true,
      }),
    });

    const res = await handleQueryDiagnose(ctx as never, req);
    expect(res.status).toBe(200);
    const body = await res.json();
    const schema = await loadSchema("query-diagnose");

    expect(assertValid(body, schema)).toBe(true);
    expect(body.schemaVersion).toBe("1.0");
    expect(body).not.toHaveProperty("affinity");
    expect(body.target.status).toBe("diagnosed");
    expect(body.meta.mode).toBe("bm25_only");

    const hintedRes = await handleQueryDiagnose(
      ctx as never,
      new Request("http://localhost/api/query/diagnose", {
        method: "POST",
        body: JSON.stringify({
          query: "Alice Acme",
          target: target.uri,
          noExpand: true,
          noRerank: true,
          projectHints: ["opaque/client-project"],
        }),
      })
    );
    expect(hintedRes.status).toBe(200);
    const hintedBody = await hintedRes.json();
    expect(hintedBody).toEqual(body);
    expect(JSON.stringify(hintedBody)).toBe(JSON.stringify(body));
    expect(JSON.stringify(hintedBody)).not.toContain("opaque/client-project");
  });

  test("rejects missing target", async () => {
    const req = new Request("http://localhost/api/query/diagnose", {
      method: "POST",
      body: JSON.stringify({ query: "Alice Acme" }),
    });

    const res = await handleQueryDiagnose(baseContext as never, req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("target");
  });

  test("rejects primitive JSON body", async () => {
    const req = new Request("http://localhost/api/query/diagnose", {
      method: "POST",
      body: JSON.stringify(null),
    });

    const res = await handleQueryDiagnose(baseContext as never, req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("object");
  });
});

describe("POST /api/ask", () => {
  test("rejects unknown fields without closing query or search", async () => {
    const ask = await handleAsk(
      baseContext as never,
      new Request("http://localhost/api/ask", {
        method: "POST",
        body: JSON.stringify({
          query: "performance",
          unknownControl: true,
        }),
      })
    );
    expect(ask.status).toBe(400);
    expect(
      ((await ask.json()) as { error: { message: string } }).error.message
    ).toContain("unknownControl");

    const query = await handleQuery(
      baseContext as never,
      new Request("http://localhost/api/query", {
        method: "POST",
        body: JSON.stringify({
          query: "performance",
          unknownControl: true,
          noExpand: true,
          noRerank: true,
        }),
      })
    );
    expect(query.status).toBe(200);

    const search = await handleSearch(
      baseContext as never,
      new Request("http://localhost/api/search", {
        method: "POST",
        body: JSON.stringify({
          query: "performance",
          unknownControl: true,
        }),
      })
    );
    expect(search.status).toBe(200);
  });

  test.each([
    ["verify", "true"],
    ["noExpand", "yes"],
    ["noRerank", "yes"],
    ["graph", 1],
    ["noGraph", 1],
    ["limit", 0],
    ["limit", 1.5],
    ["limit", "5"],
    ["candidateLimit", 0],
    ["candidateLimit", 1.5],
    ["candidateLimit", "5"],
    ["maxAnswerTokens", 0],
    ["maxAnswerTokens", 1.5],
    ["maxAnswerTokens", "512"],
    ["minScore", -0.1],
    ["minScore", 1.1],
    ["minScore", "0.5"],
    ["contextBudgetTokens", 0],
    ["contextBudgetTokens", 1.5],
    ["contextBudgetTokens", "100"],
    ["contextBudgetBytes", 0],
    ["contextBudgetBytes", 1.5],
    ["contextBudgetBytes", "100"],
  ] as const)("rejects invalid %s control %#", async (field, value) => {
    const req = new Request("http://localhost/api/ask", {
      method: "POST",
      body: JSON.stringify({ query: "performance", [field]: value }),
    });

    const res = await handleAsk(baseContext as never, req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.message).toContain(field);
  });

  test("rejects primitive JSON body", async () => {
    const req = new Request("http://localhost/api/ask", {
      method: "POST",
      body: JSON.stringify(null),
    });

    const res = await handleAsk(baseContext as never, req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("object");
  });

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

  test("accepts structured query documents in query text", async () => {
    const req = new Request("http://localhost/api/ask", {
      method: "POST",
      body: JSON.stringify({
        query: "term: web performance budgets\nintent: latency and vitals",
        noExpand: true,
        noRerank: true,
      }),
    });

    const res = await handleAsk(baseContext as never, req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      query: string;
      meta: {
        queryModes?: { term: number; intent: number; hyde: boolean };
      };
    };
    expect(body.query).toBe("web performance budgets");
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
