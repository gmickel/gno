import { afterEach, expect, spyOn, test } from "bun:test";
// Bun has no temporary-directory/path construction API.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResidentRuntime } from "../../src/serve/resident-runtime";

import { HttpGeneration } from "../../src/llm/httpGeneration";
import {
  assertInferenceActive,
  inferenceOptions,
  withInferenceScope,
} from "../../src/llm/inference-scope";
import { NativeWorkerClient } from "../../src/llm/native-worker/client";
import { NativeGenerationPort } from "../../src/llm/native-worker/ports";
import { expandQuery } from "../../src/pipeline/expansion";
import {
  AdmissionController,
  ReaderGate,
} from "../../src/serve/resident-admission";
import { handleResidentRead } from "../../src/serve/resident-request";

const root = await mkdtemp(join(tmpdir(), "gno-cancellation-"));
const fixture = join(root, "child.ts");
const protocol = new URL(
  "../../src/llm/native-worker/protocol.ts",
  import.meta.url
).href;
await Bun.write(
  fixture,
  `
import { NativeFrameDecoder, frameNativeMessage } from ${JSON.stringify(protocol)};
const config = JSON.parse(process.argv[2]);
const decoder = new NativeFrameDecoder(config.generation);
let request;
process.on('disconnect', () => process.exit(0));
process.on('message', async message => {
  if (message === 'shutdown') process.exit(0);
  if (message?.ack || message?.register) return;
  if (message?.cancel) return; // Deliberately noncooperative evaluation.
  request = decoder.push(message); if (!request) return;
  const current = request;
  if (current.prompt === 'slow-load') await Bun.sleep(100);
  if (current.op !== "dispose") process.send({version:1,generation:current.generation,requestId:current.requestId,executionStarted:true});
  if (current.prompt === 'duplicate-start') process.send({version:1,generation:current.generation,requestId:current.requestId,executionStarted:true});
  if (current.prompt === 'stale-start') process.send({version:1,generation:current.generation+1,requestId:current.requestId,executionStarted:true});
  if (current.prompt === "stuck") return;
  await Bun.sleep(current.prompt === 'slow' ? 250 : 5);
  for (const frame of frameNativeMessage({version:1,generation:current.generation,requestId:current.requestId,op:current.op,result:{ok:true,value:current.op === "dispose" ? null : current.prompt}})) process.send(frame);
});
process.send('ready');
`
);
const clients: NativeWorkerClient[] = [];
function client(inferenceTimeout = 1000) {
  const worker = new NativeWorkerClient({
    models: [
      {
        id: "gen",
        type: "gen",
        modelUri: "file:/synthetic.gguf",
        path: "/synthetic.gguf",
      },
    ],
    loadTimeout: 1000,
    inferenceTimeout,
    entryPath: fixture,
  });
  clients.push(worker);
  return worker;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((worker) => worker.dispose()));
});

test("pre-aborted caller never starts a child and queued cancellation removes only its request", async () => {
  const worker = client();
  const port = new NativeGenerationPort(worker, "gen", "file:/synthetic.gguf");
  expect(
    (await port.generate("unused", undefined, { signal: AbortSignal.abort() }))
      .ok
  ).toBe(false);
  expect(worker.processId).toBeUndefined();
  const first = port.generate("slow");
  const cancel = new AbortController();
  const queued = port.generate("cancelled", undefined, {
    signal: cancel.signal,
  });
  const last = port.generate("last");
  await Bun.sleep(30);
  cancel.abort();
  expect((await queued).ok).toBe(false);
  expect(await first).toEqual({ ok: true, value: "slow" });
  expect(await last).toEqual({ ok: true, value: "last" });
  expect(worker.currentGeneration).toBe(1);
});

test("active abort delivers promptly but queued work waits for actual native settlement", async () => {
  const worker = client();
  const port = new NativeGenerationPort(worker, "gen", "file:/synthetic.gguf");
  await port.generate("warm");
  const cancel = new AbortController();
  const first = port.generate("slow", undefined, { signal: cancel.signal });
  await Bun.sleep(25);
  let nextSettled = false;
  const next = port.generate("next").then((result) => {
    nextSettled = true;
    return result;
  });
  const started = performance.now();
  cancel.abort();
  const cancelled = await first;
  expect(cancelled.ok).toBe(false);
  expect(performance.now() - started).toBeLessThan(100);
  await Bun.sleep(50);
  expect(nextSettled).toBe(false);
  expect(await next).toEqual({ ok: true, value: "next" });
  expect(worker.currentGeneration).toBe(1);
});

