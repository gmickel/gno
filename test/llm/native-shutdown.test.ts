import { expect, test } from "bun:test";

import type { Owner } from "../../src/llm/native-worker/owner";

import { NativeWorkerClient } from "../../src/llm/native-worker/client";
import { retireOwnedChild } from "../../src/llm/native-worker/owned-exit";
import {
  NativeFrameDecoder,
  NativeRequestLedger,
} from "../../src/llm/native-worker/protocol";

test("stuck owned IPC child is reaped once while an unrelated child survives", async () => {
  const unrelated = Bun.spawn(
    [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    { stdout: "ignore", stderr: "ignore" }
  );
  const client = new NativeWorkerClient({
    models: [
      {
        id: "e",
        type: "embed",
        modelUri: "file:/synthetic",
        path: "/synthetic",
      },
    ],
    loadTimeout: 2000,
    inferenceTimeout: 2000,
    entryPath: `${import.meta.dir}/../fixtures/native-shutdown-child.ts`,
  });
  try {
    expect((await client.request({ op: "init", modelId: "e" })).ok).toBe(true);
    const pid = client.processId!;
    let delivered = 0;
    const pending = client
      .request({ op: "embed", modelId: "e", text: "stuck" })
      .then((result) => {
        delivered++;
        return result;
      });
    await Bun.sleep(10);
    const started = performance.now();
    await Promise.all([
      client.dispose({ force: true, deadline: started + 1000 }),
      client.dispose({ force: true, deadline: started + 1000 }),
    ]);
    expect(performance.now() - started).toBeLessThan(1100);
    expect((await pending).ok).toBe(false);
    expect(delivered).toBe(1);
    expect(client.processId).toBeUndefined();
    expect(() => process.kill(pid, 0)).toThrow();
    expect(unrelated.exitCode).toBeNull();
  } finally {
    await client.dispose();
    unrelated.kill("SIGKILL");
    await unrelated.exited;
  }
});

test.each(["no-exit", "kill-error", "tightened"])(
  "OS %s is a bounded explicit failure, never false exit confirmation",
  async (failure) => {
    const signals: string[] = [];
    const started = performance.now();
    const child = {
      pid: 12345,
      send: () => {},
      kill: (signal: string) => {
        signals.push(signal);
        if (failure === "kill-error") throw new Error("EPERM");
      },
      exited: new Promise<number>(() => {}),
    };
    const owner: Owner = {
      child: child as never,
      generation: 1,
      foregroundCompletions: 0,
      ledger: new NativeRequestLedger(1),
      decoder: new NativeFrameDecoder(1),
      pending: [],
      ready: true,
      busy: true,
      quarantined: true,
      waiters: new Set(),
      retiring: false,
      drain: new Set(),
    };
    const retirement = retireOwnedChild(owner, {
      force: failure !== "tightened",
      deadline: started + (failure === "tightened" ? 10_000 : 20),
    });
    if (failure === "tightened") {
      await Bun.sleep(5);
      expect(
        retireOwnedChild(owner, { force: true, deadline: started + 20 })
      ).toBe(retirement);
    }
    const error = await retirement.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: expect.stringContaining("Owned native child 12345"),
    });
    expect(owner.child.pid).toBe(12345);
    expect(owner.retiring).toBe(true);
    expect(owner.quarantined).toBe(true);
    expect(owner.busy).toBe(true);
    expect(signals).toEqual(["SIGKILL"]);
    expect(performance.now() - started).toBeLessThan(250);
    if (failure === "no-exit") {
      const client = new NativeWorkerClient({
        models: [
          {
            id: "unavailable",
            type: "embed",
            modelUri: "file:/unavailable",
            path: "/unavailable",
          },
        ],
        loadTimeout: 2000,
        inferenceTimeout: 2000,
      });
      // Inject only synthetic unreapable ownership; no OS process has this PID.
      Reflect.set(client, "owner", owner);
      const generation = client.currentGeneration;
      try {
        const failedAdmission = await client.request({
          op: "init",
          modelId: "unavailable",
        });
        expect(failedAdmission.ok).toBe(false);
        expect(client.currentGeneration).toBe(generation);
        expect(client.processId).toBe(12345);
        const modelDisposal = await client
          .disposeModel("file:/unavailable")
          .catch((cause: unknown) => cause);
        expect(modelDisposal).toBeInstanceOf(Error);
        const again = await client.dispose().catch((cause: unknown) => cause);
        expect(again).toBeInstanceOf(Error);
        expect(client.processId).toBe(12345);
        expect(signals).toEqual(["SIGKILL"]);
      } finally {
        // Remove the synthetic handle so the parent-exit hook cannot signal it.
        Reflect.set(client, "owner", undefined);
        await client.dispose();
      }
    }
  }
);
