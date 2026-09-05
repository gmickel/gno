import { expect, test } from "bun:test";

import type { ModelManager } from "../../src/llm/nodeLlamaCpp/lifecycle";

import { NodeLlamaCppRerank } from "../../src/llm/nodeLlamaCpp/rerank";
import { RERANK_TEMPLATE } from "../../src/llm/nodeLlamaCpp/rerank-capacity";

function fixture() {
  const contexts: Array<{ size: number | undefined; disposed: boolean }> = [];
  const inputs: Array<{ query: string; documents: string[] }> = [];
  let leases = 0;
  let loads = 0;
  let failCreation = false;
  let failScoring = false;
  let incomplete = false;
  let beforeScore: (() => Promise<void>) | undefined;
  const makeModel = () => ({
    disposed: false,
    fileInfo: {
      metadata: {
        general: { architecture: "qwen3" },
        tokenizer: { "chat_template.rerank": RERANK_TEMPLATE },
      },
    },
    vocabularyType: "bpe",
    tokens: {},
    tokenize: (text: string) => Array.from(text, () => 1),
    tokenizer: (text: string) => Array.from(text, () => 1),
    trainContextSize: 8192,
    async createRankingContext(options: { contextSize?: number }) {
      expect(leases).toBeGreaterThan(0);
      if (failCreation) throw new Error("creation failed");
      const context = {
        size: options.contextSize,
        disposed: false,
        async rankAndSort(query: string, documents: string[]) {
          expect(leases).toBeGreaterThan(0);
          await beforeScore?.();
          expect(context.disposed).toBe(false);
          if (failScoring) throw new Error("scoring failed");
          inputs.push({ query, documents: [...documents] });
          const ranked = documents
            .map((document) => ({
              document,
              score: document.startsWith("best") ? 0.9 : 0.5,
            }))
            .sort((a, b) => b.score - a.score);
          return incomplete ? ranked.slice(1) : ranked;
        },
        async dispose() {
          context.disposed = true;
        },
      };
      contexts.push(context);
      return context;
    },
  });
  let model = makeModel();
  const manager = {
    acquireLease() {
      leases += 1;
      return {
        release() {
          leases -= 1;
        },
      };
    },
    async loadModel() {
      loads += 1;
      return { ok: true, value: { model } };
    },
  } as unknown as ModelManager;
  return {
    port: new NodeLlamaCppRerank(manager, "fixture", "fixture.gguf"),
    contexts,
    inputs,
    get leases() {
      return leases;
    },
    get loads() {
      return loads;
    },
    get model() {
      return model;
    },
    expire() {
      expect(leases).toBe(0);
      model.disposed = true;
      for (const context of contexts) context.disposed = true;
      model = makeModel();
    },
    set failCreation(value: boolean) {
      failCreation = value;
    },
    set failScoring(value: boolean) {
      failScoring = value;
    },
    set incomplete(value: boolean) {
      incomplete = value;
    },
    set beforeScore(value: (() => Promise<void>) | undefined) {
      beforeScore = value;
    },
  };
}

test("short-long-short replaces idle contexts, reuses buckets and preserves ties and duplicates", async () => {
  const f = fixture();
  const docs = ["same", "best", "same", "tie"];
  const short = await f.port.rerank("query", docs);
  expect(short).toEqual({
    ok: true,
    value: [
      { index: 1, score: 0.9, rank: 1 },
      { index: 0, score: 0.5, rank: 2 },
      { index: 2, score: 0.5, rank: 3 },
      { index: 3, score: 0.5, rank: 4 },
    ],
  });
  expect(await f.port.rerank("query", docs)).toEqual(short);
  expect(f.contexts).toHaveLength(1);
  const longDocs = docs.map((doc) => `${doc}${"中".repeat(3000)}`);
  expect(await f.port.rerank("query", longDocs)).toEqual(short);
  expect(await f.port.rerank("query", docs)).toEqual(short);
  expect(f.contexts.map((c) => c.disposed)).toEqual([true, true, false]);
  expect(f.contexts[1]?.size).toBeGreaterThan(f.contexts[0]?.size ?? 0);
  expect(f.contexts[2]?.size).toBe(f.contexts[0]?.size);
  expect(f.inputs.map((i) => i.documents)).toEqual([
    docs,
    docs,
    longDocs,
    docs,
  ]);
  await f.port.dispose();
  expect(f.contexts.every((c) => c.disposed)).toBe(true);
  expect(f.leases).toBe(0);
});

