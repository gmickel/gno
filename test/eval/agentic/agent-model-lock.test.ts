import { describe, expect, test } from "bun:test";
// node:fs/promises: temporary directory lifecycle has no Bun equivalent.
import { mkdtemp, rm } from "node:fs/promises";
// node:os: temporary directory discovery has no Bun equivalent.
import { tmpdir } from "node:os";
// node:path: path construction has no Bun equivalent.
import { join } from "node:path";

import type { LocalModelRuntime } from "../../../evals/agentic/local-model-agent";

import { CANONICAL_AGENT_TOOLS } from "../../../evals/agentic/adapter";
import { sha256Bytes } from "../../../evals/agentic/canonical";
import { loadAgenticFixture } from "../../../evals/agentic/fixture-db";
import {
  AGENT_MODEL_LOCK_PATH,
  LocalModelAgentFactory,
  loadAndPreflightAgentModelLock,
  validateAgentModelLock,
} from "../../../evals/agentic/local-model-agent";
import { runAgenticBenchmark } from "../../../evals/agentic/runner";
import { createPerfectAdapterFactory } from "./driver-fakes";
import { taskFixture } from "./fixtures";

const lockForHash = (sha256: string) => ({
  schemaVersion: "1.0",
  modelUri: "hf:test/locked-model/model.gguf",
  fileSha256: sha256,
  tokenizer: {
    identifier: "locked-embedded-tokenizer-v1",
    sha256,
    checksumScope: "embedded-in-model-file",
  },
  maximumSteps: 3,
  maximumOutputTokens: 256,
  seedSchedule: [
    { trialId: "local-01", seed: 11 },
    { trialId: "local-02", seed: 22 },
    { trialId: "local-03", seed: 33 },
  ],
});

