import { expect, test } from "bun:test";

import { ModelConfigSchema } from "../../src/config/types";
import { inferenceFailedError } from "../../src/llm/errors";
import {
  InferenceSettlement,
  isInferenceCancellation,
} from "../../src/llm/inference-cancellation";
import {
  NativeCancellationSchema,
  NativeExecutionStartedSchema,
  NativeRequestLedger,
  NativeRequestSchema,
} from "../../src/llm/native-worker/protocol";
import { wireError } from "../../src/llm/native-worker/runtime-config";

test.each(["queued", "native-active", "response-pending"] as const)(
  "abort in %s settles once and retains unfinished native ownership",
  async (phase) => {
    const controller = new AbortController();
    const operation = new InferenceSettlement<string>({
      signal: controller.signal,
    });
    if (phase !== "queued") expect(operation.startNative()).toBe(true);
    if (phase === "response-pending")
      operation.nativeSettled({ ok: true, value: "late" });
    // Even a synchronous abort callback cannot publish success.
    operation.signal.addEventListener("abort", () => operation.publish());
    controller.abort(new Error("caller-private reason"));
    const result = await operation.completion;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(isInferenceCancellation(result.error)).toBe(true);
      expect(isInferenceCancellation(wireError(result.error))).toBe(true);
      expect(JSON.stringify(result)).not.toContain("caller-private");
    }
    expect(operation.ownsNative).toBe(phase === "native-active");
    expect(operation.startNative()).toBe(false);
    expect(operation.startExecution()).toBe(false);
    operation.nativeSettled({ ok: true, value: "late" });
    expect(operation.ownsNative).toBe(false);
    expect(operation.publish()).toBe(false);
    operation.cancel("timeout");
    expect(await operation.completion).toBe(result);
    expect(operation.phase).toBe("settled");
  }
);

test("pre-aborted and expired requests never acquire native ownership", async () => {
  for (const options of [
    { signal: AbortSignal.abort() },
    { deadlineAt: Date.now() - 1 },
  ]) {
    const operation = new InferenceSettlement(options);
    expect(operation.startNative()).toBe(false);
    expect(operation.ownsNative).toBe(false);
    expect((await operation.completion).ok).toBe(false);
  }
});

test.each(["queued", "native-active", "response-pending"] as const)(
  "caller deadline covers %s independently of execution",
  async (phase) => {
    const operation = new InferenceSettlement<string>(
      { deadlineAt: Date.now() + 15 },
      1_000
    );
    if (phase !== "queued") operation.startNative();
    if (phase === "response-pending")
      operation.nativeSettled({ ok: true, value: "late" });
    expect(await operation.completion).toMatchObject({
      ok: false,
      error: { code: "TIMEOUT", cause: { name: "TimeoutError" } },
    });
    expect(operation.ownsNative).toBe(phase === "native-active");
    operation.nativeSettled({ ok: true, value: "late" });
    expect(operation.publish()).toBe(false);
  }
);

test("execution timeout excludes loading and does not release noncooperative work", async () => {
  const operation = new InferenceSettlement<string>({}, 10);
  operation.startNative();
  await Bun.sleep(20);
  expect(operation.signal.aborted).toBe(false);
  expect(operation.startExecution()).toBe(true);
  expect(operation.startExecution()).toBe(false);
  expect(await operation.completion).toMatchObject({
    ok: false,
    error: { code: "TIMEOUT" },
  });
  expect(operation.signal.aborted).toBe(true);
  expect(operation.ownsNative).toBe(true);
  operation.nativeSettled({ ok: true, value: "late" });
  expect(operation.ownsNative).toBe(false);
  expect(operation.publish()).toBe(false);
});

test("expired execution cannot publish when native completion beats a delayed timer callback", async () => {
  const operation = new InferenceSettlement<string>({}, 5);
  operation.startNative();
  operation.startExecution();
  const until = performance.now() + 10;
  // Simulate a native call blocking the JS thread past its execution deadline.
  while (performance.now() < until) {
    /* deliberate blocking */
  }
  operation.nativeSettled({ ok: true, value: "expired" });
  expect(operation.publish()).toBe(false);
  expect(await operation.completion).toMatchObject({
    ok: false,
    error: { code: "TIMEOUT" },
  });
});

test("native settlement stops execution timer; publication preserves success or native failure", async () => {
  const failure = inferenceFailedError(
    "file:/model",
    new Error("native failure")
  );
  for (const result of [
    { ok: true, value: "exact output" } as const,
    { ok: false, error: failure } as const,
  ]) {
    const operation = new InferenceSettlement<string>({}, 5);
    operation.startNative();
    operation.startExecution();
    operation.nativeSettled(result);
    operation.nativeSettled({ ok: true, value: "duplicate" });
    await Bun.sleep(10);
    expect(operation.signal.aborted).toBe(false);
    expect(operation.publish()).toBe(true);
    operation.cancel("abort");
    expect(operation.publish()).toBe(false);
    expect(await operation.completion).toBe(result);
  }
  expect(isInferenceCancellation(failure)).toBe(false);
});

test("wire controls preserve identity and cannot manufacture settlement or capacity", () => {
  const identity = { version: 1, generation: 1, requestId: 1 };
  const request = NativeRequestSchema.parse({
    ...identity,
    op: "embed",
    modelId: "embed",
    text: "unchanged",
    deadlineAt: 123,
  });
  const ledger = new NativeRequestLedger(1);
  ledger.admit(request);
  for (const cancel of ["abort", "timeout"]) {
    const control = NativeCancellationSchema.parse({ ...identity, cancel });
    expect(() => ledger.settle(control)).toThrow();
    expect(ledger.size).toBe(1);
  }
  const started = NativeExecutionStartedSchema.parse({
    ...identity,
    executionStarted: true,
  });
  expect(() => ledger.settle(started)).toThrow();
  expect(ledger.size).toBe(1);
  const response = {
    ...identity,
    op: "embed",
    result: { ok: true, value: [0.5] },
  };
  ledger.settle(response);
  expect(ledger.size).toBe(0);
  expect(() => ledger.settle(response)).toThrow();
  expect(
    NativeCancellationSchema.safeParse({
      ...identity,
      generation: 0,
      cancel: "abort",
    }).success
  ).toBe(false);
  expect(
    NativeCancellationSchema.safeParse({ ...identity, cancel: "success" })
      .success
  ).toBe(false);
  expect(
    NativeRequestSchema.safeParse({ ...request, signal: {} }).success
  ).toBe(false);
});

test("invalid timeout/deadline controls fail validation instead of overflowing or disabling timers", () => {
  for (const value of [
    0,
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2_147_483_648,
  ]) {
    for (const field of ["inferenceTimeout", "loadTimeout"]) {
      expect(ModelConfigSchema.safeParse({ [field]: value }).success).toBe(
        false
      );
    }
    expect(() => new InferenceSettlement({}, value)).toThrow(RangeError);
  }
  for (const deadlineAt of [
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    expect(() => new InferenceSettlement({ deadlineAt })).toThrow(RangeError);
    expect(
      NativeRequestSchema.safeParse({
        version: 1,
        generation: 1,
        requestId: 1,
        op: "init",
        modelId: "embed",
        deadlineAt,
      }).success
    ).toBe(false);
  }
  expect(ModelConfigSchema.parse({})).toMatchObject({
    loadTimeout: 60_000,
    inferenceTimeout: 30_000,
  });
  expect(
    ModelConfigSchema.safeParse({
      loadTimeout: 1,
      inferenceTimeout: 2_147_483_647,
    }).success
  ).toBe(true);
});
