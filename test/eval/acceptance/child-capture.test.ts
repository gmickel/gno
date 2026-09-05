import { expect, test } from "bun:test";
// Bun has no temporary-directory, canonicalization, or symlink APIs.
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os"; // Bun has no OS temp-directory API.
import { join } from "node:path"; // Bun has no path helpers.

import {
  emptyCapture,
  captureArguments,
  captureContextArguments,
  captureContextModelArguments,
} from "../../../evals/acceptance/capture-contract";
import {
  appendChildCapture,
  validateChildReceipt,
  type ChildIdentity,
  type ChildReceipt,
} from "../../../evals/acceptance/child-receipt";
import { installNativeCapture } from "../../../evals/acceptance/native-capture";
import { installParentCapture } from "../../../evals/acceptance/parent-capture";
import {
  frameNativeMessage,
  NativeFrameDecoder,
  type NativeRequest,
} from "../../../src/llm/native-worker/protocol";
import { nativeWorkerEnvironment } from "../../../src/llm/native-worker/runtime-config";
import { ModelManager } from "../../../src/llm/nodeLlamaCpp/lifecycle";

const identity: ChildIdentity = {
  runId: "test",
  token: "12345678-1234-4234-8234-123456789abc",
  parentPid: 10,
  pid: 11,
  generation: 1,
  entry: "/selected/entry.ts",
};

