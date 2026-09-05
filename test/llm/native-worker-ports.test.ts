import { afterEach, expect, spyOn, test } from "bun:test";
// Bun has no temporary-directory creation API.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AcceptanceRecord } from "../../evals/acceptance/records";

import { compareAcceptance } from "../../evals/acceptance/compare";
import {
  acceptanceManifestFingerprint,
  type AcceptanceManifest,
} from "../../evals/acceptance/manifest";
import { ConfigSchema } from "../../src/config/types";
import { HttpGeneration } from "../../src/llm/httpGeneration";
import { NativeWorkerClient } from "../../src/llm/native-worker/client";
import {
  NativeEmbeddingPort,
  NativeGenerationPort,
  NativeRerankPort,
} from "../../src/llm/native-worker/ports";
import { EmbeddingIdentitySchema } from "../../src/llm/native-worker/protocol";
import { LlmAdapter } from "../../src/llm/nodeLlamaCpp/adapter";
import { NodeLlamaCppEmbedding } from "../../src/llm/nodeLlamaCpp/embedding";

const root = await mkdtemp(join(tmpdir(), "gno-port-ipc-"));
const fixture = join(root, "child.ts");
const capture = join(root, "capture.json");
const clients: NativeWorkerClient[] = [];
const identity = {
  contextSize: 2048,
  truncationPolicy: "truncate-tail-tokens-v1:limit=2044",
  modelFingerprint: "a".repeat(64),
  runtimeFingerprint: "b".repeat(64),
};

test("native embedding identity rejects unknown limits and unverified fingerprints", () => {
  for (const change of [
    { contextSize: 0 },
    { contextSize: null },
    { modelFingerprint: "uri-only" },
    { runtimeFingerprint: "unknown" },
    { guessed: true },
  ]) {
    expect(
      EmbeddingIdentitySchema.safeParse({ ...identity, ...change }).success
    ).toBe(false);
  }
});
await Bun.write(
  fixture,
  `
import {NativeFrameDecoder, frameNativeMessage} from ${JSON.stringify(new URL("../../src/llm/native-worker/protocol.ts", import.meta.url).href)};
const config = JSON.parse(process.argv[2]);
const decoder = new NativeFrameDecoder(config.generation);
const calls = [];
let timer;
process.on('disconnect', () => process.exit(0));
process.on('message', async message => {
 if (message === 'shutdown') process.exit(0);
 if (message?.cancel) return;
 if (message?.register) { config.models.push(message.register); return; }
 if (message?.ack) { timer = setTimeout(() => process.send('idle'), config.warmModelTtl); return; }
 clearTimeout(timer);
 const request = decoder.push(message); if (!request) return;
 const {version, generation, requestId, ...input} = request;
 calls.push(input);
 await Bun.write(${JSON.stringify(capture)}, JSON.stringify(calls));
 if (request.text === 'crash') process.exit(42);
 if (request.text === 'late') { await Bun.sleep(2000); }
 let value;
 switch (request.op) {
 case 'init': value = {dimensions: 3, structuredOutput: 'none', embeddingIdentity: ${JSON.stringify(identity)}}; break;
 case 'embed': value = request.text === 'malformed' ? [] : request.text === 'wrong-dimensions' ? [1, 2] : [0.123456789012345, -0.5, request.text.length]; break;
 case 'embedBatch': value = request.texts.map(text => [0.123456789012345, -0.5, text.length]); break;
 case 'generate': value = JSON.stringify({prompt: request.prompt, params: request.params}); break;
 case 'rerank': value = request.documents.map((text, index) => ({index, rank: index + 1, score: text.length / 7})); break;
 case 'dispose': value = null; break;
 }
 if(request.op==='init' && request.modelId==='metadata-failure') delete value.embeddingIdentity;
 for (const frame of frameNativeMessage({version, generation, requestId, op: request.op, lifecycle: {activeLeases:1,leaseAcquisitions:1,leaseReleases:0,loadedModels:1,loadAttempts:1,loadSuccesses:1,loadFailures:0,inflightLoads:0}, result: {ok:true, value}})) process.send(frame);
});
process.send('ready');
`
);

function createClient(warmModelTtl = 30) {
  const client = new NativeWorkerClient({
    models: ["embed", "gen", "rerank"].map((type) => ({
      id: type,
      type: type as "embed" | "gen" | "rerank",
      modelUri: `file:/${type}.gguf`,
      path: `/${type}.gguf`,
    })),
    entryPath: fixture,
    loadTimeout: 300,
    inferenceTimeout: 300,
    warmModelTtl,
  });
  clients.push(client);
  return client;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose()));
});

