/** Synthetic fault contract; target imports always resolve inside the tested package. */
// node:assert/path/fs: Bun has no strict assertion, path join or mkdir API.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const packageRoot = process.argv[2]!;
const scratch = join(process.argv[3]!, "native-lifecycle");
await mkdir(scratch, { recursive: true });
const moduleRoot = join(packageRoot, "src/llm/native-worker");
const { NativeWorkerClient } = (await import(
  join(moduleRoot, "client.ts")
)) as typeof import("../../../../src/llm/native-worker/client");
const { NATIVE_LOGICAL_BYTES } = (await import(
  join(moduleRoot, "protocol.ts")
)) as typeof import("../../../../src/llm/native-worker/protocol");
const path = join(scratch, "metadata-only.gguf");
await Bun.write(
  path,
  "Synthetic metadata fixture: must never load native weights."
);
const models = [
  { id: "gen", type: "gen" as const, modelUri: `file:${path}`, path },
  { id: "embed", type: "embed" as const, modelUri: `file:${path}`, path },
];
const options = {
  models,
  loadTimeout: 2000,
  inferenceTimeout: 2000,
  warmModelTtl: 50,
};
const init = { op: "init" as const, modelId: "gen" };

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!check() && Date.now() < deadline) await Bun.sleep(10);
  assert.ok(check(), "bounded lifecycle condition did not settle");
}

// Separate parent lets process-exit cleanup and stdout isolation be observed externally.
if (process.argv[4] === "parent") {
  const owner = new NativeWorkerClient(options);
  assert.equal((await owner.request(init)).ok, true);
  await Bun.write(
    join(scratch, "parent-child.json"),
    JSON.stringify({ pid: owner.processId })
  );
  process.exit(0);
}

const identities: Record<string, string> = {};
for (const file of [
  "client.ts",
  "entry.ts",
  "dispatcher.ts",
  "protocol.ts",
  "ports.ts",
]) {
  identities[file] = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(join(moduleRoot, file)).bytes())
    .digest("hex");
}
const production = new NativeWorkerClient(options);
const productionGenerations: number[] = [];
try {
  for (let cycle = 0; cycle < 3; cycle++) {
    assert.deepEqual(await production.request(init), {
      ok: true,
      value: { structuredOutput: "json_schema" },
    });
    productionGenerations.push(production.currentGeneration);
    await eventually(() => production.processId === undefined);
  }
  assert.deepEqual(productionGenerations, [1, 2, 3]);
} finally {
  await production.dispose();
}

const bad = new NativeWorkerClient({
  ...options,
  entryPath: join(scratch, "missing-entry.ts"),
});
try {
  assert.deepEqual(await bad.request(init), {
    ok: false,
    error: {
      code: "INFERENCE_FAILED",
      message: "Native worker failure: exited",
      retryable: true,
    },
  });
} finally {
  await bad.dispose();
}