test("child capture transparently forwards operational arguments and exact request", async () => {
  const { chmod, readdir } = await import("node:fs/promises");
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "gno-capture-forward-"))
  );
  const entry = join(process.cwd(), "src/llm/native-worker/entry.ts");
  const preload = join(
    process.cwd(),
    "evals/acceptance/native-child-preload.ts"
  );
  const dispatcher = join(process.cwd(), "src/llm/native-worker/dispatcher.ts");
  const bootstrap = join(root, "bootstrap.json");
  const exactRequest = {
    version: 1,
    generation: 1,
    requestId: 42,
    op: "generate",
    modelId: "gen",
    prompt: "exact\r\n尾",
    params: { seed: 42, temperature: 0.125 },
  };
  try {
    await Bun.write(
      bootstrap,
      JSON.stringify({
        identity: { ...identity, parentPid: process.pid, entry },
        models: [],
      })
    );
    await chmod(bootstrap, 0o600);
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `
      process.argv[1] = ${JSON.stringify(entry)};
      process.argv[2] = JSON.stringify({generation:1,models:[],loadTimeout:1000,inferenceTimeout:1000,warmModelTtl:60000});
      const {NativeDispatcher} = await import(${JSON.stringify(dispatcher)});
      const request = ${JSON.stringify(exactRequest)};
      const controller = new AbortController();
      let started = 0;
      const options = {signal:controller.signal,onExecutionStart:()=>started++};
      const receiver = {};
      const {NodeLlamaCppEmbedding} = await import(${JSON.stringify(join(process.cwd(), "src/llm/nodeLlamaCpp/embedding.ts"))});
      const {NodeLlamaCppRerank} = await import(${JSON.stringify(join(process.cwd(), "src/llm/nodeLlamaCpp/rerank.ts"))});
      const {NodeLlamaCppGeneration} = await import(${JSON.stringify(join(process.cwd(), "src/llm/nodeLlamaCpp/generation.ts"))});
      const calls = [
        [NodeLlamaCppEmbedding,'embed',[request.prompt]],
        [NodeLlamaCppEmbedding,'embedBatch',[[request.prompt]]],
        [NodeLlamaCppRerank,'rerank',[request.prompt,[request.prompt]]],
        [NodeLlamaCppGeneration,'generate',[request.prompt,request.params]],
      ];
      const port = {modelUri:'exact-model'};
      for(const [Type, method, inputs] of calls) Type.prototype[method] = async function(...args) {
        if(this !== port || args.at(-1) !== options || inputs.some((input,i)=>args[i] !== input))
          throw Error('Port argument identity lost');
        args.at(-1).onExecutionStart();
        return {ok:true,value:'unchanged'};
      };
      NativeDispatcher.prototype.execute = async function(...args) {
        if(this !== receiver || args[0] !== request || args[1] !== options || args[1].signal !== controller.signal)
          throw Error('Operational argument identity lost');
        args[1].onExecutionStart();
        controller.abort();
        if(!args[1].signal.aborted) throw Error('Abort signal disconnected');
        for(const [Type,method,inputs] of calls) await Type.prototype[method].call(port,...inputs,options);
        return {response:{result:{ok:true,value:'unchanged'},lifecycle:{}},activity:true};
      };
      await import(${JSON.stringify(preload)});
      const result = await NativeDispatcher.prototype.execute.call(receiver,request,options);
      process.stdout.write(JSON.stringify({started,result}));
      `,
      ],
      {
        env: { ...process.env, GNO_ACCEPTANCE_CHILD_BOOTSTRAP: bootstrap },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({
      started: 5,
      result: { response: { result: { ok: true, value: "unchanged" } } },
    });
    const receipts = (await readdir(root)).filter((name) =>
      name.endsWith("-42.json")
    );
    expect(receipts).toHaveLength(1);
    const captured = await Bun.file(join(root, receipts[0]!)).json();
    expect(captured.request).toEqual(exactRequest);
    expect(captured.complete).toBe(true);
    expect(captured.request).not.toHaveProperty("signal");
    expect(captured.capture.modelInputs).toEqual([
      {
        role: "embedding",
        modelId: "exact-model",
        input: [exactRequest.prompt],
      },
      {
        role: "embedding",
        modelId: "exact-model",
        input: [[exactRequest.prompt]],
      },
      {
        role: "reranking",
        modelId: "exact-model",
        input: [exactRequest.prompt, [exactRequest.prompt]],
      },
      {
        role: "generation",
        modelId: "exact-model",
        input: [exactRequest.prompt, exactRequest.params],
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
const request: Extract<NativeRequest, { op: "embedBatch" }> = {
  version: 1,
  generation: 1,
  requestId: 1,
  op: "embedBatch",
  modelId: "embed",
  texts: ["exact\r\n", "尾"],
};
function receipt(): ChildReceipt {
  const capture = emptyCapture("test");
  capture.modelInputs = request.texts.map((text) => ({
    role: "embedding",
    modelId: "embed",
    input: captureArguments([[text], undefined]),
  }));
  capture.modelOutputs = [
    { ok: true, value: [[0.25]] },
    { ok: true, value: [[0.5]] },
  ];
  return { identity, request, complete: true, capture };
}
test.each([
  "valid",
  "pid",
  "generation",
  "token",
  "run",
  "request",
  "partial",
] as const)(
  "child receipt validation retains split native calls: %s",
  (change) => {
    const value = structuredClone(receipt());
    if (change === "pid") value.identity.pid += 1;
    if (change === "generation") value.identity.generation += 1;
    if (change === "token") value.identity.token = crypto.randomUUID();
    if (change === "run") value.capture.runId = "foreign";
    if (change === "request") value.request.requestId += 1;
    if (change === "partial") value.complete = false;
    if (!["valid", "partial"].includes(change)) {
      expect(() => validateChildReceipt(value, identity, request)).toThrow();
      return;
    }
    const target = emptyCapture("test");
    appendChildCapture(target, validateChildReceipt(value, identity, request));
    expect(target.modelInputs).toEqual(value.capture.modelInputs);
    expect(target.modelInputs).toHaveLength(2);
    expect(target.modelOutputs).toEqual(value.capture.modelOutputs);
    expect(target.errors.length).toBe(change === "partial" ? 1 : 0);
    expect(target.backends).toEqual([]); // No backend/model proof can be minted from request bytes.
  }
);

test("actual selected child captures input and hash failure without loading a backend; unrelated spawn unchanged", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "gno-child-capture-"))
  );
  const path = join(root, "not-a-model.gguf");
  await Bun.write(path, "deliberately not a native model");
  const modelUri = `file:${path}`;
  const capture = await installParentCapture(
    "actual-child",
    [
      {
        role: "generation",
        id: modelUri,
        sha256: "a".repeat(64),
        tokenizerSha256: "a".repeat(64),
      },
    ],
    root
  );
  const entry = join(process.cwd(), "src/llm/native-worker/entry.ts");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const unrelated = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        "process.stdout.write(String(process.env.GNO_ACCEPTANCE_CHILD_BOOTSTRAP))",
      ],
      { stdout: "pipe" }
    );
    expect(await new Response(unrelated.stdout).text()).toBe("undefined");
    expect(await unrelated.exited).toBe(0);
    expect(capture.events).toHaveLength(0);
    const decoder = new NativeFrameDecoder(1);
    const replies: unknown[] = [];
    let ready = false;
    child = Bun.spawn({
      cmd: [
        process.execPath,
        "--no-env-file",
        entry,
        JSON.stringify({
          generation: 1,
          models: [{ id: "gen", modelUri, path, type: "gen" }],
          loadTimeout: 1000,
          inferenceTimeout: 1000,
          warmModelTtl: 60000,
        }),
      ],
      env: nativeWorkerEnvironment(),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      serialization: "advanced",
      ipc(message) {
        if (message === "ready") ready = true;
        if (message instanceof Uint8Array) {
          const decoded = decoder.push(message);
          if (decoded !== undefined) replies.push(decoded);
        }
      },
    });
    const deadline = Date.now() + 10000;
    while (!ready && Date.now() < deadline && child.exitCode === null)
      await Bun.sleep(10);
    expect(ready).toBe(true);
    capture.begin();
    const init: NativeRequest = {
      version: 1,
      generation: 1,
      requestId: 1,
      op: "init",
      modelId: "gen",
    };
    for (const frame of frameNativeMessage(init)) child.send(frame);
    while (!replies.length && Date.now() < deadline) await Bun.sleep(10);
    expect(replies).toHaveLength(1);
    child.send({ ack: 1 });
    expect(capture.finish().modelInputs).toEqual([]);
    expect(capture.receipts[0]!.complete).toBe(true);
    capture.begin();
    const input: NativeRequest = {
      version: 1,
      generation: 1,
      requestId: 2,
      op: "generate",
      modelId: "gen",
      prompt: "full\r\ninput",
      params: { seed: 17, maxTokens: 32 },
    };
    for (const frame of frameNativeMessage(input)) child.send(frame);
    while (replies.length < 2 && Date.now() < deadline) await Bun.sleep(10);
    expect(replies).toHaveLength(2);
    child.kill("SIGTERM");
    await child.exited;
    const result = capture.finish();
    expect(result.errors.join(" ")).toContain("hash mismatch");
    expect(result.backends).toEqual([]);
    expect(result.models).toEqual([]);
    expect(result.modelInputs).toEqual([
      {
        role: "generation",
        modelId: modelUri,
        input: captureArguments([input.prompt, input.params]),
      },
    ]);
    expect(capture.receipts).toHaveLength(1);
    expect(capture.receipts[0]!.identity.pid).toBe(child.pid);
    expect(capture.receipts[0]!.request.requestId).toBe(2);
    expect(capture.receipts[0]!.complete).toBe(true);
    await Bun.sleep(10);
    expect(capture.events.map((event) => event.event)).toEqual([
      "birth",
      "exit",
    ]);
    expect(capture.modelState().loaded).toBe(false);
  } finally {
    capture.restore();
    if (child && child.exitCode === null) child.kill("SIGKILL");
    await child?.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("capture rejects symlink roots before installing a spawn hook", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gno-child-path-")));
  const link = `${root}-link`;
  try {
    await symlink(root, link);
    await expect(installParentCapture("test", [], link)).rejects.toThrow(
      "canonical"
    );
  } finally {
    await rm(link);
    await rm(root, { recursive: true, force: true });
  }
});

