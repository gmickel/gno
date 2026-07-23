import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/config";
import type { GenerationPort } from "../../src/llm/types";
import type { ToolContext } from "../../src/mcp/server";
import type { McpModelPortFactory } from "../../src/mcp/tools/context";
import type { AskResult } from "../../src/pipeline/types";

import { buildVerifiedAsk } from "../../src/app/verified-ask";
import { createDefaultConfig } from "../../src/config";
import { getRetrievalTraceMetadata } from "../../src/core/retrieval-trace-session";
import { handleAsk as handleMcpAsk } from "../../src/mcp/tools/ask";
import { createGnoClient, type GnoClient } from "../../src/sdk";
import { handleAsk as handleRestAsk } from "../../src/serve/routes/api";
import { SqliteAdapter } from "../../src/store";
import { safeRm } from "../helpers/cleanup";

const generationPort = (): GenerationPort => ({
  modelUri: "file:/verified-ask.gguf",
  structuredOutput: "json_schema",
  generate: async (_prompt, params) => {
    if (!params?.jsonSchema) {
      return { ok: true, value: "Mina owns the launch decision [1]." };
    }
    const schema = params.jsonSchema as {
      properties: {
        judgments: {
          items: {
            properties: {
              claimId: { enum: string[] };
              evidenceIds: { items: { enum: string[] } };
            };
          };
        };
      };
    };
    const properties = schema.properties.judgments.items.properties;
    return {
      ok: true,
      value: JSON.stringify({
        judgments: [
          {
            claimId: properties.claimId.enum[0],
            verdict: "supported",
            confidence: 1,
            evidenceIds: [properties.evidenceIds.items.enum[0]],
            rationaleCode: "semantic_entailment",
          },
        ],
        unresolvedClaimIds: [],
      }),
    };
  },
  dispose: async () => {},
});

const unavailable = async () => ({
  ok: false as const,
  error: {
    code: "MODEL_NOT_CACHED" as const,
    message: "disabled in parity test",
    retryable: false,
  },
});

const modelFactory = (): McpModelPortFactory => ({
  createEmbeddingPort: unavailable,
  createRerankPort: unavailable,
  createGenerationPort: async () => ({
    ok: true as const,
    value: generationPort(),
  }),
});

const verificationProjection = (result: AskResult) => {
  const plain = JSON.parse(
    JSON.stringify({
      query: result.query,
      mode: result.mode,
      answer: result.answer,
      citations: result.citations,
      meta: result.meta,
      verification: result.verification,
    })
  ) as {
    verification?: { semantic?: { durationMs?: number } };
  };
  if (plain.verification?.semantic) {
    delete plain.verification.semantic.durationMs;
  }
  return plain;
};

describe("verified Ask cross-surface parity", () => {
  let root = "";
  let client: GnoClient;
  let store: SqliteAdapter;
  let config: Config;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-verified-ask-parity-"));
    await Bun.write(
      join(root, "decision.md"),
      "# Owner\nMina owns the launch decision."
    );
    config = {
      ...createDefaultConfig(),
      collections: [
        {
          name: "notes",
          path: root,
          pattern: "**/*.md",
          include: [],
          exclude: [],
        },
      ],
      retrievalTraces: {
        enabled: true,
        redactionMode: "metadata",
        retention: {
          maxAgeDays: 30,
          maxTraces: 100,
          maxRecordsPerTrace: 100,
          maxBytes: 1024 * 1024,
        },
      },
    };
    client = await createGnoClient({
      config,
      dbPath: join(root, "index-default.sqlite"),
      indexName: "default",
      downloadPolicy: { offline: true, allowDownload: false },
    });
    await client.update();
    const internals = client as unknown as {
      store: SqliteAdapter;
      llm: ReturnType<typeof modelFactory> & { dispose(): Promise<void> };
    };
    store = internals.store;
    internals.llm = {
      ...modelFactory(),
      dispose: async () => {},
    };
  });

  afterAll(async () => {
    await client.close();
    await safeRm(root);
  });

  test("executes one canonical verified contract through REST, SDK, and MCP", async () => {
    const reference = await buildVerifiedAsk(
      "Mina",
      { verify: true, collection: "notes", noRerank: true },
      {
        store,
        config,
        indexName: "default",
        genPort: generationPort(),
      }
    );

    const restResponse = await handleRestAsk(
      {
        store,
        config,
        indexName: "default",
        vectorIndex: null,
        embedPort: null,
        expandPort: null,
        answerPort: generationPort(),
        rerankPort: null,
        capabilities: {
          bm25: true,
          vector: false,
          hybrid: false,
          answer: true,
        },
      } as never,
      new Request("http://localhost/api/ask", {
        method: "POST",
        body: JSON.stringify({
          query: "Mina",
          verify: true,
          collection: "notes",
          noRerank: true,
        }),
      })
    );
    expect(restResponse.status).toBe(200);
    const rest = (await restResponse.json()) as AskResult;

    const sdk = await client.ask("Mina", {
      verify: true,
      collection: "notes",
      noRerank: true,
    });

    const context = {
      store,
      config,
      collections: config.collections,
      actualConfigPath: join(root, "config.yml"),
      indexName: "default",
      toolMutex: { acquire: async () => () => undefined },
      jobManager: {},
      serverInstanceId: "verified-ask-parity",
      writeLockPath: join(root, ".lock"),
      enableWrite: false,
      isShuttingDown: () => false,
    } as ToolContext;
    const mcpResponse = await handleMcpAsk(
      {
        query: "Mina",
        verify: true,
        collection: "notes",
        limit: 5,
        noRerank: true,
      },
      context,
      { modelPortFactory: modelFactory() }
    );
    expect(mcpResponse.isError).not.toBe(true);
    const mcp = mcpResponse.structuredContent as unknown as AskResult;

    const expected = verificationProjection(reference);
    for (const actual of [rest, sdk, mcp]) {
      expect(verificationProjection(actual)).toEqual(expected);
      expect(actual.verification?.capsule.scope.indexName).toBe("default");
      expect(actual.verification?.capsule.retrieval.request).toMatchObject({
        limit: 5,
        rerankRequested: false,
      });
    }

    const traceIds = [
      restResponse.headers.get("X-GNO-Trace-ID"),
      getRetrievalTraceMetadata(sdk)?.traceId,
      (
        mcpResponse._meta as
          | { gno?: { retrievalTrace?: { traceId?: string } } }
          | undefined
      )?.gno?.retrievalTrace?.traceId,
    ];
    expect(traceIds.every(Boolean)).toBe(true);
    expect(new Set(traceIds).size).toBe(3);
    for (const traceId of traceIds) {
      const stored = await store.getRetrievalTrace(traceId ?? "");
      expect(stored.ok && stored.value?.trace.status).toBe("completed");
      expect(stored.ok && stored.value?.events.at(-1)?.payload).toEqual({
        outcome: "completed",
      });
    }
  });
});
