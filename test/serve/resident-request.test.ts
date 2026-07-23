import { describe, expect, test } from "bun:test";

import type { ResidentRuntime } from "../../src/serve/resident-runtime";

import {
  AdmissionController,
  ReaderGate,
} from "../../src/serve/resident-admission";
import { handleResidentRead } from "../../src/serve/resident-request";

function createRuntime(
  limit = 1,
  maxQueued = 1
): {
  admission: AdmissionController;
  leases: { acquired: number; released: number };
  runtime: ResidentRuntime;
} {
  const admission = new AdmissionController();
  const readerGate = new ReaderGate(limit, maxQueued);
  const leases = { acquired: 0, released: 0 };
  const runtime = {
    readerGate,
    admitRequest: (signal?: AbortSignal) => admission.admit(signal),
    withModelLease: async <T>(operation: () => Promise<T>) => {
      leases.acquired += 1;
      try {
        return await operation();
      } finally {
        leases.released += 1;
      }
    },
  } as unknown as ResidentRuntime;
  return { admission, leases, runtime };
}

describe("resident REST read boundary", () => {
  test("bounds active and queued readers and balances request model leases", async () => {
    const { admission, leases, runtime } = createRuntime();
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = handleResidentRead(runtime, undefined, async () => {
      await firstHeld;
      return new Response("first");
    });
    await Bun.sleep(0);
    const second = handleResidentRead(
      runtime,
      undefined,
      () => new Response("second")
    );
    await Bun.sleep(0);

    expect(runtime.readerGate.active).toBe(1);
    expect(runtime.readerGate.queued).toBe(1);
    expect(admission.active).toBe(2);
    expect(
      (await handleResidentRead(runtime, undefined, () => new Response()))
        .status
    ).toBe(429);

    releaseFirst();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(runtime.readerGate.active).toBe(0);
    expect(runtime.readerGate.queued).toBe(0);
    expect(admission.active).toBe(0);
    expect(leases).toEqual({ acquired: 2, released: 2 });
  });

  test("shutdown aborts queued REST reads before resource use", async () => {
    const { admission, runtime } = createRuntime();
    const waitForAbort = (signal: AbortSignal) =>
      new Promise<Response>((resolve) => {
        signal.addEventListener(
          "abort",
          () => resolve(new Response("aborted")),
          { once: true }
        );
      });
    const first = handleResidentRead(runtime, undefined, waitForAbort);
    await Bun.sleep(0);
    const queued = handleResidentRead(runtime, undefined, waitForAbort);
    await Bun.sleep(0);

    expect(await admission.closeAndDrain(0, 100)).toBe(true);
    expect((await first).status).toBe(503);
    expect((await queued).status).toBe(503);
    expect(admission.active).toBe(0);
    expect(runtime.readerGate.active).toBe(0);
    expect(runtime.readerGate.queued).toBe(0);
  });
});
