import { expect, test } from "bun:test";

import type {
  NativeRequest,
  NativeResponse,
} from "../../src/llm/native-worker/protocol";

import { NativeWorkerError } from "../../src/llm/native-worker/errors";
import {
  ApprovedModelSchema,
  encodeNativeMessage,
  frameNativeMessage,
  NATIVE_FRAME_BYTES,
  NATIVE_LOGICAL_BYTES,
  NATIVE_QUEUE_LIMIT,
  NativeFrameDecoder,
  NativeRequestLedger,
  parseNativeRequest,
  parseNativeResponse,
  splitEmbeddingRequest,
} from "../../src/llm/native-worker/protocol";

const approved = [
  {
    id: "embed",
    modelUri: "file:/models/embed.gguf",
    path: "/models/embed.gguf",
    type: "embed" as const,
  },
  {
    id: "gen",
    modelUri: "file:/models/gen.gguf",
    path: "/models/gen.gguf",
    type: "gen" as const,
  },
  {
    id: "rerank",
    modelUri: "file:/models/rerank.gguf",
    path: "/models/rerank.gguf",
    type: "rerank" as const,
  },
];
const base = {
  version: 1 as const,
  generation: 7,
  requestId: 1,
  modelId: "embed",
};
const embed: NativeRequest = {
  ...base,
  op: "embed",
  text: "Unicode 🐕 č 漢字",
};
function response(request: NativeRequest, value: unknown): unknown {
  return {
    version: 1,
    generation: request.generation,
    requestId: request.requestId,
    op: request.op,
    result: { ok: true, value },
  };
}

test("actual port inputs and complete outputs survive framing, including schema and errors", () => {
  const cases: [NativeRequest, unknown][] = [
    [embed, [0.1234567890123456, -1, 0, 1e-100]],
    [
      { ...base, op: "embedBatch", texts: ["a", "b"] },
      [
        [1, 2],
        [3, 4],
      ],
    ],
    [
      {
        ...base,
        modelId: "rerank",
        op: "rerank",
        query: "q",
        documents: ["a", "b"],
      },
      [
        { index: 1, rank: 1, score: 0.99 },
        { index: 0, rank: 2, score: -0.2 },
      ],
    ],
    [
      {
        ...base,
        modelId: "gen",
        op: "generate",
        prompt: "Exact prompt\n",
        params: {
          temperature: 0,
          seed: 42,
          maxTokens: 400,
          contextSize: 8192,
          stop: ["END"],
          jsonSchema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
            additionalProperties: false,
          },
        },
      },
      '{"answer":"č"}',
    ],
    [
      { ...base, op: "init" },
      { dimensions: 768, structuredOutput: "none" },
    ],
    [{ ...base, op: "dispose" }, null],
  ];
  for (const [request, value] of cases) {
    const decoder = new NativeFrameDecoder(7);
    expect(
      parseNativeRequest(
        decoder.push(frameNativeMessage(request)[0]!),
        7,
        approved
      )
    ).toEqual(request);
    const result = response(request, value) as NativeResponse;
    expect(
      parseNativeResponse(decoder.push(frameNativeMessage(result)[0]!), request)
    ).toEqual(result);
  }
  const failure = {
    ...(response(embed, null) as NativeResponse),
    result: {
      ok: false as const,
      error: {
        code: "MODEL_LOAD_FAILED" as const,
        message: "load failed",
        retryable: false,
        modelUri: "file:/models/embed.gguf",
        cause: { name: "Error", message: "reason" },
        suggestion: "gno doctor",
      },
    },
  };
  expect(parseNativeResponse(failure, embed)).toEqual(failure);
});

test("closed request contract rejects unknown identity, authority and operation fields", () => {
  for (const input of [
    { ...embed, version: 2 },
    { ...embed, generation: 8 },
    { ...embed, op: "download" },
    { ...embed, requestId: 0 },
    { ...embed, modelId: "unapproved" },
    { ...embed, path: "/unapproved.gguf" },
    { ...embed, credentials: "secret" },
    { ...embed, modelId: "gen" },
    { ...embed, text: 123 },
    {
      ...base,
      modelId: "gen",
      op: "generate",
      prompt: "p",
      params: { unknown: true },
    },
  ])
    expect(() => parseNativeRequest(input, 7, approved)).toThrow(
      NativeWorkerError
    );
  for (const path of [
    "relative.gguf",
    "https://host/model.gguf",
    "/model\0.gguf",
  ]) {
    expect(
      ApprovedModelSchema.safeParse({ ...approved[0], path }).success
    ).toBe(false);
  }
  expect(
    ApprovedModelSchema.safeParse({
      ...approved[0],
      path: "C:\\models\\file.gguf",
    }).success
  ).toBe(true);
});

