import { expect, test } from "bun:test";
import { EventRelay } from "lifecycle-utils";

import type { SimulatorGuard } from "../../src/llm/nodeLlamaCpp/simulator-types";
import type { SimulatorModel } from "../../src/llm/nodeLlamaCpp/simulator-types";

import {
  loadSimulatorDependencies,
  verifySimulatorPackage,
} from "../../src/llm/nodeLlamaCpp/simulator-install";
import { GuardedSimulatorSession } from "../../src/llm/nodeLlamaCpp/simulator-session";

const dependencies = await loadSimulatorDependencies(
  await verifySimulatorPackage()
);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

const { GgufInsightsSimulatorSession } = await import(
  new URL("./gguf/insights/GgufInsights.js", await verifySimulatorPackage())
    .href
);

function fake(
  options: {
    pauseModel?: boolean;
    failModel?: boolean;
    upstream?: boolean;
  } = {}
) {
  const events: string[] = [];
  const contextEntered = deferred();
  const contextResume = deferred();
  const modelEntered = deferred();
  const modelResume = deferred();
  const backend = new dependencies.DisposeGuard([]) as SimulatorGuard & {
    _preventionHandles: number;
  };
  let freeCount = 0;
  let modelCount = 0;
  let first = true;
  class AddonModel {
    freed = false;
    id = ++modelCount;
    async init() {
      events.push(`modelInit:${this.id}`);
      modelEntered.resolve();
      if (options.pauseModel) await modelResume.promise;
      if (options.failModel && first) {
        first = false;
        throw Error("controlled model initialization failure");
      }
      return true;
    }
    getMemoryBreakdown() {
      if (this.freed) throw Error("model freed during memory read");
      return { cpuRam: 12, gpuVram: 34 };
    }
    async dispose() {
      if (this.freed) throw Error("duplicate model free");
      this.freed = true;
      freeCount++;
      events.push(`modelFree:${this.id}`);
    }
  }
  class AddonContext {
    readonly model: AddonModel;
    constructor(model: SimulatorModel) {
      this.model = model as AddonModel;
    }
    async init() {
      events.push(`contextInit:${this.model.id}`);
      contextEntered.resolve();
      if (this.model.id === 1) await contextResume.promise;
      return true;
    }
    getMemoryBreakdown() {
      events.push(`memoryRead:${this.model.id}`);
      return this.model.getMemoryBreakdown();
    }
    async dispose() {
      events.push(`contextDispose:${this.model.id}`);
    }
  }
  const llama = {
    gpu: "cuda",
    supportsMmap: true,
    _memoryLock: {},
    _bindings: { AddonModel, AddonContext },
    _backendDisposeGuard: backend,
    onDispose: new EventRelay<void>(),
    _createLogLevelOverride: () => () => {},
    _shouldLog: () => false,
    _log: () => {},
  };
  const session: GuardedSimulatorSession = options.upstream
    ? new GgufInsightsSimulatorSession(llama, 1)
    : new GuardedSimulatorSession(llama, dependencies, 1);
  const estimate = (gpuLayers = 1) =>
    session.estimateContextResources({
      modelSource: "same-pinned-model",
      gpuLayers,
      contextSize: 2048,
      batchSize: 512,
      sequences: 1,
    });
  return {
    session,
    estimate,
    llama,
    backend,
    events,
    contextEntered,
    contextResume,
    modelEntered,
    modelResume,
    freeCount: () => freeCount,
  };
}

// Drain only queued Promise continuations, never a timer or native operation.
async function microtasks() {
  for (let i = 0; i < 32; i++) await Promise.resolve();
}

for (const upstream of [false, true]) {
  test(`paused context survives ${upstream ? "upstream" : "GNO"} session disposal through memory read`, async () => {
    const state = fake({ upstream });
    const estimation = state.estimate();
    await state.contextEntered.promise;
    const disposal = state.session.dispose();
    if (!upstream) expect(state.session.dispose()).toBe(disposal);
    try {
      await microtasks();
      expect(state.freeCount()).toBe(0);
    } finally {
      state.contextResume.resolve();
      await Promise.allSettled([estimation, disposal]);
    }
    expect(await estimation).toEqual({ cpuRam: 12, gpuVram: 34 });
    expect(state.events).toEqual([
      "modelInit:1",
      "contextInit:1",
      "memoryRead:1",
      "contextDispose:1",
      "modelFree:1",
    ]);
    expect(state.backend._preventionHandles).toBe(0);
  });
}

test("session disposal during asynchronous model creation cannot free an active context", async () => {
  const state = fake({ pauseModel: true });
  const estimation = state.estimate();
  await state.modelEntered.promise;
  const disposal = state.session.dispose();
  state.modelResume.resolve();
  await state.contextEntered.promise;
  state.contextResume.resolve();
  await Promise.all([estimation, disposal]);
  expect(state.events.indexOf("modelFree:1")).toBeGreaterThan(
    state.events.indexOf("contextDispose:1")
  );
  expect(state.freeCount()).toBe(1);
  expect(state.backend._preventionHandles).toBe(0);
});

test("LRU eviction waits for users; backend disposal drains evicted and cached handles", async () => {
  const state = fake();
  const first = state.estimate();
  await state.contextEntered.promise;
  await state.estimate(2);
  state.llama.onDispose.dispatchEvent();
  let backendDisposed = false;
  const disposal = state.backend.acquireDisposeLock().then(() => {
    backendDisposed = true;
  });
  await microtasks();
  expect(backendDisposed).toBe(false);
  expect(state.events).not.toContain("modelFree:1");
  state.contextResume.resolve();
  await first;
  await disposal;
  await state.session.dispose();
  expect(state.freeCount()).toBe(2);
  expect(state.backend._preventionHandles).toBe(0);
});

test("failed model creation releases native ownership and failed cache entry is retryable", async () => {
  const state = fake({ failModel: true });
  const failure = await state.estimate().then(
    () => null,
    (error: unknown) => error
  );
  expect(failure).toBeInstanceOf(Error);
  expect(state.freeCount()).toBe(1);
  state.contextResume.resolve();
  expect(await state.estimate()).toEqual({ cpuRam: 12, gpuVram: 34 });
  await state.session.dispose();
  expect(state.freeCount()).toBe(2);
  expect(state.backend._preventionHandles).toBe(0);
});

test("backend handle acquisition failure releases the newly created raw model", async () => {
  const state = fake({ pauseModel: true });
  const result = state.estimate().then(
    () => null,
    (error: unknown) => error
  );
  await state.modelEntered.promise;
  const backendDisposal = state.backend.acquireDisposeLock();
  state.modelResume.resolve();
  expect(await result).toBeInstanceOf(Error);
  await backendDisposal;
  await state.session.dispose();
  expect(state.freeCount()).toBe(1);
  expect(state.backend._preventionHandles).toBe(0);
});
