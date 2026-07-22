import { expect, test } from "bun:test";

import type {
  GnoMcpConnection,
  GnoMcpPreparedHandle,
  GnoMcpProductTool,
} from "../../../evals/agentic/lifecycle/gno-mcp";

import { createGnoMcpAdapterFactory } from "../../../evals/agentic/adapters/gno-mcp";
import {
  canonicalFingerprint,
  normalizeNewlines,
} from "../../../evals/agentic/canonical";
import { loadAgenticFixture } from "../../../evals/agentic/fixture-db";
import { validateGnoProductTools } from "../../../evals/agentic/lifecycle/gno-mcp";
import { runAgenticBenchmark } from "../../../evals/agentic/runner";
import { scoreTrajectory } from "../../../evals/agentic/scoring";

const properties = Object.fromEntries(
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
  { name: "gno_query", inputSchema: { type: "object", properties } },
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

const exactLineCount = (content: string): number => {
  const normalized = normalizeNewlines(content);
  return normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n").length
    : normalized.split("\n").length;
};

test("GNO MCP normalization supports exact oracle lines across all 24 tasks", async () => {
  const fixture = await loadAgenticFixture();
  const handle: GnoMcpPreparedHandle = {
    snapshot: fixture.snapshot,
    native: {
      taskIds: [...fixture.tasks.keys()],
      corpusFingerprint: fixture.snapshot.fingerprint,
      indexFingerprint: canonicalFingerprint({
        adapter: "gno-mcp-runner-fixture",
        corpus: fixture.snapshot.fingerprint,
      }),
      dbPath: "/tmp/gno-mcp-runner.sqlite",
      rootPath: "/tmp/gno-mcp-runner",
      documentCount: fixture.snapshot.files.length,
      collectionCount: new Set(
        fixture.snapshot.files.map((file) => file.collection)
      ).size,
      observations: {
        preparationMs: 1,
        filesProcessed: fixture.snapshot.files.length,
        filesErrored: 0,
      },
    },
    configPath: "/tmp/gno-mcp-runner/index.yml",
    configDir: "/tmp/gno-mcp-runner/config",
    dataDir: "/tmp/gno-mcp-runner/data",
    cacheDir: "/tmp/gno-mcp-runner/cache",
    indexName: "agentic",
    models: {} as GnoMcpPreparedHandle["models"],
    productToolsFingerprint: validateGnoProductTools(PRODUCT_TOOLS),
    environment: {},
  };

  const connectionFactory = async (): Promise<GnoMcpConnection> => ({
    pid: 7,
    serverName: "gno",
    serverVersion: "fixture",
    async listTools() {
      return PRODUCT_TOOLS;
    },
    async callTool(name, arguments_) {
      if (name === "gno_query") {
        const collection =
          typeof arguments_.collection === "string"
            ? arguments_.collection
            : "";
        const files = fixture.snapshot.files.filter(
          (file) => file.collection === collection
        );
        return {
          structuredContent: {
            results: files.map((file, index) => ({
              uri: `gno://${file.collection}/${file.relPath}?index=agentic`,
              docid: `#fixture${index}`,
              score: 1 - index / 100,
              snippet: file.content,
              snippetRange: {
                startLine: 1,
                endLine: exactLineCount(file.content),
              },
              source: {
                relPath: file.relPath,
                mime: "text/markdown",
                ext: ".md",
                sourceHash: file.sourceHash,
              },
            })),
            meta: {
              query: arguments_.query,
              mode: "hybrid",
              expanded: false,
              reranked: false,
              vectorsUsed: true,
              totalResults: files.length,
            },
          },
        };
      }
      if (name === "gno_get") {
        const ref = (
          typeof arguments_.ref === "string" ? arguments_.ref : ""
        ).replace(/\?index=agentic$/, "");
        const file = fixture.snapshot.files.find(
          (candidate) =>
            `gno://${candidate.collection}/${candidate.relPath}` === ref
        );
        if (!file)
          return { isError: true, structuredContent: { error: "NOT_FOUND" } };
        const from =
          typeof arguments_.fromLine === "number" ? arguments_.fromLine : 1;
        const count =
          typeof arguments_.lineCount === "number"
            ? arguments_.lineCount
            : exactLineCount(file.content);
        const lines = normalizeNewlines(file.content)
          .replace(/\n$/, "")
          .split("\n");
        const end = Math.min(from + count - 1, lines.length);
        return {
          structuredContent: {
            docid: `fixture-${file.relPath}`,
            uri: ref,
            content: lines.slice(from - 1, end).join("\n"),
            totalLines: normalizeNewlines(file.content).split("\n").length,
            returnedLines: { start: from, end },
            source: {
              relPath: file.relPath,
              mime: "text/markdown",
              ext: ".md",
              sourceHash: file.sourceHash,
            },
          },
        };
      }
      const refs = Array.isArray(arguments_.refs) ? arguments_.refs : [];
      const files = refs.flatMap((ref) => {
        const stable = String(ref).replace(/\?index=agentic$/, "");
        const file = fixture.snapshot.files.find(
          (candidate) =>
            `gno://${candidate.collection}/${candidate.relPath}` === stable
        );
        return file ? [file] : [];
      });
      return {
        structuredContent: {
          documents: files.map((file) => ({
            docid: `fixture-${file.relPath}`,
            uri: `gno://${file.collection}/${file.relPath}`,
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
            requested: refs.length,
            returned: files.length,
            skipped: refs.length - files.length,
          },
        },
      };
    },
    async close() {},
  });

  const result = await runAgenticBenchmark({
    fixture,
    adapters: {
      "gno-mcp": createGnoMcpAdapterFactory({
        prepareHandle: async () => handle,
        cleanupHandle: async () => undefined,
        connectionFactory,
      }),
    },
    adapterIds: ["gno-mcp"],
    lifecycles: ["cold"],
  });
  expect(result.receipts).toHaveLength(24);
  const scores = result.receipts.map((receipt) => {
    const task = fixture.tasks.get(receipt.canonical.taskId);
    const oracle = fixture.oracles.get(receipt.canonical.taskId);
    if (!(task && oracle)) throw new Error("fixture pair missing");
    return scoreTrajectory(task, oracle, receipt);
  });
  expect(scores.every((score) => score.scored)).toBe(true);
  expect(
    scores
      .filter((score) => score.success !== 1)
      .map((score) => ({
        taskId: score.taskId,
        unsupported: score.unsupportedClaims,
        missing: score.missingRequiredClaims,
        invalid: score.invalidOutputs,
      }))
  ).toEqual([]);
  expect(
    result.receipts
      .flatMap((receipt) => receipt.canonical.calls)
      .flatMap((call) => call.result.evidence)
      .every((evidence) => evidence.startLine === evidence.endLine)
  ).toBe(true);
});
