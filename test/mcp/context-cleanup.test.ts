import { describe, expect, test } from "bun:test";

import type { ToolContext } from "../../src/mcp/server";

import {
  createMcpModelPorts,
  disposeContextModelOwners,
} from "../../src/mcp/tools/context";

describe("Context Capsule MCP model ownership", () => {
  test("attempts every cleanup and suppresses cleanup failures", async () => {
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
        async dispose() {
          calls.push("manager");
          throw new Error("manager cleanup failed");
        },
      }
    );
    expect(calls).toEqual(["embed", "rerank", "manager"]);
  });

  test("waits for every port cleanup before disposing the model manager", async () => {
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
        async dispose() {
          calls.push("manager");
        },
      }
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["embed:start", "rerank:start"]);
    releaseEmbed();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).not.toContain("manager");
    releaseRerank();
    await cleanup;
    expect(calls).toEqual([
      "embed:start",
      "rerank:start",
      "embed:end",
      "rerank:end",
      "manager",
    ]);
  });

  test("takes ownership before embedding init and cleans partial construction", async () => {
    const calls: string[] = [];
    const initError = new Error("embedding init failed");
    const context = {
      config: {
        version: "1.0",
        ftsTokenizer: "unicode61",
        collections: [],
        contexts: [],
      },
    } as unknown as ToolContext;
    const factory = {
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
        throw new Error("rerank must not be reached");
      },
      async dispose() {
        calls.push("dispose-manager");
      },
    };

    const error = await createMcpModelPorts(context, undefined, factory).then(
      () => null,
      (cause: unknown) => cause
    );
    expect(error).toBe(initError);
    expect(calls).toEqual([
      "create-embed",
      "init-embed",
      "dispose-embed",
      "dispose-manager",
    ]);
  });
});
