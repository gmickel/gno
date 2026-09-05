import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import type { ToolContext } from "../../src/mcp/server";

import {
  createMcpModelPorts,
  disposeContextModelOwners,
} from "../../src/mcp/tools/context";

describe("Context Capsule MCP model ownership", () => {
  test("attempts every port cleanup and releases the request lease", async () => {
    const calls: string[] = [];
    await disposeContextModelOwners(
      [
        {
          async dispose() {
            calls.push("embed");
            throw new Error("embed cleanup failed");
          },
        },
        {
          async dispose() {
            calls.push("rerank");
          },
        },
      ],
      {
        release() {
          calls.push("lease");
        },
      }
    );
    expect(calls).toEqual(["embed", "rerank", "lease"]);
  });

  test("waits for every port cleanup before releasing the model lease", async () => {
    const calls: string[] = [];
    let releaseEmbed!: () => void;
    let releaseRerank!: () => void;
    const embedSettled = new Promise<void>((resolve) => {
      releaseEmbed = resolve;
    });
    const rerankSettled = new Promise<void>((resolve) => {
      releaseRerank = resolve;
    });
    const cleanup = disposeContextModelOwners(
      [
        {
          async dispose() {
            calls.push("embed:start");
            await embedSettled;
            calls.push("embed:end");
          },
        },
        {
          async dispose() {
            calls.push("rerank:start");
            await rerankSettled;
            calls.push("rerank:end");
          },
        },
      ],
      {
        release() {
          calls.push("lease");
        },
      }
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["embed:start", "rerank:start"]);
    releaseEmbed();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).not.toContain("lease");
    releaseRerank();
    await cleanup;
    expect(calls).toEqual([
      "embed:start",
      "rerank:start",
      "embed:end",
      "rerank:end",
      "lease",
    ]);
  });

  test.each(["partial construction", "lazy embedding init"] as const)(
    "cleans owned model ports after %s failure without masking the cause",
    async (stage) => {
      const calls: string[] = [];
      const initError = new Error("embedding init failed");
      const constructionError = new Error("rerank construction failed");
      const db = new Database(":memory:");
      db.run("CREATE TABLE content_vectors(model TEXT, embedding BLOB)");
      const factory = {
        acquireModelLease() {
          calls.push("acquire-lease");
          return {
            release() {
              calls.push("release-lease");
            },
          };
        },
        async createEmbeddingPort() {
          calls.push("create-embed");
          return {
            ok: true as const,
            value: {
              modelUri: "test:embed",
              async init() {
                calls.push("init-embed");
                throw initError;
              },
              async embed() {
                return { ok: true as const, value: [] };
              },
              async embedBatch() {
                return { ok: true as const, value: [] };
              },
              dimensions() {
                return 1;
              },
              async dispose() {
                calls.push("dispose-embed");
                throw new Error("cleanup must not mask init error");
              },
            },
          };
        },
        async createRerankPort() {
          calls.push("create-rerank");
          if (stage === "partial construction") throw constructionError;
          return {
            ok: true as const,
            value: {
              modelUri: "test:rerank",
              async rerank() {
                return { ok: true as const, value: [] };
              },
              async dispose() {
                calls.push("dispose-rerank");
              },
            },
          };
        },
      };
      const context = {
        config: {
          version: "1.0",
          ftsTokenizer: "unicode61",
          collections: [],
          contexts: [],
        },
        store: { getRawDb: () => db },
        getModelAdapter: () => factory,
      } as unknown as ToolContext;
      try {
        const operation = async () => {
          const ports = await createMcpModelPorts(context, undefined, factory);
          try {
            // Construction must remain native-free with no stored dimensions.
            expect(calls).toEqual([
              "acquire-lease",
              "create-embed",
              "create-rerank",
            ]);
            if (!ports.vectorIndex)
              throw new Error("lazy vector index missing");
            await ports.vectorIndex.searchNearest(new Float32Array([1]), 1);
          } finally {
            // The MCP handler owns this same request-finally cleanup boundary.
            await ports.dispose();
          }
        };
        const error = await operation().then(
          () => null,
          (cause: unknown) => cause
        );
        expect(error).toBe(
          stage === "partial construction" ? constructionError : initError
        );
        expect(calls).toEqual(
          stage === "partial construction"
            ? [
                "acquire-lease",
                "create-embed",
                "create-rerank",
                "dispose-embed",
                "release-lease",
              ]
            : [
                "acquire-lease",
                "create-embed",
                "create-rerank",
                "init-embed",
                "dispose-embed",
                "dispose-rerank",
                "release-lease",
              ]
        );
      } finally {
        db.close();
      }
    }
  );
});
