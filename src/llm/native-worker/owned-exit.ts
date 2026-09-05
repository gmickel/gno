import type { Owner } from "./owner";

import { settlesBy, SHUTDOWN_EXIT_MS } from "../../core/shutdown-budget";

export interface NativeDisposeOptions {
  /** Absolute monotonic deadline; internal shutdown control, never caller config. */
  deadline?: number;
  force?: boolean;
}

export interface OwnedExitControl {
  deadline: number;
  force: boolean;
  changed: AbortController;
}

type OwnedChild = Pick<
  ReturnType<typeof Bun.spawn>,
  "pid" | "kill" | "send" | "exited"
>;

async function waitForExit(
  child: OwnedChild,
  control: OwnedExitControl,
  phaseEnd: number,
  graceful: boolean
): Promise<boolean> {
  while (true) {
    const deadline = Math.min(
      phaseEnd,
      control.deadline - (graceful ? SHUTDOWN_EXIT_MS : 0)
    );
    if (graceful && control.force) return false;
    if (await settlesBy(child.exited, deadline, control.changed.signal))
      return true;
    if (performance.now() >= deadline) return false;
  }
}

async function exitOwnedChild(
  child: OwnedChild,
  control: OwnedExitControl
): Promise<void> {
  try {
    if (!control.force) {
      try {
        child.send("shutdown");
        if (
          await waitForExit(
            child,
            control,
            performance.now() + SHUTDOWN_EXIT_MS,
            true
          )
        )
          return;
      } catch {
        // Closed IPC still requires reaping this owned process.
      }
    }
    child.kill("SIGKILL");
    if (
      await waitForExit(
        child,
        control,
        performance.now() + SHUTDOWN_EXIT_MS,
        false
      )
    )
      return;
  } catch (cause) {
    throw new Error(`Owned native child ${child.pid} termination failed`, {
      cause,
    });
  }
  throw new Error(
    `Owned native child ${child.pid} did not exit before shutdown deadline`
  );
}

/** One retirement loop/timer, tightened in place by the resident shutdown owner. */
export function retireOwnedChild(
  owner: Owner,
  options: NativeDisposeOptions = {}
): Promise<void> {
  if (owner.retirement) {
    const control = owner.retirementControl!;
    control.deadline = Math.min(control.deadline, options.deadline ?? Infinity);
    control.force ||= options.force ?? false;
    const previous = control.changed;
    control.changed = new AbortController();
    previous.abort();
    return owner.retirement;
  }
  owner.retiring = true;
  for (const resolve of owner.drain) resolve();
  owner.drain.clear();
  clearTimeout(owner.timer);
  owner.decoder.reset();
  const control: OwnedExitControl = {
    deadline: options.deadline ?? performance.now() + 2 * SHUTDOWN_EXIT_MS,
    force: options.force ?? false,
    changed: new AbortController(),
  };
  owner.retirementControl = control;
  owner.retirement = exitOwnedChild(owner.child, control);
  return owner.retirement;
}
