import { expect, test } from "bun:test";

import type { EmbeddingPort, LlmResult } from "../../src/llm/types";

import {
  lazyEmbeddingPort,
  lazyGenerationPort,
  lazyRerankPort,
} from "../../src/llm/lazy-ports";

const failure = {
  ok: false as const,
  error: {
    code: "MODEL_NOT_CACHED" as const,
    message: "offline cache miss",
    retryable: false,
  },
};

test("lazy model ports do no resolution for construction, metadata or unused disposal", async () => {
  let calls = 0;
  const create = async () => {
    calls++;
    return failure;
  };
  const embedding = lazyEmbeddingPort("file:/embed.gguf", create);
  const generation = lazyGenerationPort("file:/gen.gguf", create);
  const http = lazyGenerationPort(
    "http://localhost:8080/v1/chat/completions",
    create
  );
  const rerank = lazyRerankPort("file:/rerank.gguf", create);
  expect(embedding.getIdentity?.()).toBeUndefined();
  expect(generation.structuredOutput).toBe("json_schema");
  expect(http.structuredOutput).toBe("none");
  await Promise.all(
    [embedding, generation, http, rerank].map((port) => port.dispose())
  );
  expect(calls).toBe(0);
});

test("first work resolves under the captured factory and preserves retryable creation failures", async () => {
  let calls = 0;
  const port = lazyEmbeddingPort("file:/embed.gguf", async () => {
    calls++;
    return failure;
  });
  expect(await port.embed("first")).toEqual(failure);
  expect(await port.embedBatch(["second"])).toEqual(failure);
  expect(calls).toBe(2);
  await port.dispose();
});

test("concurrent first calls share creation and shutdown disposes late owner once", async () => {
  let complete!: (value: LlmResult<EmbeddingPort>) => void;
  let creations = 0;
  let disposals = 0;
  const pending = new Promise<LlmResult<EmbeddingPort>>((resolve) => {
    complete = resolve;
  });
  const port = lazyEmbeddingPort("file:/embed.gguf", () => {
    creations++;
    return pending;
  });
  const first = port.init();
  const second = port.embed("queued");
  const closing = port.dispose();
  complete({
    ok: true,
    value: {
      dispose: async () => {
        disposals++;
      },
    } as EmbeddingPort,
  });
  expect((await first).ok).toBe(false);
  expect((await second).ok).toBe(false);
  await closing;
  await port.dispose();
  expect({ creations, disposals }).toEqual({ creations: 1, disposals: 1 });
});