const withTinyLockedModel = async <T>(
  callback: (paths: { model: string; lock: string }) => Promise<T>
): Promise<T> => {
  const root = await mkdtemp(join(tmpdir(), "gno-agent-model-lock-"));
  try {
    const model = join(root, "model.gguf");
    const lock = join(root, "lock.json");
    const bytes = "tiny deterministic model fixture";
    await Bun.write(model, bytes);
    await Bun.write(
      lock,
      `${JSON.stringify(lockForHash(sha256Bytes(bytes)), null, 2)}\n`
    );
    return await callback({ model, lock });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

describe("cached local agent lock", () => {
  test("commits one exact non-placeholder model and three paired seeds", async () => {
    const lock = validateAgentModelLock(
      await Bun.file(AGENT_MODEL_LOCK_PATH).json()
    );
    expect(lock.seedSchedule).toHaveLength(3);
    expect(new Set(lock.seedSchedule.map((trial) => trial.seed)).size).toBe(3);
    expect(lock.tokenizer.sha256).toBe(lock.fileSha256);
  });

  test("rejects placeholders remote endpoints and malformed schedules", () => {
    const valid = lockForHash("1".repeat(64));
    expect(() =>
      validateAgentModelLock({
        ...valid,
        modelUri: "https://api.example/model",
      })
    ).toThrow("exact non-placeholder hf: URI");
    expect(() =>
      validateAgentModelLock({ ...valid, fileSha256: "0".repeat(64) })
    ).toThrow();
    expect(() =>
      validateAgentModelLock({
        ...valid,
        seedSchedule: [
          valid.seedSchedule[0],
          valid.seedSchedule[0],
          valid.seedSchedule[2],
        ],
      })
    ).toThrow("Invalid paired seed schedule");
  });

  test("fails closed for absent or checksum-mismatched local files", async () => {
    expect(
      loadAndPreflightAgentModelLock(undefined, AGENT_MODEL_LOCK_PATH)
    ).rejects.toThrow("GNO_AGENTIC_MODEL_PATH");
    await withTinyLockedModel(async ({ model, lock }) => {
      await Bun.write(model, "tampered");
      expect(loadAndPreflightAgentModelLock(model, lock)).rejects.toThrow(
        "checksum mismatch"
      );
    });
  });

  test("rejects duplicate lock keys before object validation", async () => {
    await withTinyLockedModel(async ({ model, lock }) => {
      const valid = await Bun.file(lock).text();
      await Bun.write(
        lock,
        valid.replace(
          '"modelUri": "hf:test/locked-model/model.gguf",',
          '"modelUri": "hf:test/locked-model/model.gguf",\n  "modelUri": "hf:test/other/model.gguf",'
        )
      );
      expect(loadAndPreflightAgentModelLock(model, lock)).rejects.toThrow(
        "Duplicate JSON key"
      );
    });
  });

  test("preflights locally and exposes exactly the locked paired schedule", async () => {
    await withTinyLockedModel(async ({ model, lock }) => {
      const resolved = await loadAndPreflightAgentModelLock(model, lock);
      const factory = new LocalModelAgentFactory(
        model,
        async (): Promise<LocalModelRuntime> => ({
          async load(signal) {
            signal.throwIfAborted();
          },
          async generate() {
            return "not used";
          },
          countTokens(text) {
            return text.length;
          },
          async dispose() {},
        }),
        lock
      );
      expect(await factory.trials()).toEqual(resolved.seedSchedule);
    });
  });

  test("rejects model prose instead of extracting embedded JSON", async () => {
    await withTinyLockedModel(async ({ model, lock }) => {
      const factory = new LocalModelAgentFactory(
        model,
        async (): Promise<LocalModelRuntime> => ({
          async load() {},
          async generate() {
            return "Here is the answer: {}";
          },
          countTokens() {
            return 1;
          },
          async dispose() {},
        }),
        lock
      );
      const started = await factory.open(new AbortController().signal);
      const session = await started.runtime.createSession(
        {
          task: taskFixture(),
          tools: CANONICAL_AGENT_TOOLS,
          trial: (await factory.trials())[0] as {
            trialId: string;
            seed: number;
          },
        },
        new AbortController().signal
      );
      expect(session.next([], new AbortController().signal)).rejects.toThrow(
        "not one JSON value"
      );
      await started.runtime.dispose();
    });
  });

  test("rejects duplicate local-model action keys", async () => {
    await withTinyLockedModel(async ({ model, lock }) => {
      const factory = new LocalModelAgentFactory(
        model,
        async (): Promise<LocalModelRuntime> => ({
          async load() {},
          async generate() {
            return '{"kind":"tool","toolName":"search","toolName":"get","arguments":{}}';
          },
          countTokens() {
            return 1;
          },
          async dispose() {},
        }),
        lock
      );
      const started = await factory.open(new AbortController().signal);
      const session = await started.runtime.createSession(
        {
          task: taskFixture(),
          tools: CANONICAL_AGENT_TOOLS,
          trial: (await factory.trials())[0] as {
            trialId: string;
            seed: number;
          },
        },
        new AbortController().signal
      );
      expect(session.next([], new AbortController().signal)).rejects.toThrow(
        "Duplicate JSON key"
      );
      await started.runtime.dispose();
    });
  });

  test("runs the same three trial IDs seeds and task order for every adapter", async () => {
    await withTinyLockedModel(async ({ model, lock }) => {
      const fixture = await loadAgenticFixture();
      const agentFactory = new LocalModelAgentFactory(
        model,
        async (): Promise<LocalModelRuntime> => ({
          async load() {},
          async generate(prompt) {
            if (prompt.endsWith("Prior normalized calls:\n[]")) {
              return '{"kind":"tool","toolName":"search","arguments":{"query":"budget"}}';
            }
            return '{"schemaVersion":"1.0","claims":[],"gaps":[{"claimKey":"approvedBudget","reason":"missing_evidence"}],"abstained":true,"stopReason":"abstained"}';
          },
          countTokens(text) {
            return text.length;
          },
          async dispose() {},
        }),
        lock
      );
      const first = createPerfectAdapterFactory(fixture.snapshot, {
        adapterId: "first",
      });
      const second = createPerfectAdapterFactory(fixture.snapshot, {
        adapterId: "second",
      });
      const result = await runAgenticBenchmark({
        adapters: { first: first.factory, second: second.factory },
        fixture,
        taskIds: ["t234cd5e"],
        lifecycles: ["cold"],
        agentFactory,
      });
      const schedules = new Map<string, Array<[string, number | null]>>();
      for (const receipt of result.receipts) {
        const schedule = schedules.get(receipt.canonical.adapterId) ?? [];
        schedule.push([receipt.canonical.trialId, receipt.canonical.seed]);
        schedules.set(receipt.canonical.adapterId, schedule);
      }
      expect(schedules.get("first")).toEqual(schedules.get("second"));
      expect(schedules.get("first")).toEqual([
        ["local-01", 11],
        ["local-02", 22],
        ["local-03", 33],
      ]);
    });
  });
});
