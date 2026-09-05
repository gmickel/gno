import { expect, test } from "bun:test";
// Bun has no temporary-directory/symlink/removal APIs.
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os"; // Bun has no OS temp-directory API.
import { join } from "node:path"; // Bun has no path helpers.

import {
  emptyCapture,
  captureArguments,
  captureContextArguments,
} from "../../../evals/acceptance/capture-contract";
import {
  appendChildCapture,
  validateChildReceipt,
  type ChildIdentity,
  type ChildReceipt,
} from "../../../evals/acceptance/child-receipt";
import { installParentCapture } from "../../../evals/acceptance/parent-capture";
import {
  frameNativeMessage,
  NativeFrameDecoder,
  type NativeRequest,
} from "../../../src/llm/native-worker/protocol";
import { nativeWorkerEnvironment } from "../../../src/llm/native-worker/runtime-config";

const identity: ChildIdentity = {
  runId: "test",
  token: "12345678-1234-4234-8234-123456789abc",
  parentPid: 10,
  pid: 11,
  generation: 1,
  entry: "/selected/entry.ts",
};
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
  const root = await mkdtemp(join(tmpdir(), "gno-child-capture-"));
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
    expect(capture.receipts[0]!.complete).toBe(false);
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
  const root = await mkdtemp(join(tmpdir(), "gno-child-path-"));
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
  const owner = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `
    const child = Bun.spawn([process.execPath, '--no-env-file', '-e', "process.on('disconnect',()=>process.exit(0));setInterval(()=>{},1000)"], {stdout:'ignore',stderr:'ignore',ipc(){}});
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
      },
    }
  );
  scope.own(owner);
  try {
    const deadline = Date.now() + 3000;
    while (!nativePid && Date.now() < deadline) await Bun.sleep(10);
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
      [owner.pid, nativePid].toSorted((a, b) => a - b)
    );
    expect(
      scope.samples[0]!.processes?.find((item) => item.pid === nativePid)
        ?.nativeIdentity
    ).toEqual(nativeIdentity);
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
  const root = await mkdtemp(join(tmpdir(), "gno-native-free-parent-"));
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
      process.stdout.write(JSON.stringify(capture.finish().parentNative));
      capture.restore();
    `,
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    const output = JSON.parse(await new Response(child.stdout).text());
    expect(await child.exited).toBe(0);
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