test("direct single/batch inference loads actual identity once per generation and reacquires after idle", async () => {
  const client = createClient(0);
  const port = new NativeEmbeddingPort(client, "embed", "file:/embed.gguf");
  expect(await port.embedBatch([])).toEqual({ ok: true, value: [] });
  expect(client.processId).toBeUndefined();
  for (const [name, operation] of [
    ["embed", () => port.embed("direct")],
    ["embedBatch", () => port.embedBatch(["direct"])],
  ] as const) {
    expect((await operation()).ok).toBe(true);
    expect(port.getIdentity()).toEqual(identity);
    expect(port.dimensions()).toBe(3);
    const calls = await Bun.file(capture).json();
    expect(calls.map((call: { op: string }) => call.op)).toEqual([
      "init",
      name,
    ]);
    expect(calls).toHaveLength(2);
    for (let i = 0; client.processId !== undefined && i < 100; i++)
      await Bun.sleep(5);
    expect(client.processId).toBeUndefined();
    expect(port.getIdentity()).toBeUndefined();
  }
  expect(client.currentGeneration).toBe(2);
});

test("missing native identity fails before inference with no replay", async () => {
  const client = createClient();
  await client.registerModel({
    id: "metadata-failure",
    type: "embed",
    modelUri: "file:/bad.gguf",
    path: "/bad.gguf",
  });
  const port = new NativeEmbeddingPort(
    client,
    "metadata-failure",
    "file:/bad.gguf"
  );
  expect((await port.embed("never evaluated")).ok).toBe(false);
  expect(port.getIdentity()).toBeUndefined();
  expect(
    (await Bun.file(capture).json()).map((call: { op: string }) => call.op)
  ).toEqual(["init"]);
});

test("cold concurrent direct calls share metadata without phantom inference capacity or replay", async () => {
  const client = createClient(1000);
  const port = new NativeEmbeddingPort(client, "embed", "file:/embed.gguf");
  const results = await Promise.all(
    Array.from({ length: 66 }, () => port.embed("capacity"))
  );
  expect(results.filter((result) => result.ok)).toHaveLength(65);
  expect(results.filter((result) => !result.ok)).toHaveLength(1);
  expect(port.getIdentity()).toEqual(identity);
  const calls = await Bun.file(capture).json();
  expect(
    calls.filter((call: { op: string }) => call.op === "init")
  ).toHaveLength(1);
  expect(
    calls.filter((call: { op: string }) => call.op === "embed")
  ).toHaveLength(65);
});

function compareTranscript(expected: unknown, actual: unknown): void {
  const hash = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(expected))
    .digest("hex");
  const baseline: AcceptanceManifest = {
    schemaVersion: "gno-acceptance-v1",
    role: "baseline",
    identity: {
      commit: "a".repeat(40),
      indexId: "port-baseline",
      indexSha256: hash,
      bunVersion: Bun.version,
      nativeDependencies: {},
      platform: process.platform,
      architecture: process.arch,
    },
    fixtureVersion: "native-port-ipc-v1",
    fixtures: [{ path: "synthetic-transcript.json", sha256: hash }],
    models: [
      {
        role: "embedding",
        id: "embed",
        sha256: identity.modelFingerprint,
        tokenizerSha256: identity.modelFingerprint,
      },
    ],
    cases: [
      {
        caseId: "ports",
        fixtureSha256: hash,
        surface: "sdk",
        preset: "balanced",
        configuration: { fakeChild: true },
      },
    ],
    intendedDeltas: [],
  };
  const candidate: AcceptanceManifest = {
    ...baseline,
    role: "candidate",
    identity: {
      ...baseline.identity,
      indexId: "port-candidate",
      commit: "b".repeat(40),
    },
  };
  const record = (
    manifest: AcceptanceManifest,
    transcript: unknown
  ): AcceptanceRecord => ({
    schemaVersion: "gno-acceptance-v1",
    manifestSha256: acceptanceManifestFingerprint(manifest),
    caseId: "ports",
    deterministic: {
      scope: { transcript: JSON.parse(JSON.stringify(transcript)) },
      results: [],
      citations: [],
      modelInputs: [],
      semanticState: {
        status: "ok",
        vectorsUsed: false,
        vectorStatus: "not-requested",
        error: null,
        fallbacks: [],
        verification: null,
      },
    },
    generatedAnswer: null,
    transport: {},
  });
  expect(
    compareAcceptance(
      baseline,
      candidate,
      [record(baseline, expected)],
      [record(candidate, actual)]
    )
  ).toMatchObject({ passed: true, comparedCases: 1, failures: [] });
}

