import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises only supplies temporary-directory structure operations.
import { mkdtemp } from "node:fs/promises";
// node:os/node:path have no Bun utility equivalents.
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../../src/config/types";
import type { ServerContext } from "../../../src/serve/context";

import { createDefaultConfig } from "../../../src/config/defaults";
import { handleContextBuild } from "../../../src/serve/context-capsule";
import { RETRIEVAL_TRACE_HEADER } from "../../../src/serve/retrieval-trace";
import {
  handleAsk,
  handleDoc,
  handleQuery,
  handleSearch,
} from "../../../src/serve/routes/api";
import { SqliteAdapter } from "../../../src/store";
import { safeRm } from "../../helpers/cleanup";

const hash = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

const enabledTraceConfig = (): Config => {
  const config = createDefaultConfig();
  config.collections = [
    {
      name: "notes",
      path: "/tmp/notes",
      pattern: "**/*.md",
      include: [],
      exclude: [],
    },
  ];
  config.retrievalTraces = {
    enabled: true,
    redactionMode: "replay",
    retention: {
      maxAgeDays: 30,
      maxTraces: 100,
      maxRecordsPerTrace: 1_000,
      maxBytes: 16 * 1024 * 1024,
    },
  };
  return config;
};

const serverContext = (
  store: SqliteAdapter,
  config: Config
): ServerContext => ({
  store,
  config,
  indexName: "default",
  vectorIndex: null,
  embedPort: null,
  expandPort: null,
  answerPort: null,
  rerankPort: null,
  capabilities: {
    bm25: true,
    vector: false,
    hybrid: false,
    answer: false,
  },
});

