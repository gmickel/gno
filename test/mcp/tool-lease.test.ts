import { describe, expect, test } from "bun:test";

import { Mutex } from "../../src/mcp/context";
import { runWithToolLease, yieldToolMutex } from "../../src/mcp/tool-lease";

/** One MCP tool call: take the mutex, run `body` as the lease holder. */
const call = async <T>(mutex: Mutex, body: () => Promise<T>): Promise<T> =>
  runWithToolLease(mutex, await mutex.acquire(), body);

/** Counts tool code running at once; the mutex must keep it at one. */
const tracker = () => {
  let inside = 0;
  let max = 0;
  return {
    async code(ms: number) {
      inside += 1;
      max = Math.max(max, inside);
      await Bun.sleep(ms);
      inside -= 1;
    },
    get max() {
      return max;
    },
  };
};

describe("tool mutex lease", () => {
  test("outside a lease a wait simply runs", async () => {
    expect(await yieldToolMutex(async () => 7)).toBe(7);
  });

  test("waits overlap across calls; tool code never does", async () => {
    const mutex = new Mutex();
    const code = tracker();
    const started = performance.now();
    await Promise.all(
      Array.from({ length: 5 }, () =>
        call(mutex, async () => {
          await code.code(5);
          await yieldToolMutex(() => Bun.sleep(100));
          await code.code(5);
        })
      )
    );
    const elapsed = performance.now() - started;
    expect(code.max).toBe(1);
    // Serialized waits would take 5 x 100 ms.
    expect(elapsed).toBeLessThan(300);
  });

  test("parallel waits of one call resume only once the mutex is held again", async () => {
    const mutex = new Mutex();
    const code = tracker();
    let resumedAt = 0;
    const started = performance.now();
    const first = call(mutex, async () => {
      await Promise.all([
        yieldToolMutex(() => Bun.sleep(20)),
        yieldToolMutex(() => Bun.sleep(40)),
      ]);
      resumedAt = performance.now() - started;
      await code.code(1);
    });
    // Queued behind `first`; runs while it is yielded and holds 120 ms.
    const second = call(mutex, () => code.code(120));
    await Promise.all([first, second]);
    expect(code.max).toBe(1);
    expect(resumedAt).toBeGreaterThanOrEqual(115);
  });

  test("a failing wait rethrows after reacquiring, and the call still releases", async () => {
    const mutex = new Mutex();
    const failure = new Error("hook transport");
    let caught: unknown;
    try {
      await call(mutex, () => yieldToolMutex(() => Promise.reject(failure)));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(await call(mutex, async () => "next")).toBe("next");
  });

  test("a call that returns while a wait is still yielded leaves the mutex free", async () => {
    const mutex = new Mutex();
    let late: Promise<void> | undefined;
    await call(mutex, async () => {
      late = yieldToolMutex(() => Bun.sleep(30));
    });
    // Free immediately (the abandoned wait gave the grant back already) ...
    expect(await call(mutex, async () => "during")).toBe("during");
    await late;
    // ... and still free after the abandoned wait finished.
    expect(await call(mutex, async () => "after")).toBe("after");
  });
});