test("actual IPC preserves exact all-port inputs/full outputs across warm reuse and restart via fn143 comparator", async () => {
  const client = createClient();
  const embed = new NativeEmbeddingPort(client, "embed", "file:/embed.gguf");
  const gen = new NativeGenerationPort(client, "gen", "file:/gen.gguf");
  const rerank = new NativeRerankPort(client, "rerank", "file:/rerank.gguf");
  const params = {
    temperature: 0,
    seed: 42,
    maxTokens: 7,
    contextSize: 2048,
    stop: ["\r\n"],
    jsonSchema: { type: "object", additionalProperties: false },
  };
  const text = "exact\r\n雪";
  const texts = [text, "", "tail"];
  const expectedInputs = [
    { op: "init", modelId: "embed" },
    { op: "embed", modelId: "embed", text },
    { op: "embedBatch", modelId: "embed", texts },
    { op: "generate", modelId: "gen", prompt: text, params },
    { op: "rerank", modelId: "rerank", query: text, documents: texts },
  ];
  for (let cycle = 0; cycle < 2; cycle++) {
    const lease = client.acquireLease();
    expect(await embed.init()).toEqual({ ok: true, value: undefined });
    expect(embed.dimensions()).toBe(3);
    expect(embed.getIdentity()).toEqual(identity);
    expect(gen.structuredOutput).toBe("json_schema");
    const pid = client.processId;
    const outputs = [
      await embed.embed(text),
      await embed.embedBatch(texts),
      await gen.generate(text, params),
      await rerank.rerank(text, texts),
    ];
    expect(client.processId).toBe(pid);
    compareTranscript(
      {
        inputs: expectedInputs,
        outputs: [
          { ok: true, value: [0.123456789012345, -0.5, text.length] },
          {
            ok: true,
            value: texts.map((value) => [
              0.123456789012345,
              -0.5,
              value.length,
            ]),
          },
          { ok: true, value: JSON.stringify({ prompt: text, params }) },
          {
            ok: true,
            value: texts.map((value, index) => ({
              index,
              rank: index + 1,
              score: value.length / 7,
            })),
          },
        ],
      },
      { inputs: await Bun.file(capture).json(), outputs }
    );
    await Bun.sleep(70);
    expect(client.processId).toBe(pid);
    lease.release();
    lease.release();
    for (let attempt = 0; client.processId && attempt < 50; attempt++)
      await Bun.sleep(10);
    expect(client.processId).toBeUndefined();
    expect(embed.getIdentity()).toBeUndefined();
  }
  expect(client.currentGeneration).toBe(2);
});

test.each(["malformed", "wrong-dimensions", "crash", "late"])(
  "%s result fails closed without replay and next explicit call recovers",
  async (fault) => {
    const client = createClient();
    const port = new NativeEmbeddingPort(client, "embed", "file:/embed.gguf");
    expect((await port.init()).ok).toBe(true);
    expect((await port.embed(fault)).ok).toBe(false);
    const calls = await Bun.file(capture).json();
    expect(
      calls.filter((call: { text?: string }) => call.text === fault)
    ).toHaveLength(1);
    expect(await port.embed("valid")).toEqual({
      ok: true,
      value: [0.123456789012345, -0.5, 5],
    });
  }
);

test("model disposal drains calls, retires owner and closed adapter cannot replay work", async () => {
  const client = createClient();
  const port = new NativeEmbeddingPort(client, "embed", "file:/embed.gguf");
  expect((await port.init()).ok).toBe(true);
  const pending = port.embed("valid");
  await Bun.sleep(10);
  await client.disposeModel("file:/embed.gguf");
  expect((await pending).ok).toBe(true);
  expect(client.processId).toBeUndefined();
  expect((await port.embed("again")).ok).toBe(true);
  await client.dispose();
  expect((await port.embed("closed")).ok).toBe(false);
});

test("retirement racing cold metadata rejects inference before replacement admission", async () => {
  const client = createClient();
  const port = new NativeEmbeddingPort(client, "embed", "file:/embed.gguf");
  const pending = port.embed("must not replay");
  while (client.processId === undefined) await Bun.sleep(1);
  await client.disposeModel("file:/embed.gguf");
  expect((await pending).ok).toBe(false);
  expect(client.currentGeneration).toBe(1);
  expect(client.processId).toBeUndefined();
  expect(port.getIdentity()).toBeUndefined();
  expect(
    (await Bun.file(capture).json()).map((call: { op: string }) => call.op)
  ).toEqual(["init"]);
  expect((await port.embed("explicit recovery")).ok).toBe(true);
  expect(port.getIdentity()).toEqual(identity);
});