test("resource scope samples validated actual descendants and leaves unrelated processes alive", async () => {
  const { OwnedResources } =
    await import("../../../evals/acceptance/resources");
  const scope = new OwnedResources();
  const unrelated = Bun.spawn(
    [process.execPath, "--no-env-file", "-e", "setInterval(()=>{},1000)"],
    { stdout: "ignore", stderr: "ignore" }
  );
  let nativePid = 0;
  let probePid = 0;
  const nativeProgram = `
    const probe = Bun.spawn([process.execPath, "--no-env-file", "-e", "process.on('disconnect',()=>process.exit(0));setInterval(()=>{},1000)"], {stdout:"ignore",stderr:"ignore",ipc(){}});
    process.send({probePid:probe.pid});
    process.on("disconnect",async()=>{probe.kill("SIGTERM");await probe.exited;process.exit(0)});
    process.on("SIGTERM",async()=>{probe.kill("SIGTERM");await probe.exited;process.exit(0)});
    setInterval(()=>{},1000);
  `;
  const owner = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `
    const child = Bun.spawn([process.execPath, '--no-env-file', '-e', ${JSON.stringify(nativeProgram)}], {stdout:'ignore',stderr:'ignore',ipc(message){process.send(message)}});
    process.send({pid:child.pid});
    process.on('message', async () => { child.kill('SIGTERM'); await child.exited; process.send({exited:true}); });
    process.on('exit',()=>child.kill('SIGTERM'));
  `,
    ],
    {
      stdout: "ignore",
      stderr: "ignore",
      ipc(message) {
        if (message?.pid) nativePid = message.pid;
        if (message?.probePid) probePid = message.probePid;
      },
    }
  );
  scope.own(owner);
  try {
    const deadline = Date.now() + 3000;
    while ((!nativePid || !probePid) && Date.now() < deadline)
      await Bun.sleep(10);
    expect(nativePid).toBeGreaterThan(0);
    const nativeIdentity = {
      ...identity,
      token: crypto.randomUUID(),
      parentPid: owner.pid,
      pid: nativePid,
    };
    await expect(
      scope.observeDescendant(owner, {
        identity: { ...nativeIdentity, pid: unrelated.pid },
        event: "birth",
      })
    ).rejects.toThrow("ancestry");
    await scope.observeDescendant(owner, {
      identity: nativeIdentity,
      event: "birth",
    });
    await expect(
      scope.observeDescendant(owner, {
        identity: nativeIdentity,
        event: "birth",
      })
    ).rejects.toThrow("duplicate");
    await scope.sample();
    expect(scope.samples[0]!.errors).toEqual([]);
    expect(scope.samples[0]!.pids.toSorted((a, b) => a - b)).toEqual(
      [owner.pid, nativePid, probePid].toSorted((a, b) => a - b)
    );
    expect(
      scope.samples[0]!.processes?.find((item) => item.pid === nativePid)
        ?.nativeIdentity
    ).toEqual(nativeIdentity);
    expect(
      scope.samples[0]!.processes?.find((item) => item.pid === probePid)
        ?.osDescendant?.parentPid
    ).toBe(nativePid);
    await expect(
      scope.observeDescendant(owner, {
        identity: nativeIdentity,
        event: "exit",
      })
    ).rejects.toThrow("still live");
    await scope.close();
    expect(scope.errors).toEqual([]);
    expect(unrelated.exitCode).toBeNull();
  } finally {
    await scope.close();
    unrelated.kill("SIGKILL");
    await unrelated.exited;
  }
}, 10000);

