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
        throw new Error("rerank must not be reached");
      },
    };

    const error = await createMcpModelPorts(context, undefined, factory).then(
      () => null,
      (cause: unknown) => cause
    );
    expect(error).toBe(initError);
    expect(calls).toEqual([
      "acquire-lease",
      "create-embed",
      "init-embed",
      "dispose-embed",
      "release-lease",
    ]);
  });
});