describe("REST retrieval trace transport", () => {
  let store: SqliteAdapter;
  let config: Config;
  let root: string;
  const markdown = "# Authentication\nJWT token rotation policy.";
  const mirrorHash = hash(markdown);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-rest-trace-"));
    store = new SqliteAdapter();
    expect(
      (await store.open(join(root, "index-default.sqlite"), "unicode61")).ok
    ).toBe(true);
    config = enabledTraceConfig();
    expect((await store.syncCollections(config.collections)).ok).toBe(true);
    expect(
      (
        await store.upsertDocument({
          collection: "notes",
          relPath: "security/authentication.md",
          sourceHash: hash("source:authentication"),
          sourceMime: "text/markdown",
          sourceExt: ".md",
          sourceSize: markdown.length,
          sourceMtime: "2026-07-23T00:00:00.000Z",
          mirrorHash,
          title: "Authentication",
        })
      ).ok
    ).toBe(true);
    expect((await store.upsertContent(mirrorHash, markdown)).ok).toBe(true);
    expect(
      (
        await store.upsertChunks(mirrorHash, [
          {
            seq: 0,
            pos: 0,
            text: markdown,
            startLine: 1,
            endLine: 2,
          },
        ])
      ).ok
    ).toBe(true);
    expect((await store.rebuildFtsForHash(mirrorHash)).ok).toBe(true);
  });

  afterEach(async () => {
    await store.close();
    await safeRm(root);
  });

  test("keeps bodies stable, emits a header, and resumes get/open evidence", async () => {
    const requestBody = JSON.stringify({ query: "JWT token", limit: 5 });
    const disabledConfig: Config = {
      ...config,
      retrievalTraces: { enabled: false },
    };
    const disabled = await handleSearch(
      serverContext(store, disabledConfig),
      new Request("http://localhost/api/search", {
        method: "POST",
        body: requestBody,
      })
    );
    const disabledBody = await disabled.text();
    expect(disabled.headers.get(RETRIEVAL_TRACE_HEADER)).toBeNull();
    const disabledTraces = await store.listRetrievalTraces(10);
    expect(disabledTraces.ok).toBe(true);
    if (!disabledTraces.ok) throw new Error(disabledTraces.error.message);
    expect(disabledTraces.value).toHaveLength(0);

    const enabled = await handleSearch(
      serverContext(store, config),
      new Request("http://localhost/api/search", {
        method: "POST",
        body: requestBody,
      })
    );
    const traceId = enabled.headers.get(RETRIEVAL_TRACE_HEADER);
    expect(traceId).toBeTruthy();
    expect(await enabled.text()).toBe(disabledBody);
    expect(disabledBody).not.toContain(traceId ?? "missing-trace");

    const afterSearch = await store.getRetrievalTrace(traceId!);
    expect(afterSearch.ok && afterSearch.value?.trace.status).toBe("open");
    expect(
      afterSearch.ok ? afterSearch.value?.events.map((event) => event.kind) : []
    ).toContain("retrieval");

    const doc = await handleDoc(
      store,
      config,
      new URL(
        "http://localhost/api/doc?uri=gno://notes/security/authentication.md"
      ),
      new Request(
        "http://localhost/api/doc?uri=gno://notes/security/authentication.md",
        { headers: { [RETRIEVAL_TRACE_HEADER]: traceId! } }
      )
    );
    const docBody = await doc.text();
    if (doc.status !== 200) throw new Error(docBody);
    expect({ body: docBody, status: doc.status }).toMatchObject({
      status: 200,
    });
    expect(doc.headers.get(RETRIEVAL_TRACE_HEADER)).toBe(traceId);
    expect(JSON.parse(docBody) as { content: string }).toMatchObject({
      content: markdown,
    });

    const afterDoc = await store.getRetrievalTrace(traceId!);
    const eventKinds =
      afterDoc.ok && afterDoc.value
        ? afterDoc.value.events.map((event) => event.kind)
        : [];
    expect(eventKinds).toContain("get");
    expect(eventKinds).toContain("open");
  });

  test("keeps canonical Context bytes deterministic across traced requests", async () => {
    config.collections.push({
      name: "archive",
      path: "/tmp/archive",
      pattern: "**/*.md",
      include: [],
      exclude: [],
    });
    expect((await store.syncCollections(config.collections)).ok).toBeTrue();
    const body = JSON.stringify({
      goal: "Find the JWT token rotation policy",
      query: "JWT token",
      collections: ["notes", "archive"],
      budgetTokens: 12_000,
      depthPolicy: "fast",
    });
    const first = await handleContextBuild(
      serverContext(store, config),
      new Request("http://localhost/api/context", {
        method: "POST",
        body,
      })
    );
    const second = await handleContextBuild(
      serverContext(store, config),
      new Request("http://localhost/api/context", {
        method: "POST",
        body,
      })
    );
    const firstTrace = first.headers.get(RETRIEVAL_TRACE_HEADER);
    const secondTrace = second.headers.get(RETRIEVAL_TRACE_HEADER);
    const firstBody = await first.text();
    const secondBody = await second.text();
    if (first.status !== 200) throw new Error(firstBody);
    if (second.status !== 200) throw new Error(secondBody);
    expect({ body: firstBody, status: first.status }).toMatchObject({
      status: 200,
    });
    expect({ body: secondBody, status: second.status }).toMatchObject({
      status: 200,
    });
    expect(firstTrace).toBeTruthy();
    expect(secondTrace).toBeTruthy();
    expect(secondTrace).not.toBe(firstTrace);
    expect(secondBody).toBe(firstBody);

    const firstStored = await store.getRetrievalTrace(firstTrace!);
    const secondStored = await store.getRetrievalTrace(secondTrace!);
    expect(firstStored.ok && firstStored.value?.trace.status).toBe("completed");
    expect(secondStored.ok && secondStored.value?.trace.status).toBe(
      "completed"
    );
    expect(firstStored.ok && firstStored.value?.trace.filters).toMatchObject({
      collections: ["archive", "notes"],
    });
  });

  test("returns hybrid query identity only in the response header", async () => {
    const response = await handleQuery(
      serverContext(store, config),
      new Request("http://localhost/api/query", {
        method: "POST",
        body: JSON.stringify({
          query: "JWT token",
          noExpand: true,
          noRerank: true,
        }),
      })
    );
    const traceId = response.headers.get(RETRIEVAL_TRACE_HEADER);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(traceId).toBeTruthy();
    expect(body).not.toContain(traceId!);
    const stored = await store.getRetrievalTrace(traceId!);
    expect(stored.ok && stored.value?.trace.status).toBe("open");
    expect(
      stored.ok && stored.value
        ? stored.value.events.map((event) => event.kind)
        : []
    ).toContain("retrieval");
  });

  test("finalizes Ask with cited-only evidence and capability outcomes", async () => {
    const context = serverContext(store, config);
    context.answerPort = {
      modelUri: "test:answer",
      generate: async () => ({ ok: true, value: "Rotate JWT tokens [1]." }),
      dispose: async () => undefined,
    };
    context.capabilities.answer = true;

    const response = await handleAsk(
      context,
      new Request("http://localhost/api/ask", {
        method: "POST",
        body: JSON.stringify({
          query: "JWT token",
          noExpand: true,
          noRerank: true,
        }),
      })
    );
    const traceId = response.headers.get(RETRIEVAL_TRACE_HEADER);
    expect(response.status).toBe(200);
    expect(traceId).toBeTruthy();
    const body = (await response.json()) as {
      answer?: string;
      citations?: unknown[];
    };
    expect(body.answer).toBe("Rotate JWT tokens [1].");
    expect(body.citations).toHaveLength(1);

    const stored = await store.getRetrievalTrace(traceId!);
    expect(stored.ok && stored.value?.trace.status).toBe("completed");
    const events = stored.ok && stored.value ? stored.value.events : [];
    expect(events.map((event) => event.kind)).toContain("cite");
    expect(
      events
        .filter(
          (event) =>
            event.kind === "capability" &&
            event.payload.capability === "answer_generation"
        )
        .map((event) => event.payload.status)
    ).toEqual(["attempted", "used"]);
  });
});