test("execution timeout starts after load while caller deadline includes load", async () => {
  const worker = client(50);
  const port = new NativeGenerationPort(worker, "gen", "file:/synthetic.gguf");
  expect(await port.generate("slow-load")).toEqual({
    ok: true,
    value: "slow-load",
  });
  const result = await port.generate("slow-load", undefined, {
    deadlineAt: Date.now() + 25,
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("TIMEOUT");
});

test.each(["duplicate-start", "stale-start"])(
  "%s control cannot acknowledge settlement",
  async (prompt) => {
    const worker = client();
    const result = await worker.request({
      op: "generate",
      modelId: "gen",
      prompt,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("protocol");
  }
);

test("overlapping scopes isolate abort and tighten nested deadlines, then clean up", async () => {
  const cancelled = new AbortController();
  const healthy = new AbortController();
  const deadlineAt = Date.now() + 10000;
  const first = withInferenceScope(
    { signal: cancelled.signal, deadlineAt },
    async () => {
      await Bun.sleep(20);
      return withInferenceScope(
        { signal: healthy.signal, deadlineAt: deadlineAt + 10000 },
        async () => {
          expect(inferenceOptions().deadlineAt).toBe(deadlineAt);
          assertInferenceActive();
        }
      );
    }
  );
  const second = withInferenceScope({ signal: healthy.signal }, async () => {
    await Bun.sleep(30);
    assertInferenceActive();
    return "healthy";
  });
  cancelled.abort();
  expect(await first.catch((error: unknown) => error)).toMatchObject({
    name: "AbortError",
  });
  expect(await second).toBe("healthy");
  expect(inferenceOptions().signal).toBeUndefined();
});

test("HTTP generation abort reaches fetch inside nested scope without changing model inputs", async () => {
  const started = Promise.withResolvers<void>();
  let fetchAborted = false;
  const port = new HttpGeneration(
    "http://localhost:1234/v1/chat/completions#synthetic",
    {
      collections: [
        {
          name: "test",
          path: root,
          pattern: "**/*",
          include: [],
          exclude: [],
          egressPolicy: "local_only",
        },
      ],
      collectionNames: ["test"],
      env: {},
      resolver: { lookup: async () => ["127.0.0.1"] },
      fetchFn: async (_url, init) => {
        if (typeof init?.body !== "string")
          throw new Error("Expected JSON request body");
        const body = JSON.parse(init.body);
        expect(body.messages).toEqual([
          { role: "user", content: "exact prompt" },
        ]);
        expect(body.seed).toBe(42);
        started.resolve();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              fetchAborted = true;
              reject(init.signal?.reason);
            },
            { once: true }
          );
        });
      },
    }
  );
  const controller = new AbortController();
  const pending = withInferenceScope({ signal: controller.signal }, () =>
    withInferenceScope({}, () => port.generate("exact prompt", { seed: 42 }))
  );
  await started.promise;
  controller.abort();
  expect(await pending.catch((error: unknown) => error)).toMatchObject({
    name: "AbortError",
  });
  expect(fetchAborted).toBe(true);
});

test("independent expansion timeout cancels native work but preserves its fallback", async () => {
  const port = new NativeGenerationPort(
    client(),
    "gen",
    "file:/synthetic.gguf"
  );
  // The fake always returns invalid expansion text; caller expiry still wins.
  expect(await expandQuery(port, "query", { timeout: 1 })).toEqual({
    ok: true,
    value: null,
  });
  expect(
    await withInferenceScope({ signal: AbortSignal.abort() }, () =>
      expandQuery(port, "query")
    ).catch((error: unknown) => error)
  ).toMatchObject({ name: "AbortError" });
});

test("unexpected admission failure delivers an error without starting native work", async () => {
  const worker = client();
  const stub = spyOn(
    worker as unknown as { admit: () => Promise<never> },
    "admit"
  ).mockRejectedValueOnce(new Error("synthetic admission failure"));
  try {
    const result = await worker.request({
      op: "generate",
      modelId: "gen",
      prompt: "unused",
    });
    expect(result.ok).toBe(false);
    expect(worker.processId).toBeUndefined();
  } finally {
    stub.mockRestore();
  }
});