const transcriptPath = join(scratch, "transcript.jsonl");
await Bun.write(transcriptPath, "");
const faultPath = join(scratch, "fault-worker.ts");
await Bun.write(
  faultPath,
  `
import { NativeFrameDecoder, frameNativeMessage } from ${JSON.stringify(join(moduleRoot, "protocol.ts"))};
const config = JSON.parse(process.argv[2]);
const decoder = new NativeFrameDecoder(config.generation);
const transcript = Bun.file(${JSON.stringify(transcriptPath)} + "." + config.generation).writer();
process.on("disconnect", () => process.exit(0));
process.on("message", async message => {
 if (message === "shutdown") process.exit(0);
 if (message?.ack) return;
 const request = decoder.push(message);
 if (!request) return;
 transcript.write(JSON.stringify(request) + "\\n"); await transcript.flush();
 console.log("Native diagnostics must not corrupt caller JSON");
 if (request.prompt === "crash") process.kill(process.pid, "SIGKILL");
 const value = JSON.stringify({ prompt: request.prompt, params: request.params });
 for (const frame of frameNativeMessage({version:1,generation:request.generation,requestId:request.requestId,op:request.op,result:{ok:true,value}})) process.send(frame);
});
process.send("ready");
`
);
const owner = new NativeWorkerClient({ ...options, entryPath: faultPath });
const params = {
  seed: 7,
  temperature: 0,
  maxTokens: 24,
  jsonSchema: { type: "object", properties: { answer: { type: "string" } } },
};
try {
  const failed = await Promise.all([
    owner.request({ op: "generate", modelId: "gen", prompt: "crash", params }),
    owner.request({
      op: "generate",
      modelId: "gen",
      prompt: "queued-never-replay",
      params,
    }),
  ]);
  assert.deepEqual(
    failed,
    [0, 1].map(() => ({
      ok: false,
      error: {
        code: "INFERENCE_FAILED",
        message: "Native worker failure: exited",
        retryable: true,
      },
    }))
  );
  const prompt = "structured β " + "x".repeat(9 * 1024 * 1024);
  const generated = await owner.request({
    op: "generate",
    modelId: "gen",
    prompt,
    params,
  });
  assert.ok(generated.ok && typeof generated.value === "string");
  const decoded = JSON.parse(generated.value);
  assert.ok(decoded.prompt === prompt, "complete multi-frame prompt equality");
  assert.deepEqual(decoded.params, params);
  assert.equal(owner.currentGeneration, 2);
  // Reject the logical ceiling before sending any fragment to the child.
  const tooLarge = await owner.request({
    op: "embedBatch",
    modelId: "embed",
    texts: [
      "x".repeat(NATIVE_LOGICAL_BYTES / 2),
      "y".repeat(NATIVE_LOGICAL_BYTES / 2),
    ],
  });
  assert.equal(tooLarge.ok, false);
  assert.ok(!tooLarge.ok);
  assert.equal(tooLarge.error.message, "Native worker failure: oversized");
  assert.equal(
    (
      await owner.request({
        op: "generate",
        modelId: "gen",
        prompt: "independent",
        params,
      })
    ).ok,
    true
  );
} finally {
  await owner.dispose();
}
const transcript = (
  await Promise.all(
    [1, 2].map((generation) =>
      Bun.file(transcriptPath + "." + generation).text()
    )
  )
)
  .join("")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.deepEqual(
  transcript.map(
    ({ generation, requestId }: { generation: number; requestId: number }) => [
      generation,
      requestId,
    ]
  ),
  [
    [1, 1],
    [2, 3],
    [2, 5],
  ]
);
assert.ok(
  !transcript.some(
    ({ prompt }: { prompt: string }) => prompt === "queued-never-replay"
  )
);

// A child that ignores graceful shutdown must still be reaped in finite time.
const stubbornPath = join(scratch, "stubborn.ts");
await Bun.write(
  stubbornPath,
  'process.on("message", () => {}); process.send("ready");'
);
const stubborn = new NativeWorkerClient({
  ...options,
  entryPath: stubbornPath,
});
const waiting = stubborn.request(init);
await eventually(() => stubborn.processId !== undefined);
const disposalStarted = Date.now();
await stubborn.dispose();
assert.equal((await waiting).ok, false);
assert.equal(stubborn.processId, undefined);
assert.ok(
  Date.now() - disposalStarted < 2500,
  "forced shutdown exceeded deadline"
);

const parent = Bun.spawn(
  [
    process.execPath,
    "--no-env-file",
    import.meta.path,
    packageRoot,
    process.argv[3]!,
    "parent",
  ],
  { stdout: "pipe", stderr: "pipe" }
);
const parentDeadline = setTimeout(() => parent.kill("SIGKILL"), 5000);
try {
  assert.equal(
    await parent.exited,
    0,
    await new Response(parent.stderr).text()
  );
  assert.equal(await new Response(parent.stdout).text(), "");
  const { pid } = await Bun.file(join(scratch, "parent-child.json")).json();
  await eventually(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
} finally {
  clearTimeout(parentDeadline);
  parent.kill("SIGKILL");
  await parent.exited;
}
console.log(
  JSON.stringify({
    contract: "native-lifecycle-v1",
    passed: true,
    nativeWeights: false,
    packageRoot,
    identities,
    productionGenerations,
    requestIdentities: transcript.map(
      ({
        generation,
        requestId,
      }: {
        generation: number;
        requestId: number;
      }) => ({ generation, requestId })
    ),
  })
);
