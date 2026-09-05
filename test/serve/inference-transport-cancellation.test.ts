import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { expect, test } from "bun:test";
import { z } from "zod";

import { JobManager } from "../../src/core/job-manager";
import {
  assertInferenceActive,
  inferenceOptions,
  runHttpInference,
  withInferenceScope,
} from "../../src/llm/inference-scope";
import { createProfileToolRegistrar } from "../../src/mcp/tool-profile";

test("inference timeout aborts in-flight siblings in the same request", async () => {
  let aborted = 0;
  const request = withInferenceScope({}, async () => {
    await Promise.all(
      [10, 1000].map((timeout) =>
        runHttpInference<string>(
          undefined,
          ({ signal }) =>
            new Promise((resolve) => {
              signal?.addEventListener(
                "abort",
                () => {
                  aborted++;
                  resolve({ ok: true, value: "late result" });
                },
                { once: true }
              );
            }),
          timeout
        )
      )
    );
  });
  expect(await request.catch((error: unknown) => error)).toMatchObject({
    name: "TimeoutError",
  });
  expect(aborted).toBe(2);
});

test.each(["notification", "disconnect"])(
  "MCP %s abort reaches nested inference scope",
  async (mode) => {
    const server = new McpServer({ name: "cancellation", version: "1" });
    const client = new Client({ name: "caller", version: "1" });
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    createProfileToolRegistrar(server, "full")(
      "gno_query",
      { inputSchema: z.object({}) },
      async () => {
        const signal = inferenceOptions().signal;
        expect(signal).toBeDefined();
        signal?.addEventListener("abort", () => aborted.resolve(), {
          once: true,
        });
        started.resolve();
        await aborted.promise;
        assertInferenceActive();
        return { content: [{ type: "text" as const, text: "late result" }] };
      }
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const controller = new AbortController();
    const pending = client.callTool(
      { name: "gno_query", arguments: {} },
      { signal: controller.signal }
    );
    // Attach rejection handling before triggering a transport cancellation.
    const result = pending.then(
      () => "success",
      () => "cancelled"
    );
    await started.promise;
    if (mode === "notification") controller.abort();
    else await client.close();
    await aborted.promise;
    expect(await result).toBe("cancelled");
    await client.close();
    await server.close();
  }
);

test.each([false, true])(
  "accepted job owns a detached lifetime; explicit abort=%s",
  async (cancelJob) => {
    const request = new AbortController();
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let lockReleased = 0;
    let published = false;
    const manager = new JobManager({
      lockPath: "/unused-synthetic-lock",
      serverInstanceId: "test",
      toolMutex: { acquire: async () => () => {} },
    });
    const id = await withInferenceScope({ signal: request.signal }, () =>
      manager.startTypedJobWithLock(
        "embed",
        {
          release: async () => {
            lockReleased++;
          },
        } as Parameters<JobManager["startTypedJobWithLock"]>[1],
        async (signal) => {
          expect(signal).not.toBe(request.signal);
          started.resolve();
          await release.promise;
          assertInferenceActive();
          published = true;
          return { kind: "embed", value: { embedded: 1, errors: 0 } };
        }
      )
    );
    await started.promise;
    request.abort();
    if (cancelJob) expect(manager.cancelJob(id)).toBe(true);
    release.resolve();
    await manager.shutdown();
    expect(published).toBe(!cancelJob);
    expect(manager.getJob(id)?.status).toBe(cancelJob ? "failed" : "completed");
    expect(lockReleased).toBe(1);
    expect(manager.cancelJob(id)).toBe(false);
  }
);
