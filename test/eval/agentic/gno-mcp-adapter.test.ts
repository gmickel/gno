import { describe, expect, test } from "bun:test";

import type { AdapterPreparation } from "../../../evals/agentic/adapter";
import type {
  GnoMcpCallResult,
  GnoMcpConnection,
  GnoMcpPreparedHandle,
  GnoMcpProductTool,
} from "../../../evals/agentic/lifecycle/gno-mcp";

import {
  GnoMcpAdapter,
  mapCanonicalGnoMcpCall,
} from "../../../evals/agentic/adapters/gno-mcp";
import { canonicalFingerprint } from "../../../evals/agentic/canonical";
import { loadAgenticFixture } from "../../../evals/agentic/fixture-db";
import {
  validateGnoModelLock,
  validateGnoProductTools,
} from "../../../evals/agentic/lifecycle/gno-mcp";

const PRODUCT_TOOLS: GnoMcpProductTool[] = [
  {
    name: "gno_query",
    inputSchema: {
      type: "object",
      properties: {
        query: {},
        collection: {},
        limit: {},
        minScore: {},
        lang: {},
        intent: {},
        candidateLimit: {},
        exclude: {},
        since: {},
        until: {},
        categories: {},
        author: {},
        fast: {},
        thorough: {},
        expand: {},
        rerank: {},
        graph: {},
        tagsAll: {},
        tagsAny: {},
        queryModes: {},
      },
    },
  },
  {
    name: "gno_get",
    inputSchema: {
      type: "object",
      properties: { ref: {}, fromLine: {}, lineCount: {}, lineNumbers: {} },
    },
  },
  {
    name: "gno_multi_get",
    inputSchema: {
      type: "object",
      properties: { refs: {}, maxBytes: {}, lineNumbers: {} },
    },
  },
];

interface FakeConnectionState {
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  closes: number;
}

const fakeConnection = (
  state: FakeConnectionState,
  responses: GnoMcpCallResult[]
): GnoMcpConnection => ({
  pid: 42,
  serverName: "gno",
  serverVersion: "1.15.0",
  async listTools() {
    return structuredClone(PRODUCT_TOOLS);
  },
  async callTool(name, arguments_) {
    state.calls.push({ name, arguments: structuredClone(arguments_) });
    const response = responses.shift();
    if (!response) throw new Error("No fake MCP response queued");
    return response;
  },
  async close() {
    state.closes += 1;
  },
});

const fakeHandle = async (): Promise<{
  handle: GnoMcpPreparedHandle;
  taskId: string;
}> => {
  const fixture = await loadAgenticFixture();
  const taskId = "t0a1b2c3";
  return {
    taskId,
    handle: {
      snapshot: fixture.snapshot,
      native: {
        taskIds: [taskId],
        corpusFingerprint: fixture.snapshot.fingerprint,
        indexFingerprint: canonicalFingerprint({
          fixture: fixture.snapshot.fingerprint,
        }),
        dbPath: "/tmp/agentic.sqlite",
        rootPath: "/tmp/gno-agentic",
        documentCount: fixture.snapshot.files.length,
        collectionCount: 1,
        observations: { preparationMs: 1, filesProcessed: 1, filesErrored: 0 },
      },
      configPath: "/tmp/gno-agentic/index.yml",
      configDir: "/tmp/gno-agentic/config",
      dataDir: "/tmp/gno-agentic/data",
      cacheDir: "/tmp/gno-agentic/cache",
      indexName: "agentic",
      models: {} as GnoMcpPreparedHandle["models"],
      productToolsFingerprint: validateGnoProductTools(PRODUCT_TOOLS),
      environment: {},
    },
  };
};

const queryResponse = (input: {
  uri: string;
  sourceHash: string;
  snippet: string;
  startLine: number;
  endLine: number;
}): GnoMcpCallResult => ({
  structuredContent: {
    results: [
      {
        uri: `${input.uri}?index=agentic`,
        docid: "abc123",
        title: "Incident",
        score: 0.91,
        snippet: input.snippet,
        snippetRange: { startLine: input.startLine, endLine: input.endLine },
        source: {
          relPath: input.uri.split("/").slice(3).join("/"),
          mime: "text/markdown",
          ext: ".md",
          sourceHash: input.sourceHash,
          absPath: "/volatile/path",
        },
      },
    ],
    meta: {
      query: "north gateway",
      mode: "hybrid",
      expanded: false,
      reranked: false,
      vectorsUsed: true,
      totalResults: 1,
    },
  },
});