test("candidate adapter import and parent capture do not load native leaf modules or bindings", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "gno-native-free-parent-"))
  );
  try {
    const adapter = join(process.cwd(), "evals/acceptance/native-adapter.ts");
    const bridge = join(process.cwd(), "evals/acceptance/parent-capture.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `
      await import(${JSON.stringify(adapter)});
      const {installParentCapture} = await import(${JSON.stringify(bridge)});
      const capture = await installParentCapture('native-free', [], ${JSON.stringify(root)});
      const initial = await Bun.file(${JSON.stringify(join(root, "parent-capture.json"))}).json();
      process.stdout.write(JSON.stringify(initial.parentNative));
      capture.restore();
    `,
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    const output = JSON.parse(await new Response(child.stdout).text());
    expect(await child.exited).toBe(0);
    const persisted = await Bun.file(join(root, "parent-capture.json")).json();
    expect(persisted.parentNative).toEqual(output);
    expect(output.nativeModules).toEqual([]);
    expect(output.bindingLoads).toEqual([]);
    if (process.platform === "linux") expect(output.mappedModels).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native context options preserve nested undefined fields from ranking context creation", () => {
  expect(
    captureContextArguments([
      {
        contextSize: undefined,
        threads: 6,
        createSignal: undefined,
        _ranking: true,
      },
    ])
  ).toEqual([
    {
      contextSize: { $undefined: true },
      threads: 6,
      createSignal: { $undefined: true },
      _ranking: true,
    },
  ]);
});

test("context signal telemetry preserves semantic inputs and rejects unknown objects", () => {
  const controller = new AbortController();
  const semantic = {
    contextSize: 2048,
    batchSize: 128,
    threads: 6,
    sequences: 2,
    _ranking: true,
    flashAttention: false,
  };
  const options = { ...semantic, createSignal: controller.signal };
  const before = captureContextArguments([options]);
  expect(before).toEqual([
    {
      ...semantic,
      createSignal: {
        $operational: "AbortSignal",
        aborted: false,
        reason: { $undefined: true },
      },
    },
  ]);
  controller.abort(new DOMException("caller left", "AbortError"));
  expect(captureContextArguments([options])).toEqual([
    {
      ...semantic,
      createSignal: {
        $operational: "AbortSignal",
        aborted: true,
        reason: { name: "AbortError", message: "caller left" },
      },
    },
  ]);
  expect(before).toEqual([
    {
      ...semantic,
      createSignal: {
        $operational: "AbortSignal",
        aborted: false,
        reason: { $undefined: true },
      },
    },
  ]);
  expect(captureContextModelArguments([options])).toEqual([semantic]);
  expect(
    captureContextModelArguments([{ ...semantic, signal: undefined }])
  ).toEqual([semantic]);
  expect(options.createSignal).toBe(controller.signal);
  expect(() => captureContextArguments([{ other: controller.signal }])).toThrow(
    "Unsupported native context argument object"
  );
  expect(() => captureContextArguments([{ createSignal: new Date() }])).toThrow(
    "Unsupported native context argument object"
  );
  expect(() => captureContextArguments([{ callback: () => {} }])).toThrow();
});

test("embedding context capture forwards original cancellation options and preserves model context", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "gno-context-control-"))
  );
  const path = join(root, "model.gguf");
  await Bun.write(path, "synthetic capture fixture");
  const sha256 = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(path).arrayBuffer())
    .digest("hex");
  const semantic = {
    contextSize: 2048,
    batchSize: 128,
    threads: 6,
    sequences: 2,
  };
  const controller = new AbortController();
  const options = { ...semantic, createSignal: controller.signal };
  let forwarded: unknown;
  const model = {
    createEmbeddingContext(value: unknown) {
      forwarded = value;
      return Promise.resolve({
        getEmbeddingFor: () => Promise.resolve({ vector: [0.125] }),
      });
    },
  };
  const original = ModelManager.prototype.loadModel;
  ModelManager.prototype.loadModel = (() =>
    Promise.resolve({
      ok: true,
      value: { uri: "fixture", model, type: "embed", loadedAt: Date.now() },
    })) as typeof original;
  const session = installNativeCapture("context-controls", [
    { role: "embedding", id: "fixture", sha256, tokenizerSha256: sha256 },
  ]);
  try {
    const manager = Object.create(ModelManager.prototype) as ModelManager;
    await manager.loadModel(path, "fixture", "embed");
    const context = await model.createEmbeddingContext(options);
    await context.getEmbeddingFor();
    expect(forwarded).toBe(options);
    expect((forwarded as typeof options).createSignal).toBe(controller.signal);
    expect(session.capture.modelInputs[0]?.input).toEqual({
      nativeMethod: "getEmbeddingFor",
      context: [semantic],
      arguments: [],
    });
    expect(session.capture.contextEvents?.[0]?.arguments).toEqual([
      {
        ...semantic,
        createSignal: {
          $operational: "AbortSignal",
          aborted: false,
          reason: { $undefined: true },
        },
      },
    ]);
  } finally {
    session.restore();
    ModelManager.prototype.loadModel = original;
    await rm(root, { recursive: true, force: true });
  }
});

test("actual worker removes only its QA preload before dependency fork; nonentry inherited preload is harmless", async () => {
  const { chmod } = await import("node:fs/promises");
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "gno-capture-fork-"))
  );
  const preload = join(
    process.cwd(),
    "evals/acceptance/native-child-preload.ts"
  );
  const entry = join(process.cwd(), "src/llm/native-worker/entry.ts");
  const bootstrap = join(root, "bootstrap.json");
  const probe = join(root, "binding-probe.cjs");
  const observer = join(root, "fork-observer.ts");
  const output = join(root, "fork.json");
  // Exercise the dependency's actual child_process.fork execArgv inheritance;
  // Bun.spawn does not reproduce that Node compatibility behavior.
  await Bun.write(
    probe,
    "process.send({args:process.execArgv,ran:true});process.disconnect();"
  );
  await Bun.write(
    observer,
    `
    import {fork} from 'node:child_process';
    if(process.argv[1] === ${JSON.stringify(entry)}) {
      const child=fork(${JSON.stringify(probe)},[],{stdio:['ignore','ignore','ignore','ipc']});
      await new Promise((resolve,reject)=>{
        child.once('message',async value=>{await Bun.write(${JSON.stringify(output)},JSON.stringify(value));});
        child.once('error',reject);child.once('exit',code=>code===0?resolve(undefined):reject(Error('probe exit '+code)));
      });
    }
  `
  );
  await Bun.write(
    bootstrap,
    JSON.stringify({
      identity: { ...identity, parentPid: process.pid, entry },
      models: [],
    })
  );
  await chmod(bootstrap, 0o600);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    let ready = false;
    child = Bun.spawn({
      cmd: [
        process.execPath,
        "--no-env-file",
        "--preload",
        preload,
        "--preload",
        observer,
        entry,
        JSON.stringify({
          generation: 1,
          models: [],
          loadTimeout: 1000,
          inferenceTimeout: 1000,
          warmModelTtl: 60000,
        }),
      ],
      env: {
        ...nativeWorkerEnvironment(),
        GNO_ACCEPTANCE_CHILD_BOOTSTRAP: bootstrap,
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      serialization: "advanced",
      ipc(message) {
        if (message === "ready") ready = true;
      },
    });
    const deadline = Date.now() + 5000;
    while (!ready && child.exitCode === null && Date.now() < deadline)
      await Bun.sleep(10);
    expect(ready).toBe(true);
    const observed = await Bun.file(output).json();
    expect(observed.ran).toBe(true);
    expect(observed.args).not.toContain(preload);
    expect(observed.args).toContain(observer);
    child.send("shutdown");
    await child.exited;
    const inherited = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--preload",
        preload,
        "-e",
        "process.stdout.write('probe-ran')",
      ],
      {
        env: { GNO_ACCEPTANCE_CHILD_BOOTSTRAP: bootstrap },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    expect(await new Response(inherited.stdout).text()).toBe("probe-ran");
    expect(await inherited.exited).toBe(0);
    await Bun.write(
      bootstrap,
      JSON.stringify({
        identity: { ...identity, parentPid: 1, entry },
        models: [],
      })
    );
    const mismatch = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--preload",
        preload,
        entry,
        JSON.stringify({
          generation: 1,
          models: [],
          loadTimeout: 1000,
          inferenceTimeout: 1000,
        }),
      ],
      {
        env: { GNO_ACCEPTANCE_CHILD_BOOTSTRAP: bootstrap },
        stdout: "ignore",
        stderr: "pipe",
      }
    );
    expect(await new Response(mismatch.stderr).text()).toContain(
      "execution identity mismatch"
    );
    expect(await mismatch.exited).not.toBe(0);
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    await child?.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
