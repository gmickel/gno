/**
 * The tool mutex lease of the current MCP tool call.
 *
 * MCP tools run one at a time behind one process-wide mutex. A tool that has
 * to wait on an external service (the access hook) would otherwise keep every
 * other caller queued behind that wait. `yieldToolMutex` releases the mutex
 * for exactly the duration of such a wait and takes it back before the tool's
 * own code continues. Tool code (store reads and writes, model calls,
 * ranking) of different calls still never overlaps; only the waits do.
 *
 * @module src/mcp/tool-lease
 */

// AsyncLocalStorage carries the lease across awaits; Bun has no equivalent.
import { AsyncLocalStorage } from "node:async_hooks";

import type { AsyncMutex } from "./context";

type LeaseState = "held" | "yielded" | "reacquiring" | "ended";

interface ToolLease {
  mutex: AsyncMutex;
  state: LeaseState;
  /** Release of the held grant; set only in the `held` state. */
  release: (() => void) | null;
  /** Waits of this call in flight since the mutex was last released. */
  waits: number;
  /** Settles when the mutex is held again (or the call has ended). */
  reheld: Promise<void>;
  settleReheld: () => void;
}

const leases = new AsyncLocalStorage<ToolLease>();

/**
 * Run `operation` as the holder of `mutex`, whose grant the caller already
 * acquired (`release`). The grant is returned exactly once: when the
 * operation settles, or, if a wait still has it released then, by that wait
 * once it ends.
 */
export async function runWithToolLease<T>(
  mutex: AsyncMutex,
  release: () => void,
  operation: () => Promise<T>
): Promise<T> {
  const lease: ToolLease = {
    mutex,
    state: "held",
    release,
    waits: 0,
    reheld: Promise.resolve(),
    settleReheld: () => undefined,
  };
  try {
    return await leases.run(lease, operation);
  } finally {
    const held = lease.state === "held" ? lease.release : null;
    lease.state = "ended";
    lease.release = null;
    lease.settleReheld();
    held?.();
  }
}

const reacquire = async (lease: ToolLease): Promise<void> => {
  lease.state = "reacquiring";
  const release = await lease.mutex.acquire();
  // The state may have changed while the acquire was pending.
  if ((lease.state as LeaseState) === "ended") {
    // The call returned while this wait was pending: give the grant back.
    release();
  } else {
    lease.state = "held";
    lease.release = release;
  }
  lease.settleReheld();
};

/**
 * Await `wait` with the current call's tool mutex released, and resume only
 * once the mutex is held again. Outside a lease (stdio helpers, jobs, unit
 * callers) it simply awaits `wait`. Parallel waits of one call release the
 * mutex once; every one of them resumes after it is reacquired.
 *
 * `wait` must not touch shared tool state (store, models, config): other
 * tool calls run while it is pending. Errors from `wait` propagate unchanged
 * after the mutex is held again.
 */
export async function yieldToolMutex<T>(wait: () => Promise<T>): Promise<T> {
  const lease = leases.getStore();
  if (!lease || lease.state === "ended") return wait();
  if (lease.state === "held") {
    const release = lease.release;
    lease.state = "yielded";
    lease.release = null;
    lease.reheld = new Promise<void>((resolve) => {
      lease.settleReheld = resolve;
    });
    release?.();
  }
  lease.waits += 1;
  try {
    return await wait();
  } finally {
    lease.waits -= 1;
    if (lease.waits === 0 && lease.state === "yielded") {
      await reacquire(lease);
    }
    await lease.reheld;
  }
}
