import { afterEach, expect, test } from "bun:test";
// Bun has no temporary-directory creation API.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NativeWorkerClient } from "../../src/llm/native-worker/client";
import {
  frameNativeMessage,
  NativeFrameDecoder,
} from "../../src/llm/native-worker/protocol";
import {
  nativeWorkerEnvironment,
  NativeRegistrationSchema,
  NativeRuntimeConfigSchema,
} from "../../src/llm/native-worker/runtime-config";

const clients: NativeWorkerClient[] = [];
const root = await mkdtemp(join(tmpdir(), "gno-native-runtime-"));
const fixture = join(root, "fake.ts");

test("native environment retains only canonical CUDA directory and control sizes are bounded", () => {
  const previous = process.env.CUDA_PATH;
  try {
    process.env.CUDA_PATH = root;
    expect(nativeWorkerEnvironment().CUDA_PATH).toBe(root);
    expect(nativeWorkerEnvironment().HOME).toBeUndefined();
    expect(nativeWorkerEnvironment().GNO_LLAMA_BUILD).toBe("never");
    process.env.CUDA_PATH = "relative";
    expect(nativeWorkerEnvironment().CUDA_PATH).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.CUDA_PATH;
    else process.env.CUDA_PATH = previous;
  }
  const model = {
    id: "large",
    type: "embed",
    modelUri: "x".repeat(16384),
    path: "/approved.gguf",
  };
  expect(NativeRegistrationSchema.safeParse({ register: model }).success).toBe(
    false
  );
  expect(
    NativeRuntimeConfigSchema.safeParse({
      generation: 1,
      models: [model],
      loadTimeout: 1000,
      inferenceTimeout: 1000,
    }).success
  ).toBe(false);
});
const protocol = new URL(
  "../../src/llm/native-worker/protocol.ts",
  import.meta.url
).href;
await Bun.write(
  fixture,
  `
import {NativeFrameDecoder,frameNativeMessage} from ${JSON.stringify(protocol)};
const config=JSON.parse(process.argv[2]);
const decoder=new NativeFrameDecoder(config.generation);
let timer;
let hanging=false;
process.on('disconnect',()=>process.exit(0));
process.on('message',async message=>{
 if(message==='shutdown') process.exit(0);
 if(message?.cancel){ if (message.cancel && hanging) process.exit(0); return; }
 if(message?.register){config.models.push(message.register);return;}
 if(message?.ack){clearTimeout(timer);timer=setTimeout(()=>process.send('idle'),config.warmModelTtl);return;}
 clearTimeout(timer);
 const request=decoder.push(message);if(!request)return;
 console.log('native stdout is not protocol');
 if(request.text==='crash')process.exit(42);
 if(request.text==='hang'){hanging=true;process.send({version:1,generation:request.generation,requestId:request.requestId,executionStarted:true});return;}
 if(request.text==='malformed'){process.send('broken');return;}
 await Bun.sleep(5);
 const value=request.op==='embedBatch'?request.texts.map(t=>[t.length]):[request.text.length];
 for(const frame of frameNativeMessage({version:1,generation:request.generation,requestId:request.requestId,op:request.op,result:{ok:true,value}}))process.send(frame);
});
setTimeout(()=>process.send('ready'),20);
`
);

function client(inferenceTimeout = 1000): NativeWorkerClient {
  const value = new NativeWorkerClient({
    models: [
      {
        id: "embed",
        type: "embed",
        modelUri: "file:/approved.gguf",
        path: "/approved.gguf",
      },
    ],
    loadTimeout: 1000,
    inferenceTimeout,
    warmModelTtl: 30,
    entryPath: fixture,
  });
  clients.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((value) => value.dispose()));
});

test("real child startup is shared, queue bounded, batches ordered and stdout isolated", async () => {
  const owner = client();
  const calls = Array.from({ length: 65 }, (_, i) =>
    owner.request({ op: "embed", modelId: "embed", text: "x".repeat(i + 1) })
  );
  const excess = await owner.request({
    op: "embed",
    modelId: "embed",
    text: "overload",
  });
  expect(excess).toMatchObject({
    ok: false,
    error: { message: "Native worker failure: overloaded" },
  });
  const results = await Promise.all(calls);
  expect(results).toEqual(
    Array.from({ length: 65 }, (_, i) => ({ ok: true, value: [i + 1] }))
  );
  expect(owner.currentGeneration).toBe(1);
  expect(
    await owner.request({
      op: "embedBatch",
      modelId: "embed",
      texts: ["β", "hello", ""],
    })
  ).toEqual({ ok: true, value: [[1], [5], [0]] });
});

