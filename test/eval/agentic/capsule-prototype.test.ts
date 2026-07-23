import { beforeAll, describe, expect, test } from "bun:test";

import type { CapsulePrototypePayload } from "../../../evals/agentic/adapters/capsule-prototype";
import type { LoadedAgenticFixture } from "../../../evals/agentic/fixture-db";

import {
  capsulePayloadFingerprint,
  createCapsulePrototypeAdapterFactory,
} from "../../../evals/agentic/adapters/capsule-prototype";
import {
  canonicalJson,
  exactLineSpan,
  projectModelVisibleToolResult,
  sha256Bytes,
} from "../../../evals/agentic/canonical";
import { loadAgenticFixture } from "../../../evals/agentic/fixture-db";
import { runAgenticBenchmark } from "../../../evals/agentic/runner";
import { scoreTrajectory } from "../../../evals/agentic/scoring";
import { CONTEXT_AGENT_PROJECTION_SCHEMA_VERSION } from "../../../src/app/context-agent-projection";

const RECORDED_AT = "2026-07-22T00:00:00.000Z";

describe("Capsule prototype with production model-visible projection", () => {
  let fixture: LoadedAgenticFixture;

  beforeAll(async () => {
    fixture = await loadAgenticFixture();
  });

  const runAll = () =>
    runAgenticBenchmark({
      fixture,
      adapters: { capsule: createCapsulePrototypeAdapterFactory() },
      adapterIds: ["capsule"],
      lifecycles: ["cold"],
      recordedAt: () => RECORDED_AT,
    });

  test("produces successful one-call exact extractive bundles for all 24 tasks", async () => {
    const run = await runAll();

    expect(run.receipts).toHaveLength(24);
    for (const receipt of run.receipts) {
      const task = fixture.tasks.get(receipt.canonical.taskId);
      const oracle = fixture.oracles.get(receipt.canonical.taskId);
      expect(task).toBeDefined();
      expect(oracle).toBeDefined();
      expect(scoreTrajectory(task!, oracle!, receipt).success).toBe(1);
      expect(receipt.canonical.failure.class).toBe("none");
      expect(receipt.canonical.agentCalls).toBe(1);
      expect(receipt.canonical.backendInvocations).toBeGreaterThan(1);
      const call = receipt.canonical.calls[0];
      expect(call).toBeDefined();
      if (!call) throw new Error("Capsule receipt has no search call");
      expect(call.result.resultRole).toBe("evidence_bundle");
      expect(call.result.evidence.length).toBeGreaterThan(0);
      expect(projectModelVisibleToolResult(call.result).evidence).toEqual([]);
      expect(call.backendInvocations).toBe(
        receipt.canonical.backendInvocations
      );
      expect(call.modelVisibleUtf8Bytes).toBeLessThanOrEqual(
        task!.budgets.maxModelVisibleBytes
      );
      const payload = JSON.parse(
        call.result.content
      ) as CapsulePrototypePayload;
      expect(payload.v).toBe(CONTEXT_AGENT_PROJECTION_SCHEMA_VERSION);
      expect(receipt.canonical.fingerprints.index).toMatch(/^[a-f0-9]{64}$/);
      expect(receipt.canonical.fingerprints.config).toMatch(/^[a-f0-9]{64}$/);
      expect(receipt.canonical.backendInvocations).toBeGreaterThan(1);
      expect(payload.o[1].reduce((sum, [, count]) => sum + count, 0)).toBe(
        payload.o[0]
      );
      expect(payload).not.toHaveProperty("cli");
      expect(payload).not.toHaveProperty("mcp");
      expect(payload).not.toHaveProperty("rest");
      expect(payload).not.toHaveProperty("sdk");
      for (const evidence of call.result.evidence) {
        const source = fixture.snapshot.files.find(
          (file) =>
            file.taskId === receipt.canonical.taskId &&
            `gno://${file.collection}/${file.relPath}` === evidence.uri
        );
        expect(source).toBeDefined();
        expect(evidence.text).toBe(
          exactLineSpan(source!.content, evidence.startLine, evidence.endLine)
        );
        expect(evidence.sourceHash).toBe(source!.sourceHash);
        expect(evidence.spanHash).toBe(sha256Bytes(evidence.text));
        expect(payload.e).toContainEqual([
          evidence.uri,
          evidence.startLine,
          evidence.endLine,
          evidence.sourceHash,
          evidence.sourceHash,
          evidence.spanHash,
          evidence.text,
          null,
          null,
          [],
          "unavailable",
        ]);
      }
    }
  });

  test("replays byte-identical canonical payload JSON and SHA-256", async () => {
    const first = await runAll();
    const second = await runAll();
    const secondByTask = new Map(
      second.receipts.map((receipt) => [receipt.canonical.taskId, receipt])
    );

    for (const firstReceipt of first.receipts) {
      const secondReceipt = secondByTask.get(firstReceipt.canonical.taskId);
      const firstJson = firstReceipt.canonical.calls[0]?.result.content ?? "";
      const secondJson =
        secondReceipt?.canonical.calls[0]?.result.content ?? "";
      expect(firstJson).toBe(secondJson);
      expect(canonicalJson(JSON.parse(firstJson))).toBe(firstJson);
      expect(capsulePayloadFingerprint(firstJson)).toBe(
        capsulePayloadFingerprint(secondJson)
      );
      expect(capsulePayloadFingerprint(firstJson)).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  test("keeps the prepared index and canonical bundle identical across lifecycle modes", async () => {
    const run = await runAgenticBenchmark({
      fixture,
      adapters: { capsule: createCapsulePrototypeAdapterFactory() },
      adapterIds: ["capsule"],
      taskIds: ["t4e5f607"],
      lifecycles: ["cold", "warm"],
      recordedAt: () => RECORDED_AT,
    });

    expect(run.preparations).toHaveLength(1);
    expect(run.receipts).toHaveLength(2);
    expect(run.receipts[0]?.canonical.fingerprints.index).toBe(
      run.receipts[1]?.canonical.fingerprints.index
    );
    expect(run.receipts[0]?.canonical.calls[0]?.result.content).toBe(
      run.receipts[1]?.canonical.calls[0]?.result.content
    );
  });

  test("audits deterministic exact omission counts", async () => {
    const run = await runAgenticBenchmark({
      fixture,
      adapters: { capsule: createCapsulePrototypeAdapterFactory() },
      adapterIds: ["capsule"],
      taskIds: ["t7891a03"],
      lifecycles: ["cold"],
      recordedAt: () => RECORDED_AT,
    });
    const payload = JSON.parse(
      run.receipts[0]?.canonical.calls[0]?.result.content ?? ""
    ) as CapsulePrototypePayload;

    expect(payload.o[0]).toBe(2);
    expect(Object.fromEntries(payload.o[1]).redundant_coverage).toBe(2);
  });

  test("enforces active task scope for unscoped search and every read", async () => {
    const factory = createCapsulePrototypeAdapterFactory();
    const owner = factory();
    const preparation = await owner.prepare({
      snapshot: fixture.snapshot,
      prepared: null,
      signal: new AbortController().signal,
    });
    const adapter = factory();
    try {
      await adapter.prepare({
        snapshot: fixture.snapshot,
        prepared: preparation,
        signal: new AbortController().signal,
      });
      const task = fixture.tasks.get("t0a1b2c3");
      if (!task) throw new Error("Missing task");
      await adapter.reset({
        task,
        lifecycle: "cold",
        readinessProbe: false,
        signal: new AbortController().signal,
      });
      const search = await adapter.callTool(
        "search",
        { query: "owner" },
        new AbortController().signal
      );
      expect(search.result.content).not.toContain("gno://c00c/");
      expect(
        search.result.evidence.every((item) =>
          item.uri.startsWith("gno://c001/")
        )
      ).toBe(true);
      for (const [toolName, arguments_] of [
        ["get", { uri: "gno://c00c/d001.md" }],
        ["multi_get", { uris: ["gno://c00c/d001.md"] }],
        ["search", { query: "owner", collection: "c00c" }],
      ] as const) {
        let rejected = false;
        try {
          await adapter.callTool(
            toolName,
            arguments_,
            new AbortController().signal
          );
        } catch (error) {
          rejected = true;
          expect((error as { code?: string }).code).toBe(
            "task_scope_violation"
          );
        }
        expect(rejected).toBe(true);
      }
    } finally {
      await adapter.dispose();
      await owner.dispose();
    }
  });
});