test("adapter registers approved paths lazily and leaves HTTP generation on its existing adapter", async () => {
  const adapter = new LlmAdapter(
    ConfigSchema.parse({ version: "1.0", collections: [] })
  );
  const file = join(root, "model.gguf");
  await Bun.write(
    file,
    "synthetic model; cache preflight is independently tested"
  );
  const ensure = spyOn(adapter.getCache(), "ensureModel").mockResolvedValue({
    ok: true,
    value: file,
  });
  try {
    const generation = await adapter.createGenerationPort(`file:${file}`, {
      egressCollections: [],
    });
    expect(generation.ok && generation.value).toBeInstanceOf(
      NativeGenerationPort
    );
    expect(ensure).toHaveBeenCalledTimes(1);
    const http = await adapter.createGenerationPort(
      "http://127.0.0.1:9999/v1#model=test",
      { egressCollections: [] }
    );
    expect(http.ok && http.value).toBeInstanceOf(HttpGeneration);
    expect(ensure).toHaveBeenCalledTimes(1);
  } finally {
    ensure.mockRestore();
    await adapter.dispose();
  }
});

test("npm source entrypoint exists in package publish surface and production init needs no native backend", async () => {
  const pkg = await Bun.file(
    new URL("../../package.json", import.meta.url)
  ).json();
  expect(pkg.files).toContain("src");
  expect(
    await Bun.file(
      new URL("../../src/llm/native-worker/entry.ts", import.meta.url)
    ).exists()
  ).toBe(true);
  const file = join(root, "metadata.gguf");
  await Bun.write(file, "metadata only");
  const client = new NativeWorkerClient({
    models: [{ id: "gen", type: "gen", modelUri: `file:${file}`, path: file }],
    loadTimeout: 3000,
    inferenceTimeout: 1000,
  });
  clients.push(client);
  expect(await client.request({ op: "init", modelId: "gen" })).toEqual({
    ok: true,
    value: { structuredOutput: "json_schema" },
  });
});

test("child embedding context replacement invalidates tokenizer, dimensions and effective policy", async () => {
  let generation = 1;
  let disposed = false;
  const manager = {
    getLlama: async () => ({ gpu: "cuda", cpuMathCores: 4 }),
    loadModel: async () => {
      const current = generation;
      return {
        ok: true,
        value: {
          model: {
            embeddingVectorSize: current,
            trainContextSize: current + 4,
            tokenize: () => Array.from({ length: current + 1 }, () => current),
            createEmbeddingContext: async () => ({
              get disposed() {
                return disposed && current === 1;
              },
              dispose: async () => {},
              getEmbeddingFor: async (input: number[]) => ({ vector: input }),
            }),
          },
        },
      };
    },
  };
  const port = new NodeLlamaCppEmbedding(
    manager as never,
    "test",
    "/synthetic.gguf"
  );
  expect(await port.embed("exact input")).toEqual({ ok: true, value: [1] });
  expect(port.dimensions()).toBe(1);
  expect(port.getContextIdentity().truncationPolicy).toBe(
    "truncate-tail-tokens-v1:limit=1"
  );
  disposed = true;
  generation = 2;
  expect(await port.embed("exact input")).toEqual({ ok: true, value: [2, 2] });
  expect(port.dimensions()).toBe(2);
  expect(port.getContextIdentity().truncationPolicy).toBe(
    "truncate-tail-tokens-v1:limit=2"
  );
  await port.dispose();
  expect(() => port.getContextIdentity()).toThrow("not initialized");
});

test("disposal while awaiting model load prevents late tokenizer/context publication", async () => {
  const loaded = Promise.withResolvers<unknown>();
  let disposed = 0;
  const port = new NodeLlamaCppEmbedding(
    {
      loadModel: () => loaded.promise,
      getLlama: async () => ({ gpu: "cuda", cpuMathCores: 4 }),
    } as never,
    "test",
    "/synthetic.gguf"
  );
  const initializing = port.init();
  await port.dispose();
  loaded.resolve({
    ok: true,
    value: {
      model: {
        embeddingVectorSize: 2,
        createEmbeddingContext: async () => ({
          dispose: async () => {
            disposed++;
          },
        }),
      },
    },
  });
  expect((await initializing).ok).toBe(false);
  expect(disposed).toBe(1);
  expect(() => port.dimensions()).toThrow("initialize dimensions");
  expect(() => port.getContextIdentity()).toThrow("not initialized");
});

test("cached lifecycle polling cannot postpone native child idle retirement", async () => {
  const client = createClient();
  const port = new NativeEmbeddingPort(client, "embed", "file:/embed.gguf");
  expect((await port.embed("metadata-poll")).ok).toBe(true);
  expect(client.getLifecycleStats().loadedModels).toBe(1);
  const deadline = Date.now() + 2000;
  while (client.processId !== undefined && Date.now() < deadline) {
    client.getLifecycleStats();
    await Bun.sleep(5);
  }
  expect(client.processId).toBeUndefined();
  expect(client.getLifecycleStats().loadedModels).toBe(0);
  expect(client.getLifecycleStats().loadSuccesses).toBe(1);
  expect((await port.embed("metadata-poll")).ok).toBe(true);
  expect(client.getLifecycleStats().loadedModels).toBe(1);
});
