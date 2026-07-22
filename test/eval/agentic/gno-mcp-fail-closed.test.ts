import { describe, expect, test } from "bun:test";

import type {
  GnoMcpConnection,
  GnoMcpPreparedHandle,
  GnoMcpProductTool,
} from "../../../evals/agentic/lifecycle/gno-mcp";

import { GnoMcpAdapter } from "../../../evals/agentic/adapters/gno-mcp";
import { normalizeGnoMcpResult } from "../../../evals/agentic/adapters/gno-mcp-normalize";
import { canonicalFingerprint } from "../../../evals/agentic/canonical";
import { loadAgenticFixture } from "../../../evals/agentic/fixture-db";
import { validateGnoProductTools } from "../../../evals/agentic/lifecycle/gno-mcp";

const queryProperties = Object.fromEntries(
  [
    "query",
    "collection",
    "limit",
    "minScore",
    "lang",
    "intent",
    "candidateLimit",
    "exclude",
    "since",
    "until",
    "categories",
    "author",
    "queryModes",
    "fast",
    "thorough",
    "expand",
    "rerank",
    "graph",
    "tagsAll",
    "tagsAny",
  ].map((name) => [name, {}])
);

const PRODUCT_TOOLS: GnoMcpProductTool[] = [
  {
    name: "gno_query",
    inputSchema: { type: "object", properties: queryProperties },
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

const fixtureHandle = async (): Promise<GnoMcpPreparedHandle> => {
  const fixture = await loadAgenticFixture();
  return {
    snapshot: fixture.snapshot,
    native: {
      taskIds: [...fixture.tasks.keys()],
      corpusFingerprint: fixture.snapshot.fingerprint,
      indexFingerprint: canonicalFingerprint({
        fixture: fixture.snapshot.fingerprint,
      }),
      dbPath: "/tmp/gno-fail-closed.sqlite",
      rootPath: "/tmp/gno-fail-closed",
      documentCount: fixture.snapshot.files.length,
      collectionCount: 1,
      observations: { preparationMs: 1, filesProcessed: 1, filesErrored: 0 },
    },
    configPath: "/tmp/gno-fail-closed/index.yml",
    configDir: "/tmp/gno-fail-closed/config",
    dataDir: "/tmp/gno-fail-closed/data",
    cacheDir: "/tmp/gno-fail-closed/cache",
    indexName: "agentic",
    models: {} as GnoMcpPreparedHandle["models"],
    productToolsFingerprint: validateGnoProductTools(PRODUCT_TOOLS),
    environment: {},
  };
};

describe("GNO MCP fail-closed lifecycle", () => {
  test("cleans a preparation that completes after runner cancellation", async () => {
    const fixture = await loadAgenticFixture();
    const handle = await fixtureHandle();
    let resolvePreparation!: (value: GnoMcpPreparedHandle) => void;
    const pendingPreparation = new Promise<GnoMcpPreparedHandle>((resolve) => {
      resolvePreparation = resolve;
    });
    let receivedSignal: AbortSignal | undefined;
    let cleanups = 0;
    const adapter = new GnoMcpAdapter({
      prepareHandle: (_snapshot, options) => {
        receivedSignal = options?.signal;
        return pendingPreparation;
      },
      cleanupHandle: async () => {
        cleanups += 1;
      },
    });
    const controller = new AbortController();
    const preparation = adapter.prepare({
      snapshot: fixture.snapshot,
      prepared: null,
      signal: controller.signal,
    });
    controller.abort(new Error("preparation timed out"));
    expect(receivedSignal).toBe(controller.signal);
    resolvePreparation(handle);
    const preparationError = await preparation.then(
      () => "",
      (error: unknown) =>
        error instanceof Error ? error.message : String(error)
    );
    expect(preparationError).toContain("preparation timed out");
    expect(cleanups).toBe(1);
  });

  test("cleans the fixture even when MCP close rejects", async () => {
    const fixture = await loadAgenticFixture();
    const task = fixture.tasks.get("t0a1b2c3");
    if (!task) throw new Error("fixture task missing");
    const handle = await fixtureHandle();
    let cleanups = 0;
    const connection: GnoMcpConnection = {
      pid: 1,
      serverName: "gno",
      serverVersion: "fixture",
      async listTools() {
        return PRODUCT_TOOLS;
      },
      async callTool() {
        throw new Error("not called");
      },
      async close() {
        throw new Error("close failed");
      },
    };
    const adapter = new GnoMcpAdapter({
      prepareHandle: async () => handle,
      cleanupHandle: async () => {
        cleanups += 1;
      },
      connectionFactory: async () => connection,
    });
    await adapter.prepare({
      snapshot: fixture.snapshot,
      prepared: null,
      signal: new AbortController().signal,
    });
    await adapter.reset({
      task,
      lifecycle: "cold",
      readinessProbe: false,
      signal: new AbortController().signal,
    });
    const disposeError = await adapter.dispose().then(
      () => "",
      (error: unknown) =>
        error instanceof Error ? error.message : String(error)
    );
    expect(disposeError).toContain("close failed");
    expect(cleanups).toBe(1);
  });
});

describe("GNO MCP successful output validation", () => {
  test("rejects malformed query, get, and multi_get envelopes", async () => {
    const fixture = await loadAgenticFixture();
    const task = fixture.tasks.get("t0a1b2c3");
    if (!task) throw new Error("fixture task missing");
    for (const [tool, structuredContent] of [
      ["search", { meta: {} }],
      ["get", { uri: "gno://c001/incident.md" }],
      ["multi_get", { documents: [] }],
    ] as const) {
      expect(() =>
        normalizeGnoMcpResult(
          tool,
          { structuredContent },
          fixture.snapshot,
          task
        )
      ).toThrow("malformed structured output");
    }
  });

  test("rejects a backend source hash that differs from fixture bytes", async () => {
    const fixture = await loadAgenticFixture();
    const task = fixture.tasks.get("t0a1b2c3");
    const source = fixture.snapshot.files.find(
      (file) => file.taskId === task?.taskId
    );
    if (!(task && source)) throw new Error("fixture source missing");
    expect(() =>
      normalizeGnoMcpResult(
        "search",
        {
          structuredContent: {
            results: [
              {
                uri: `gno://${source.collection}/${source.relPath}`,
                docid: "fixture",
                score: 1,
                snippet: source.content.split("\n")[0],
                snippetRange: { startLine: 1, endLine: 1 },
                source: {
                  relPath: source.relPath,
                  mime: "text/markdown",
                  ext: ".md",
                  sourceHash: "0".repeat(64),
                },
              },
            ],
            meta: {
              query: "needle",
              mode: "hybrid",
              expanded: false,
              reranked: false,
              vectorsUsed: true,
              totalResults: 1,
            },
          },
        },
        fixture.snapshot,
        task
      )
    ).toThrow("source identity is invalid");
  });

  test("rejects invalid query ranges, scores, modes, and result counts", async () => {
    const fixture = await loadAgenticFixture();
    const task = fixture.tasks.get("t0a1b2c3");
    const source = fixture.snapshot.files.find(
      (file) => file.taskId === task?.taskId
    );
    if (!(task && source)) throw new Error("fixture source missing");
    const result = {
      uri: `gno://${source.collection}/${source.relPath}`,
      docid: "fixture",
      score: 1,
      snippet: source.content.split("\n")[0],
      snippetRange: { startLine: 1, endLine: 1 },
      source: {
        relPath: source.relPath,
        mime: "text/markdown",
        ext: ".md",
        sourceHash: source.sourceHash,
      },
    };
    const meta = {
      query: "needle",
      mode: "hybrid",
      expanded: false,
      reranked: false,
      vectorsUsed: true,
      totalResults: 1,
    };
    for (const structuredContent of [
      { results: [{ ...result, score: 1.1 }], meta },
      {
        results: [
          {
            ...result,
            snippetRange: { startLine: 2, endLine: 1 },
          },
        ],
        meta,
      },
      { results: [result], meta: { ...meta, mode: "unknown" } },
      { results: [result], meta: { ...meta, totalResults: -1 } },
    ]) {
      expect(() =>
        normalizeGnoMcpResult(
          "search",
          { structuredContent },
          fixture.snapshot,
          task
        )
      ).toThrow("malformed structured output");
    }
    expect(() =>
      normalizeGnoMcpResult(
        "multi_get",
        {
          structuredContent: {
            documents: [],
            skipped: [],
            meta: { requested: 1, returned: 0, skipped: 0 },
          },
        },
        fixture.snapshot,
        task
      )
    ).toThrow("counts are inconsistent");
  });

  test("does not invent a range for an out-of-range empty get", async () => {
    const fixture = await loadAgenticFixture();
    const task = fixture.tasks.get("t0a1b2c3");
    const source = fixture.snapshot.files.find(
      (file) => file.taskId === task?.taskId
    );
    if (!(task && source)) throw new Error("fixture source missing");
    const totalLines = source.content.split("\n").length;
    const outcome = normalizeGnoMcpResult(
      "get",
      {
        structuredContent: {
          docid: "fixture",
          uri: `gno://${source.collection}/${source.relPath}`,
          content: "",
          totalLines,
          source: {
            relPath: source.relPath,
            mime: "text/markdown",
            ext: ".md",
            sourceHash: source.sourceHash,
          },
        },
      },
      fixture.snapshot,
      task
    );
    expect(outcome.result.evidence).toEqual([]);
    expect(outcome.result.content).toContain('"returnedLines":null');
  });
});
