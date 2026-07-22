import { expect, test } from "bun:test";

import type {
  GnoMcpCallResult,
  GnoMcpConnection,
  GnoMcpPreparedHandle,
  GnoMcpProductTool,
} from "../../../evals/agentic/lifecycle/gno-mcp";

import { GnoMcpAdapter } from "../../../evals/agentic/adapters/gno-mcp";
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

const rejectionMessage = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

test("GNO MCP rejects cross-task calls and leaked product results", async () => {
  const fixture = await loadAgenticFixture();
  const task = fixture.tasks.get("t0a1b2c3");
  const multiTask = fixture.tasks.get("t456ef70");
  const foreign = fixture.snapshot.files.find(
    (file) => file.taskId !== task?.taskId
  );
  if (!(task && multiTask && foreign))
    throw new Error("isolation fixture missing");
  const handle: GnoMcpPreparedHandle = {
    snapshot: fixture.snapshot,
    native: {
      taskIds: [...fixture.tasks.keys()],
      corpusFingerprint: fixture.snapshot.fingerprint,
      indexFingerprint: canonicalFingerprint({
        corpus: fixture.snapshot.fingerprint,
      }),
      dbPath: "/tmp/fake.sqlite",
      rootPath: "/tmp/fake-gno-mcp",
      documentCount: fixture.snapshot.files.length,
      collectionCount: 26,
      observations: { preparationMs: 1, filesProcessed: 34, filesErrored: 0 },
    },
    configPath: "/tmp/fake-gno-mcp/index.yml",
    configDir: "/tmp/fake-gno-mcp/config",
    dataDir: "/tmp/fake-gno-mcp/data",
    cacheDir: "/tmp/fake-gno-mcp/cache",
    indexName: "agentic",
    models: {} as GnoMcpPreparedHandle["models"],
    productToolsFingerprint: validateGnoProductTools(PRODUCT_TOOLS),
    environment: {},
  };
  const calls: string[] = [];
  const responses: GnoMcpCallResult[] = [];
  const connectionFactory = async (): Promise<GnoMcpConnection> => ({
    pid: 1,
    serverName: "gno",
    serverVersion: "fixture",
    async listTools() {
      return PRODUCT_TOOLS;
    },
    async callTool(name) {
      calls.push(name);
      const response = responses.shift();
      if (!response) throw new Error("No fake response queued");
      return response;
    },
    async close() {},
  });
  const createAdapter = () =>
    new GnoMcpAdapter({
      prepareHandle: async () => handle,
      cleanupHandle: async () => undefined,
      connectionFactory,
    });
  const reset = async (adapter: GnoMcpAdapter, visibleTask = task) => {
    await adapter.prepare({
      snapshot: fixture.snapshot,
      prepared: null,
      signal: new AbortController().signal,
    });
    await adapter.reset({
      task: visibleTask,
      lifecycle: "cold",
      readinessProbe: false,
      signal: new AbortController().signal,
    });
  };

  const adapter = createAdapter();
  await reset(adapter);
  const foreignUri = `gno://${foreign.collection}/${foreign.relPath}`;
  expect(
    await rejectionMessage(
      adapter.callTool(
        "search",
        { query: "needle", collection: foreign.collection },
        new AbortController().signal
      )
    )
  ).toContain("outside the visible task corpus");
  expect(
    await rejectionMessage(
      adapter.callTool("get", { uri: foreignUri }, new AbortController().signal)
    )
  ).toContain("outside the visible task corpus");
  expect(
    await rejectionMessage(
      adapter.callTool(
        "multi_get",
        { uris: [foreignUri] },
        new AbortController().signal
      )
    )
  ).toContain("outside the visible task corpus");
  expect(calls).toHaveLength(0);
  await adapter.dispose();

  responses.push({
    structuredContent: {
      results: [
        {
          uri: foreignUri,
          docid: "foreign",
          score: 1,
          snippet: foreign.content.split("\n")[0],
          snippetRange: { startLine: 1, endLine: 1 },
          source: {
            relPath: foreign.relPath,
            mime: "text/markdown",
            ext: ".md",
            sourceHash: foreign.sourceHash,
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
  });
  const leaked = createAdapter();
  await reset(leaked);
  expect(
    await rejectionMessage(
      leaked.callTool(
        "search",
        { query: "needle", collection: "c001" },
        new AbortController().signal
      )
    )
  ).toContain("returned a source outside");
  await leaked.dispose();

  const multiScope = createAdapter();
  await reset(multiScope, multiTask);
  expect(
    await rejectionMessage(
      multiScope.callTool(
        "search",
        { query: "invoice identifier" },
        new AbortController().signal
      )
    )
  ).toContain("must select one collection");
  await multiScope.dispose();
});
