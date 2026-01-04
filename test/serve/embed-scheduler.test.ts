/**
 * Tests for embed-scheduler.
 *
 * @module test/serve/embed-scheduler
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { EmbeddingPort } from "../../src/llm/types";
import type { VectorIndexPort } from "../../src/store/vector";

import { createEmbedScheduler } from "../../src/serve/embed-scheduler";

// Mock database
function createMockDb() {
  return {
    prepare: () => ({
      all: () => [],
      get: () => ({ count: 0 }),
    }),
  } as never;
}

// Mock embedding port
function createMockEmbedPort(embeddings: number[][] = [[0.1, 0.2, 0.3]]) {
  return {
    embed: mock(() => Promise.resolve({ ok: true, value: embeddings[0] })),
    embedBatch: mock((texts: string[]) =>
      Promise.resolve({
        ok: true,
        value: texts.map(() => embeddings[0]),
      })
    ),
    dimensions: () => 3,
    init: () => Promise.resolve({ ok: true }),
    dispose: () => Promise.resolve(),
  } as unknown as EmbeddingPort;
}

// Mock vector index port
function createMockVectorIndex() {
  return {
    searchAvailable: true,
    model: "test-model",
    dimensions: 3,
    upsertVectors: mock(() => Promise.resolve({ ok: true })),
    deleteVectorsForMirror: mock(() => Promise.resolve({ ok: true })),
    searchNearest: mock(() => Promise.resolve({ ok: true, value: [] })),
    rebuildVecIndex: mock(() => Promise.resolve({ ok: true })),
    syncVecIndex: mock(() =>
      Promise.resolve({ ok: true, value: { added: 0, removed: 0 } })
    ),
  } as unknown as VectorIndexPort;
}

describe("EmbedScheduler", () => {
  let originalTimers: typeof globalThis.setTimeout;

  beforeEach(() => {
    originalTimers = globalThis.setTimeout;
  });

  afterEach(() => {
    globalThis.setTimeout = originalTimers;
  });

  test("getState returns initial state", () => {
    const embedPort = createMockEmbedPort();
    const scheduler = createEmbedScheduler({
      db: createMockDb(),
      getEmbedPort: () => embedPort,
      getVectorIndex: () => createMockVectorIndex(),
      getModelUri: () => "test-model",
    });

    const state = scheduler.getState();
    expect(state.pendingDocCount).toBe(0);
    expect(state.running).toBe(false);
    expect(state.nextRunAt).toBeUndefined();

    scheduler.dispose();
  });

  test("notifySyncComplete adds docIds to pending count", () => {
    const embedPort = createMockEmbedPort();
    const scheduler = createEmbedScheduler({
      db: createMockDb(),
      getEmbedPort: () => embedPort,
      getVectorIndex: () => createMockVectorIndex(),
      getModelUri: () => "test-model",
    });

    scheduler.notifySyncComplete(["doc1", "doc2"]);

    const state = scheduler.getState();
    expect(state.pendingDocCount).toBe(2);

    scheduler.dispose();
  });

  test("notifySyncComplete accumulates counts", () => {
    const embedPort = createMockEmbedPort();
    const scheduler = createEmbedScheduler({
      db: createMockDb(),
      getEmbedPort: () => embedPort,
      getVectorIndex: () => createMockVectorIndex(),
      getModelUri: () => "test-model",
    });

    scheduler.notifySyncComplete(["doc1", "doc2"]);
    scheduler.notifySyncComplete(["doc2", "doc3"]);

    const state = scheduler.getState();
    // Now counts rather than deduplicates
    expect(state.pendingDocCount).toBe(4);

    scheduler.dispose();
  });

  test("triggerNow returns result immediately", async () => {
    const embedPort = createMockEmbedPort();
    const scheduler = createEmbedScheduler({
      db: createMockDb(),
      getEmbedPort: () => embedPort,
      getVectorIndex: () => createMockVectorIndex(),
      getModelUri: () => "test-model",
    });

    scheduler.notifySyncComplete(["doc1"]);
    const result = await scheduler.triggerNow();

    expect(result).not.toBeNull();
    expect(result?.embedded).toBe(0); // No actual backlog in mock
    expect(result?.errors).toBe(0);

    // Pending should be cleared
    const state = scheduler.getState();
    expect(state.pendingDocCount).toBe(0);

    scheduler.dispose();
  });

  test("triggerNow returns null without embedPort", async () => {
    const scheduler = createEmbedScheduler({
      db: createMockDb(),
      getEmbedPort: () => null,
      getVectorIndex: () => null,
      getModelUri: () => "test-model",
    });

    const result = await scheduler.triggerNow();
    expect(result).toBeNull();

    scheduler.dispose();
  });

  test("notifySyncComplete does nothing without embedPort", () => {
    const scheduler = createEmbedScheduler({
      db: createMockDb(),
      getEmbedPort: () => null,
      getVectorIndex: () => null,
      getModelUri: () => "test-model",
    });

    scheduler.notifySyncComplete(["doc1"]);

    const state = scheduler.getState();
    expect(state.pendingDocCount).toBe(0);

    scheduler.dispose();
  });

  test("dispose clears timer", () => {
    const embedPort = createMockEmbedPort();
    const scheduler = createEmbedScheduler({
      db: createMockDb(),
      getEmbedPort: () => embedPort,
      getVectorIndex: () => createMockVectorIndex(),
      getModelUri: () => "test-model",
    });

    scheduler.notifySyncComplete(["doc1", "doc2"]);
    scheduler.dispose();

    // After dispose, notifySyncComplete should be no-op
    scheduler.notifySyncComplete(["doc3"]);
    const state = scheduler.getState();
    // Count doesn't change after dispose
    expect(state.pendingDocCount).toBe(2);
  });

  test("scheduler reports nextRunAt when timer is set", () => {
    const embedPort = createMockEmbedPort();
    const scheduler = createEmbedScheduler({
      db: createMockDb(),
      getEmbedPort: () => embedPort,
      getVectorIndex: () => createMockVectorIndex(),
      getModelUri: () => "test-model",
    });

    scheduler.notifySyncComplete(["doc1"]);

    const state = scheduler.getState();
    expect(state.nextRunAt).toBeDefined();
    expect(state.nextRunAt).toBeGreaterThan(Date.now());

    scheduler.dispose();
  });

  test("getters are called at execution time (survives context reload)", async () => {
    let currentPort: EmbeddingPort | null = createMockEmbedPort();
    let currentModel = "model-v1";

    const scheduler = createEmbedScheduler({
      db: createMockDb(),
      getEmbedPort: () => currentPort,
      getVectorIndex: () => createMockVectorIndex(),
      getModelUri: () => currentModel,
    });

    // Simulate context reload
    currentPort = createMockEmbedPort();
    currentModel = "model-v2";

    scheduler.notifySyncComplete(["doc1"]);
    const result = await scheduler.triggerNow();

    // Should still work after "reload"
    expect(result).not.toBeNull();
    expect(result?.embedded).toBe(0);

    scheduler.dispose();
  });

  test("notify during running schedules rerun (Critical #2 regression)", async () => {
    // Create embed port with controlled async behavior
    let embedResolve:
      | ((value: { ok: true; value: number[][] }) => void)
      | null = null;
    const embedPromise = new Promise<{ ok: true; value: number[][] }>(
      (resolve) => {
        embedResolve = resolve;
      }
    );

    const slowEmbedPort = {
      embed: mock(() => Promise.resolve({ ok: true, value: [0.1, 0.2, 0.3] })),
      embedBatch: mock(() => embedPromise),
      dimensions: () => 3,
      init: () => Promise.resolve({ ok: true }),
      dispose: () => Promise.resolve(),
    } as unknown as EmbeddingPort;

    // Mock DB that returns one backlog item on first call, empty on second
    let backlogCalls = 0;
    const mockDb = {
      prepare: () => ({
        all: () => {
          backlogCalls++;
          return backlogCalls === 1
            ? [
                {
                  mirrorHash: "hash1",
                  seq: 0,
                  text: "test",
                  title: "Test",
                  reason: "new",
                },
              ]
            : [];
        },
        get: () => ({ count: 1 }),
      }),
    } as never;

    const scheduler = createEmbedScheduler({
      db: mockDb,
      getEmbedPort: () => slowEmbedPort,
      getVectorIndex: () => createMockVectorIndex(),
      getModelUri: () => "test-model",
    });

    // Start first run (will block on embedBatch)
    scheduler.notifySyncComplete(["doc1"]);
    const runPromise = scheduler.triggerNow();

    // Allow microtask to start the run
    await Promise.resolve();

    // While running, notify again
    scheduler.notifySyncComplete(["doc2", "doc3"]);

    // Pending should accumulate during run
    const midRunState = scheduler.getState();
    expect(midRunState.running).toBe(true);
    expect(midRunState.pendingDocCount).toBe(2); // doc2, doc3 accumulated

    // Complete the first run
    embedResolve!({ ok: true, value: [[0.1, 0.2, 0.3]] });
    await runPromise;

    // After run, pendingCount should still be 2 (not cleared) and rerun scheduled
    const postRunState = scheduler.getState();
    expect(postRunState.running).toBe(false);
    expect(postRunState.pendingDocCount).toBe(2);
    expect(postRunState.nextRunAt).toBeDefined(); // Rerun scheduled

    scheduler.dispose();
  });
});