describe("GNO MCP agentic adapter", () => {
  test("maps the normalized contract to shipped MCP names and schemas", () => {
    expect(
      mapCanonicalGnoMcpCall("search", {
        query: "needle",
        collection: "c001",
        filters: { since: "2026-01-01" },
      })
    ).toEqual({
      name: "gno_query",
      arguments: {
        query: "needle",
        collection: "c001",
        since: "2026-01-01",
      },
    });
    expect(
      mapCanonicalGnoMcpCall("get", {
        uri: "gno://c001/incident.md",
        fromLine: 3,
        lineCount: 2,
      })
    ).toEqual({
      name: "gno_get",
      arguments: {
        ref: "gno://c001/incident.md",
        fromLine: 3,
        lineCount: 2,
        lineNumbers: false,
      },
    });
    expect(
      mapCanonicalGnoMcpCall("multi_get", {
        uris: ["gno://c001/incident.md"],
        maxBytes: 4096,
      })
    ).toEqual({
      name: "gno_multi_get",
      arguments: {
        refs: ["gno://c001/incident.md"],
        maxBytes: 4096,
        lineNumbers: false,
      },
    });
  });

  test("fails closed when a shipped MCP schema loses a mapped field", () => {
    const incompatible = structuredClone(PRODUCT_TOOLS);
    const query = incompatible.find((tool) => tool.name === "gno_query");
    if (!query) throw new Error("fixture query tool missing");
    delete (query.inputSchema.properties as Record<string, unknown>).queryModes;
    expect(() => validateGnoProductTools(incompatible)).toThrow(
      "gno_query is missing or incompatible"
    );
  });

  test("rejects model identity drift and cache path traversal", async () => {
    const lockPath = new URL(
      "../../../evals/fixtures/agentic-retrieval/gno-models.lock.json",
      import.meta.url
    );
    const lock = JSON.parse(await Bun.file(lockPath).text()) as {
      models: Array<{ role: string; uri: string; cacheFile: string }>;
    };
    const identityDrift = structuredClone(lock);
    const embed = identityDrift.models.find((model) => model.role === "embed");
    if (!embed) throw new Error("embed lock fixture missing");
    embed.uri = "hf:placeholder/placeholder/model.gguf";
    expect(() => validateGnoModelLock(identityDrift)).toThrow(
      "exact benchmark model identities"
    );

    const traversal = structuredClone(lock);
    const traversalEmbed = traversal.models.find(
      (model) => model.role === "embed"
    );
    if (!traversalEmbed) throw new Error("embed lock fixture missing");
    traversalEmbed.cacheFile = "../model.gguf";
    expect(() => validateGnoModelLock(traversal)).toThrow(
      "invalid or duplicate entry"
    );
  });

  test("normalizes exact search and repeated source reads without volatile paths", async () => {
    const fixture = await loadAgenticFixture();
    const task = fixture.tasks.get("t0a1b2c3");
    if (!task) throw new Error("fixture task missing");
    const source = fixture.snapshot.files.find(
      (file) => file.taskId === task.taskId && file.collection === "c001"
    );
    if (!source) throw new Error("fixture source missing");
    const taskSources = fixture.snapshot.files.filter(
      (file) => file.taskId === task.taskId && file.collection === "c001"
    );
    const lines = source.content.split("\n");
    const evidenceLine = lines.findIndex((line) => line.includes("INC-"));
    expect(evidenceLine).toBeGreaterThanOrEqual(0);
    const response = queryResponse({
      uri: `gno://${source.collection}/${source.relPath}`,
      sourceHash: source.sourceHash,
      snippet: lines[evidenceLine] ?? "",
      startLine: evidenceLine + 1,
      endLine: evidenceLine + 1,
    });
    const state: FakeConnectionState = { calls: [], closes: 0 };
    const { handle } = await fakeHandle();
    const adapter = new GnoMcpAdapter({
      prepareHandle: async () => handle,
      cleanupHandle: async () => undefined,
      connectionFactory: async () =>
        fakeConnection(state, [
          response,
          response,
          {
            structuredContent: {
              docid: "abc123",
              uri: `gno://${source.collection}/${source.relPath}?index=agentic`,
              content: lines[evidenceLine] ?? "",
              totalLines: lines.length,
              returnedLines: { start: evidenceLine + 1, end: evidenceLine + 1 },
              source: {
                relPath: source.relPath,
                mime: "text/markdown",
                ext: ".md",
                sourceHash: source.sourceHash,
                absPath: "/different/path",
              },
            },
          },
          {
            structuredContent: {
              documents: taskSources.map((file) => ({
                docid: `fixture-${file.relPath}`,
                uri: `gno://${file.collection}/${file.relPath}?index=agentic`,
                content: file.content,
                totalLines: file.content.split("\n").length,
                truncated: false,
                source: {
                  relPath: file.relPath,
                  mime: "text/markdown",
                  ext: ".md",
                },
              })),
              skipped: [],
              meta: {
                requested: taskSources.length,
                returned: taskSources.length,
                skipped: 0,
              },
            },
          },
        ]),
      now: (() => {
        let tick = 0;
        return () => ++tick;
      })(),
    });
    await adapter.prepare({
      snapshot: fixture.snapshot,
      prepared: null,
      signal: new AbortController().signal,
    });
    await adapter.reset({
      task,
      lifecycle: "warm",
      readinessProbe: true,
      signal: new AbortController().signal,
    });
    const first = await adapter.callTool(
      "search",
      { query: "north gateway", collection: "c001" },
      new AbortController().signal
    );
    const second = await adapter.callTool(
      "get",
      {
        uri: `gno://${source.collection}/${source.relPath}`,
        fromLine: evidenceLine + 1,
        lineCount: 1,
      },
      new AbortController().signal
    );
    const batch = await adapter.callTool(
      "multi_get",
      {
        uris: taskSources.map(
          (file) => `gno://${file.collection}/${file.relPath}`
        ),
      },
      new AbortController().signal
    );
    expect(first.result.resultRole).toBe("candidates");
    expect(first.result.evidence).toHaveLength(1);
    expect(first.backendInvocations).toBe(2);
    expect(first.result.content).not.toContain("/volatile/path");
    expect(second.result.evidence[0]?.text).toBe(lines[evidenceLine]);
    expect(batch.result.evidence.length).toBeGreaterThan(taskSources.length);
    expect(
      batch.result.evidence.every((item) => item.startLine === item.endLine)
    ).toBe(true);
    expect(
      batch.result.evidence.every(
        (item) =>
          item.backendSourceHash === null &&
          item.backendSpanHash === null &&
          item.backendHashUnavailableReason !== null
      )
    ).toBe(true);
    expect(state.calls.map((call) => call.name)).toEqual([
      "gno_query",
      "gno_query",
      "gno_get",
      "gno_multi_get",
    ]);
    await adapter.dispose();
    expect(state.closes).toBe(1);
  });

  test("keeps product error messages out of canonical normalized content", async () => {
    const fixture = await loadAgenticFixture();
    const task = fixture.tasks.get("t0a1b2c3");
    if (!task) throw new Error("fixture task missing");
    const state: FakeConnectionState = { calls: [], closes: 0 };
    const { handle } = await fakeHandle();
    const adapter = new GnoMcpAdapter({
      prepareHandle: async () => handle,
      cleanupHandle: async () => undefined,
      connectionFactory: async () =>
        fakeConnection(state, [
          {
            isError: true,
            structuredContent: {
              error: "RUNTIME",
              message: "/tmp/private: exploded",
            },
          },
        ]),
    });
    const prepared = await adapter.prepare({
      snapshot: fixture.snapshot,
      prepared: null,
      signal: new AbortController().signal,
    });
    const attached = new GnoMcpAdapter({
      cleanupHandle: async () => undefined,
      connectionFactory: async () =>
        fakeConnection(state, [
          {
            isError: true,
            structuredContent: {
              error: "RUNTIME",
              message: "/tmp/private: exploded",
            },
          },
        ]),
    });
    await attached.prepare({
      snapshot: fixture.snapshot,
      prepared: prepared as AdapterPreparation,
      signal: new AbortController().signal,
    });
    await attached.reset({
      task,
      lifecycle: "cold",
      readinessProbe: false,
      signal: new AbortController().signal,
    });
    const outcome = await attached.callTool(
      "search",
      { query: "needle" },
      new AbortController().signal
    );
    expect(outcome.result.errorCode).toBe("gno_runtime");
    expect(outcome.result.content).not.toContain("private");
    await attached.dispose();
    await adapter.dispose();
  });
});