test("REST admitted abort reaches inference and owned cleanup cannot delay cancellation", async () => {
  const worker = client();
  const port = new NativeGenerationPort(worker, "gen", "file:/synthetic.gguf");
  await port.generate("warm");
  const admission = new AdmissionController();
  const runtime = {
    readerGate: new ReaderGate(2, 2),
    admitRequest: (signal?: AbortSignal) => admission.admit(signal),
  } as unknown as ResidentRuntime;
  const controller = new AbortController();
  const request = new Request("http://localhost/api/query", {
    signal: controller.signal,
  });
  const pending = handleResidentRead(runtime, request, async () => {
    try {
      const result = await port.generate("slow");
      return Response.json(result);
    } finally {
      await port.dispose();
    }
  });
  await Bun.sleep(25);
  const started = performance.now();
  controller.abort();
  expect((await pending).status).toBe(503);
  expect(performance.now() - started).toBeLessThan(100);
  expect(admission.active).toBe(0);
  // The synthetic noncooperative inference still owns the child's single slot.
  let finished = false;
  const next = port.generate("next").then((result) => {
    finished = true;
    return result;
  });
  await Bun.sleep(40);
  expect(finished).toBe(false);
  expect(await next).toEqual({ ok: true, value: "next" });
});

test("stuck cancelled child is retired after grace; queued deadlines do not replay work", async () => {
  const worker = client();
  const port = new NativeGenerationPort(worker, "gen", "file:/synthetic.gguf");
  await port.generate("warm");
  const cancel = new AbortController();
  const stuck = port.generate("stuck", undefined, { signal: cancel.signal });
  await Bun.sleep(20);
  const queued = port.generate("queued", undefined, {
    deadlineAt: Date.now() + 30,
  });
  cancel.abort();
  expect((await stuck).ok).toBe(false);
  expect((await queued).ok).toBe(false);
  expect(worker.processId).toBeDefined();
  const deadline = Date.now() + 6500;
  while (worker.processId !== undefined && Date.now() < deadline)
    await Bun.sleep(50);
  expect(worker.processId).toBeUndefined();
  expect(await port.generate("recovery")).toEqual({
    ok: true,
    value: "recovery",
  });
  expect(worker.currentGeneration).toBe(2);
}, 10000);

test.each([Number.NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
  "invalid caller deadline %s fails before even lexical-only work",
  async (deadlineAt) => {
    let ran = false;
    const result = await withInferenceScope({ deadlineAt }, async () => {
      ran = true;
      return "lexical";
    }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(RangeError);
    expect(ran).toBe(false);
  }
);

test("quarantine waiters share the original queue budget and remove only their own deadline", async () => {
  const worker = client();
  const port = new NativeGenerationPort(worker, "gen", "file:/synthetic.gguf");
  await port.generate("warm");
  const controller = new AbortController();
  const first = port.generate("slow", undefined, { signal: controller.signal });
  await Bun.sleep(20);
  controller.abort();
  expect((await first).ok).toBe(false);
  const inside = worker as unknown as {
    owner: { pending: unknown[]; waiters: Set<unknown> };
  };
  const expiring = port.generate("expired", undefined, {
    deadlineAt: Date.now() + 100,
  });
  const healthy = port.generate("healthy");
  const remaining = Array.from({ length: 62 }, () => port.generate("other"));
  await Bun.sleep(0);
  expect(inside.owner.pending).toHaveLength(1);
  expect(inside.owner.waiters.size).toBe(64);
  const overloaded = await port.generate("overloaded");
  expect(overloaded).toMatchObject({
    ok: false,
    error: { retryable: true, message: "Native worker failure: overloaded" },
  });
  expect((await expiring).ok).toBe(false);
  expect(inside.owner.waiters.size).toBe(63);
  expect(await healthy).toEqual({ ok: true, value: "healthy" });
  expect((await Promise.all(remaining)).every((result) => result.ok)).toBe(
    true
  );
  expect(inside.owner.waiters.size).toBe(0);
});