test("malformed responses fail instead of becoming successful empty retrieval", () => {
  const batch: NativeRequest = { ...base, op: "embedBatch", texts: ["a", "b"] };
  const rank: NativeRequest = {
    ...base,
    modelId: "rerank",
    op: "rerank",
    query: "q",
    documents: ["a", "b"],
  };
  for (const [request, value] of [
    [embed, []],
    [embed, [Number.NaN]],
    [embed, "wrong"],
    [batch, [[1]]],
    [batch, [[1], [1, 2]]],
    [
      rank,
      [
        { index: 0, rank: 1, score: 1 },
        { index: 0, rank: 2, score: 0 },
      ],
    ],
  ] as const) {
    expect(() =>
      parseNativeResponse(response(request, value), request)
    ).toThrow(NativeWorkerError);
  }
  for (const patch of [
    { version: 2 },
    { generation: 9 },
    { requestId: 2 },
    { op: "generate" },
    { stderr: "diagnostic" },
    {
      result: {
        ok: false,
        error: { code: "UNKNOWN", retryable: false, message: "bad" },
      },
    },
  ]) {
    expect(() =>
      parseNativeResponse(
        { ...(response(embed, [1]) as object), ...patch },
        embed
      )
    ).toThrow(NativeWorkerError);
  }
});

test("one active plus 64 queued; settlement and termination happen once per generation", () => {
  const ledger = new NativeRequestLedger(7);
  for (let requestId = 1; requestId <= NATIVE_QUEUE_LIMIT + 1; requestId++)
    ledger.admit({ ...embed, requestId });
  expect(() => ledger.admit({ ...embed, requestId: 66 })).toThrow("overloaded");
  expect(() =>
    ledger.settle(response({ ...embed, generation: 8 }, [1]))
  ).toThrow("stale_generation");
  expect(() => ledger.settle(response(embed, []))).toThrow("protocol");
  expect(ledger.size).toBe(65);
  ledger.settle(response(embed, [1]));
  expect(() => ledger.settle(response(embed, [1]))).toThrow(
    "duplicate_completion"
  );
  expect(() => ledger.admit(embed)).toThrow("duplicate_completion");
  ledger.admit({ ...embed, requestId: 66 });
  const failed = ledger.failAll(new NativeWorkerError("exited"));
  expect(failed).toHaveLength(65);
  expect(
    failed.every(
      (result) =>
        !result.result.ok && result.result.error.code === "INFERENCE_FAILED"
    )
  ).toBe(true);
  for (const reason of ["exited", "timeout"] as const) {
    ledger.admit({ ...embed, requestId: reason === "exited" ? 67 : 68 });
    const results = ledger.failAll(new NativeWorkerError(reason));
    expect(results).toHaveLength(1);
    expect(results.every((result) => !result.result.ok)).toBe(true);
    expect(ledger.size).toBe(0);
  }
  expect(() =>
    ledger.settle(response({ ...embed, requestId: 66 }, [1]))
  ).toThrow("duplicate_completion");
});

test("UTF-8 frames and embedding splits preserve every byte and ordered input", () => {
  const text = "🐕漢č".repeat(Math.ceil(NATIVE_FRAME_BYTES / 9));
  const request = {
    ...base,
    op: "embedBatch" as const,
    texts: ["first", text, "last"],
  };
  const parts = splitEmbeddingRequest(request);
  expect(parts.flat()).toEqual(request.texts);
  expect(parts.length).toBeGreaterThan(1);
  const frames = frameNativeMessage(request);
  expect(frames.length).toBeGreaterThan(1);
  const decoder = new NativeFrameDecoder(7);
  let decoded: unknown;
  for (const frame of frames) {
    expect(frame.length).toBeLessThanOrEqual(NATIVE_FRAME_BYTES);
    decoded = decoder.push(frame);
  }
  expect(parseNativeRequest(decoded, 7, approved)).toEqual(request);
});

test("rejects oversized logical data and malformed frames, releasing partial assembly", () => {
  expect(() =>
    encodeNativeMessage("č".repeat(NATIVE_LOGICAL_BYTES / 2))
  ).toThrow("oversized");
  const good = frameNativeMessage(embed)[0]!;
  for (const [offset, value] of [
    [0, 2],
    [8, 8],
    [16, 0],
  ] as const) {
    const bad = good.slice();
    new DataView(bad.buffer).setFloat64(offset, value);
    expect(() => new NativeFrameDecoder(7).push(bad)).toThrow(
      NativeWorkerError
    );
  }
  const decoder = new NativeFrameDecoder(7);
  const bad = good.slice();
  new DataView(bad.buffer).setUint32(24, NATIVE_LOGICAL_BYTES + 1);
  expect(() => decoder.push(bad)).toThrow("oversized");
  expect(decoder.push(good)).toEqual(embed);
  const outOfOrder = good.slice();
  new DataView(outOfOrder.buffer).setUint32(28, 1);
  expect(() => decoder.push(outOfOrder)).toThrow("protocol");
  const invalidUtf8 = good.slice();
  invalidUtf8[32] = 255;
  expect(() => decoder.push(invalidUtf8)).toThrow("protocol");
  expect(() => decoder.push(new Uint8Array(NATIVE_FRAME_BYTES + 1))).toThrow(
    "oversized"
  );
});
