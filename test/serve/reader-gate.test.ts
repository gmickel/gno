import { expect, test } from "bun:test";

import { ReaderGate } from "../../src/serve/resident-admission";

for (const limit of [1, 3]) {
  test(`handoff reserves capacity before fresh acquisition at limit ${limit}`, async () => {
    const gate = new ReaderGate(limit, 4);
    const holders = await Promise.all(
      Array.from({ length: limit }, () => gate.acquire())
    );
    const queued = gate.acquire();
    holders[0]!();
    const fresh = gate.acquire();
    expect(gate.active).toBe(limit);
    expect(gate.queued).toBe(1);
    const releaseQueued = await queued;
    expect(gate.active).toBe(limit);
    holders[0]!(); // Reentrant completion cannot release the new owner's slot.
    expect(gate.active).toBe(limit);
    releaseQueued();
    const releaseFresh = await fresh;
    expect(gate.active).toBe(limit);
    releaseFresh();
    for (const release of holders) release();
    expect(gate.active).toBe(0);
    expect(gate.queued).toBe(0);
  });
}

for (const timing of ["before", "at", "after"] as const) {
  test(`abort ${timing} handoff preserves the next live waiter's slot`, async () => {
    const gate = new ReaderGate(1, 3);
    const releaseFirst = await gate.acquire();
    const abort = new AbortController();
    const canceled = gate.acquire(abort.signal);
    // Observe rejection immediately; the schedule itself remains synchronous.
    const outcome = canceled.then(
      (release) => ({ release }),
      (error: unknown) => ({ error })
    );
    const live = gate.acquire();
    if (timing === "before") abort.abort();
    releaseFirst();
    if (timing === "at") abort.abort();
    const result = await outcome;
    if (timing === "after") {
      expect("release" in result).toBe(true);
      if (!("release" in result)) throw new Error("Expected granted slot");
      abort.abort();
      // Once acquire returns, the caller owns cleanup even if work is aborted.
      expect(gate.active).toBe(1);
      result.release();
      result.release();
    } else {
      expect(result).toEqual({ error: new Error("Resident request aborted") });
    }
    const releaseLive = await live;
    expect(gate.active).toBe(1);
    expect(gate.queued).toBe(0);
    releaseLive();
    releaseFirst();
    expect(gate.active).toBe(0);
  });
}

test("pre-abort and canceled final handoff leave empty gate reusable", async () => {
  const gate = new ReaderGate(1, 1);
  const abort = new AbortController();
  abort.abort();
  expect(
    await gate.acquire(abort.signal).catch((error: unknown) => error)
  ).toEqual(new Error("Resident request aborted"));
  expect(gate.active).toBe(0);
  const release = await gate.acquire();
  const queuedAbort = new AbortController();
  const queued = gate.acquire(queuedAbort.signal);
  release();
  queuedAbort.abort();
  expect(await queued.catch((error: unknown) => error)).toEqual(
    new Error("Resident request aborted")
  );
  expect(gate.active).toBe(0);
  expect(gate.queued).toBe(0);
  (await gate.acquire())();
  expect(gate.active).toBe(0);
});
