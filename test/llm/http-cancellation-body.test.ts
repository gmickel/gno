import { expect, test } from "bun:test";

import { HttpGeneration } from "../../src/llm/httpGeneration";

test.each(["timeout", "abort"])(
  "HTTP %s covers response-body consumption",
  async (mode) => {
    const bodyStarted = Promise.withResolvers<void>();
    const headersReceived = Promise.withResolvers<void>();
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"choices":['));
              bodyStarted.resolve();
            },
          }),
          { headers: { "content-type": "application/json" } }
        ),
    });
    let fetchSignal: AbortSignal | undefined;
    const caller = new AbortController();
    const port = new HttpGeneration(
      `http://127.0.0.1:${server.port}/v1/chat/completions#synthetic`,
      {
        collections: [
          {
            name: "synthetic",
            path: "/synthetic",
            pattern: "**/*",
            include: [],
            exclude: [],
            egressPolicy: "local_only",
          },
        ],
        collectionNames: ["synthetic"],
        inferenceTimeout: 100,
        env: {},
        resolver: { lookup: async () => ["127.0.0.1"] },
        fetchFn: async (url, init) => {
          fetchSignal = init?.signal ?? undefined;
          const response = await fetch(url, init);
          headersReceived.resolve();
          return response;
        },
      }
    );
    try {
      const pending = port.generate(
        "unchanged prompt",
        { seed: 42 },
        { signal: caller.signal }
      );
      await bodyStarted.promise;
      await headersReceived.promise;
      await Bun.sleep(0);
      if (mode === "abort") caller.abort();
      const result = await pending;
      expect(fetchSignal?.aborted).toBe(true);
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: mode === "abort" ? "INFERENCE_FAILED" : "TIMEOUT",
          cause: { name: mode === "abort" ? "AbortError" : "TimeoutError" },
        },
      });
    } finally {
      await port.dispose();
      await server.stop(true);
    }
  }
);