test("concurrent different buckets and disposal drain scoring before replacement", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  f.beforeScore = async () => {
    entered.resolve();
    await finish.promise;
  };
  const first = f.port.rerank("q", ["short"]);
  await entered.promise;
  const docs = ["long".repeat(1000)];
  const second = f.port.rerank("q", docs);
  docs[0] = "caller mutation";
  const disposing = f.port.dispose();
  expect(f.contexts).toHaveLength(1);
  expect(f.contexts[0]?.disposed).toBe(false);
  expect(f.leases).toBe(1);
  finish.resolve();
  expect((await first).ok).toBe(true);
  expect((await second).ok).toBe(true);
  await disposing;
  expect(f.inputs[1]?.documents).toEqual(["long".repeat(1000)]);
  expect(f.contexts.every((c) => c.disposed)).toBe(true);
  expect((await f.port.rerank("q", ["closed"])).ok).toBe(false);
  expect(f.leases).toBe(0);
});

test("model expiry replaces a disposed generation", async () => {
  const f = fixture();
  const first = await f.port.rerank("q", ["doc"]);
  f.expire();
  expect(await f.port.rerank("q", ["doc"])).toEqual(first);
  expect(f.contexts).toHaveLength(2);
  expect(f.contexts[0]?.disposed).toBe(true);
  await f.port.dispose();
});

test("creation, scoring and incomplete output failures are structured and never cached", async () => {
  for (const failure of [
    "failCreation",
    "failScoring",
    "incomplete",
  ] as const) {
    const f = fixture();
    await f.port.rerank("q", ["doc"]);
    f[failure] = true;
    const result = await f.port.rerank("q", ["中".repeat(3000)]);
    expect(result.ok).toBe(false);
    expect(f.contexts.every((c) => c.disposed)).toBe(true);
    expect(f.leases).toBe(0);
    f[failure] = false;
    expect((await f.port.rerank("q", ["doc"])).ok).toBe(true);
    await f.port.dispose();
  }
});

test("empty input allocates nothing; unsupported contracts use auto without clipping", async () => {
  const f = fixture();
  expect(await f.port.rerank("q", [])).toEqual({ ok: true, value: [] });
  expect(f.loads).toBe(0);
  expect(f.contexts).toHaveLength(0);
  f.model.fileInfo.metadata.general.architecture = "unknown";
  const query = "long query".repeat(200);
  const documents = ["large document".repeat(300)];
  expect((await f.port.rerank(query, documents)).ok).toBe(true);
  expect(f.contexts[0]?.size).toBeUndefined();
  expect(f.inputs).toEqual([{ query, documents }]);
  f.model.fileInfo.metadata.tokenizer["chat_template.rerank"] =
    "different unsupported template";
  expect((await f.port.rerank(query, documents)).ok).toBe(true);
  expect(f.contexts).toHaveLength(2);
  expect(f.contexts[0]?.disposed).toBe(true);
  await f.port.dispose();
});

test("known over-model-limit input fails before allocation with no partial scoring", async () => {
  const f = fixture();
  const result = await f.port.rerank("q".repeat(9000), ["short", "中"]);
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.error.cause).toEqual({
      name: "RangeError",
      message: expect.stringContaining("supports 8192"),
    });
  expect(f.contexts).toHaveLength(0);
  expect(f.inputs).toHaveLength(0);
  expect(f.leases).toBe(0);
});
