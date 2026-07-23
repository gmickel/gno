import { describe, expect, test } from "bun:test";

import type { Config } from "../../src/config/types";
import type { ToolContext } from "../../src/mcp/context";

import { ModelManager } from "../../src/llm/nodeLlamaCpp/lifecycle";
import { createToolContext } from "../../src/mcp/context";
import { createMcpModelPorts } from "../../src/mcp/tools/context";
import { runTool } from "../../src/mcp/tools/index";

const makeConfig = (collectionName: string): Config => ({
  version: "1.0",
  ftsTokenizer: "unicode61",
  collections: [
    {
      name: collectionName,
      path: `/tmp/${collectionName}`,
      pattern: "**/*.md",
      include: [],
      exclude: [],
    },
  ],
  contexts: [],
});

describe("shared MCP context lifecycle", () => {
  test("holds one immutable config snapshot for each request", async () => {
    let config = makeConfig("first");
    const context = createToolContext({
      store: {} as never,
      getConfig: () => config,
      setConfig: (next) => {
        config = next;
      },
      actualConfigPath: "/tmp/config.yml",
      indexName: "default",
      toolMutex: { acquire: async () => () => undefined },
      jobManager: {} as never,
      serverInstanceId: "test",
      writeLockPath: "/tmp/write.lock",
      enableWrite: false,
      isShuttingDown: () => false,
    });

    const observed = await context.runWithSnapshot?.(async () => {
      const before = context.collections[0]?.name;
      config = makeConfig("second");
      await Promise.resolve();
      return [before, context.collections[0]?.name];
    });

    expect(observed).toEqual(["first", "first"]);
    expect(context.collections[0]?.name).toBe("second");
  });

  test("repeated model-backed calls release one lease without disposing the manager", async () => {
    const calls: string[] = [];
    let loads = 0;
    const factory = {
      acquireModelLease() {
        calls.push("lease:acquire");
        let released = false;
        return {
          release() {
            if (released) return;
            released = true;
            calls.push("lease:release");
          },
        };
      },
      async createEmbeddingPort() {
        loads += 1;
        return { ok: false as const, error: new Error("not needed") } as never;
      },
      async createRerankPort() {
        return {
          ok: true as const,
          value: {
            modelUri: "test:rerank",
            async rerank() {
              return { ok: true as const, value: [] };
            },
            async dispose() {
              calls.push("port:dispose");
            },
          },
        };
      },
    };
    const context = { config: makeConfig("notes") } as ToolContext;

    const first = await createMcpModelPorts(context, undefined, factory);
    await first.dispose();
    const second = await createMcpModelPorts(context, undefined, factory);
    await second.dispose();

    expect(loads).toBe(2);
    expect(calls).toEqual([
      "lease:acquire",
      "port:dispose",
      "lease:release",
      "lease:acquire",
      "port:dispose",
      "lease:release",
    ]);
  });

  test("model leases are counted and released exactly once", () => {
    const manager = new ModelManager({
      activePreset: "slim",
      presets: [],
      loadTimeout: 60_000,
      inferenceTimeout: 30_000,
      expandContextSize: 2_048,
      warmModelTtl: 300_000,
    });

    const lease = manager.acquireLease();
    expect(manager.getLifecycleStats()).toMatchObject({
      activeLeases: 1,
      leaseAcquisitions: 1,
      leaseReleases: 0,
    });
    lease.release();
    lease.release();
    expect(manager.getLifecycleStats()).toMatchObject({
      activeLeases: 0,
      leaseAcquisitions: 1,
      leaseReleases: 1,
    });
  });

  test("semantic MCP calls keep one warm load and balance request leases", async () => {
    let physicalLoads = 0;
    let loaded = false;
    let acquisitions = 0;
    let releases = 0;
    const context = createToolContext({
      store: {} as never,
      getConfig: () => makeConfig("notes"),
      actualConfigPath: "/tmp/config.yml",
      indexName: "default",
      toolMutex: { acquire: async () => () => undefined },
      jobManager: {} as never,
      serverInstanceId: "test",
      writeLockPath: "/tmp/write.lock",
      enableWrite: false,
      isShuttingDown: () => false,
      acquireModelLease: () => {
        acquisitions += 1;
        return {
          release() {
            releases += 1;
          },
        };
      },
    });
    const semanticCall = () =>
      runTool(
        context,
        "semantic-proof",
        async () => {
          if (!loaded) {
            loaded = true;
            physicalLoads += 1;
          }
          return { loaded };
        },
        () => "ok"
      );

    await semanticCall();
    await semanticCall();

    expect(physicalLoads).toBe(1);
    expect({ acquisitions, releases }).toEqual({
      acquisitions: 2,
      releases: 2,
    });
  });
});