test.each(["crash", "malformed", "hang"])(
  "real child %s fails pending calls once and next generation recovers",
  async (text) => {
    const owner = client(10);
    const results = await Promise.all([
      owner.request({ op: "embed", modelId: "embed", text }),
      owner.request({ op: "embed", modelId: "embed", text: "queued" }),
    ]);
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(
      await owner.request({ op: "embed", modelId: "embed", text: "next" })
    ).toEqual({ ok: true, value: [4] });
    expect(owner.currentGeneration).toBe(2);
  }
);

test("idle retirement reaps process and reacquires; shutdown during startup settles admission", async () => {
  const owner = client();
  expect(
    (await owner.request({ op: "embed", modelId: "embed", text: "first" })).ok
  ).toBe(true);
  await Bun.sleep(100);
  expect(owner.processId).toBeUndefined();
  expect(
    (await owner.request({ op: "embed", modelId: "embed", text: "second" })).ok
  ).toBe(true);
  expect(owner.currentGeneration).toBe(2);
  const starting = client();
  const request = starting.request({
    op: "embed",
    modelId: "embed",
    text: "cancelled",
  });
  await starting.dispose();
  expect((await request).ok).toBe(false);
  expect(starting.processId).toBeUndefined();
});

test("approved role additions reuse child; same identity replacement drains and restarts", async () => {
  const owner = client();
  await owner.request({ op: "embed", modelId: "embed", text: "warm" });
  const firstPid = owner.processId;
  await owner.registerModel({
    id: "second",
    type: "embed",
    modelUri: "file:/second.gguf",
    path: "/second.gguf",
  });
  expect(
    await owner.request({ op: "embed", modelId: "second", text: "two" })
  ).toEqual({ ok: true, value: [3] });
  expect(owner.processId).toBe(firstPid);
  const pending = owner.request({
    op: "embed",
    modelId: "embed",
    text: "drain",
  });
  await owner.registerModel({
    id: "embed",
    type: "embed",
    modelUri: "file:/replacement.gguf",
    path: "/replacement.gguf",
  });
  expect((await pending).ok).toBe(true);
  expect(
    (await owner.request({ op: "embed", modelId: "embed", text: "new" })).ok
  ).toBe(true);
  expect(owner.currentGeneration).toBe(2);
  expect(() =>
    owner.registerModel({
      id: "invalid",
      type: "embed",
      modelUri: "file:relative",
      path: "relative",
    })
  ).toThrow();
});

test("startup timeout kills its actual child and settles the waiting request", async () => {
  const entryPath = join(root, "never-ready.ts");
  await Bun.write(
    entryPath,
    "process.on('message', () => {}); process.on('disconnect', () => process.exit(0));"
  );
  const owner = new NativeWorkerClient({
    models: [
      {
        id: "embed",
        type: "embed",
        modelUri: "file:/approved.gguf",
        path: "/approved.gguf",
      },
    ],
    loadTimeout: 30,
    inferenceTimeout: 30,
    entryPath,
  });
  clients.push(owner);
  expect(
    await owner.request({ op: "embed", modelId: "embed", text: "waiting" })
  ).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
  await owner.dispose();
  expect(owner.processId).toBeUndefined();
});

test("production entry holds pending delivery, metadata does not renew TTL, parent IPC EOF exits", async () => {
  const path = join(root, "model.gguf");
  await Bun.write(path, "No native load: metadata-only generation init");
  const config = {
    generation: 1,
    models: [{ id: "gen", type: "gen", modelUri: `file:${path}`, path }],
    loadTimeout: 1000,
    inferenceTimeout: 1000,
    warmModelTtl: 40,
  };
  const messages: unknown[] = [];
  const decoder = new NativeFrameDecoder(1);
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--no-env-file",
      new URL("../../src/llm/native-worker/entry.ts", import.meta.url).pathname,
      JSON.stringify(config),
    ],
    env: nativeWorkerEnvironment(),
    stdout: "ignore",
    stderr: "pipe",
    stdin: "ignore",
    serialization: "advanced",
    ipc(message) {
      messages.push(
        message instanceof Uint8Array ? decoder.push(message) : message
      );
    },
  });
  async function waitFor(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 2000;
    while (!check() && Date.now() < deadline) await Bun.sleep(5);
    expect(check()).toBe(true);
  }
  try {
    await waitFor(() => messages.includes("ready"));
    for (const frame of frameNativeMessage({
      version: 1,
      generation: 1,
      requestId: 1,
      modelId: "gen",
      op: "init",
    }))
      child.send(frame);
    await waitFor(() =>
      messages.some(
        (message) =>
          typeof message === "object" && message !== null && "result" in message
      )
    );
    await Bun.sleep(70);
    expect(messages.includes("idle")).toBe(false);
    child.send({ ack: 1 });
    await waitFor(() => messages.includes("idle"));
    // An idle proposal alone never exits: parent must confirm no waiting callers.
    expect(child.exitCode).toBeNull();
    child.disconnect();
    expect(await child.exited).toBe(0);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
});
