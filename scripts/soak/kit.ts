/**
 * Shared scenario plumbing: the run context and the bring-up / bring-down /
 * quiet-window steps every scenario repeats, each wired to its invariants.
 *
 * @module scripts/soak/kit
 */

import type { Corpus } from "./corpus";
import type { FakeLlm } from "./fake-llm";
import type { Resident, ResidentMode } from "./gno";
import type { Verdicts } from "./invariants";
import type { Monitor } from "./monitor";
import type { Rng } from "./rng";
import type { Sandbox } from "./sandbox";

import { THRESHOLDS } from "./config";
import { startResident, stopResident } from "./gno";
import {
  checkConvergence,
  checkIdle,
  checkOrphans,
  checkReleased,
  checkResponsiveness,
  checkShutdown,
} from "./invariants";
import { freePort } from "./sandbox";

export interface RunContext {
  sandbox: Sandbox;
  monitor: Monitor;
  verdicts: Verdicts;
  corpus: Corpus;
  llm: FakeLlm;
  rng: Rng;
  /** Extra notes for the report (findings the checks cannot express). */
  notes: string[];
  idleQuietMs: number;
}

export async function bringUp(
  ctx: RunContext,
  options: { mode?: ResidentMode; args?: string[]; label?: string } = {}
): Promise<Resident> {
  const resident = await startResident(ctx.sandbox, {
    mode: options.mode,
    port: freePort(),
    args: options.args,
    label: options.label,
  });
  ctx.monitor.resident = resident;
  ctx.monitor.event(
    "resident-up",
    `${resident.mode} pid ${resident.pid} port ${resident.port}`
  );
  return resident;
}

/**
 * Stop the resident with `signal` and check shutdown time (I5), leftover
 * processes (I2) and released locks/port (I3). Status probes during the
 * resident's lifetime are checked for I4.
 */
export async function bringDown(
  ctx: RunContext,
  resident: Resident,
  signal: NodeJS.Signals,
  label: string,
  options: { checkShutdownBudget?: boolean } = {}
): Promise<void> {
  checkResponsiveness(
    ctx.verdicts,
    ctx.monitor,
    resident.startedAt,
    Date.now()
  );
  ctx.monitor.resident = null;
  ctx.monitor.event("resident-stop", `${label}: ${signal}`);
  const result = await stopResident(
    resident,
    signal,
    signal === "SIGKILL" ? 5_000 : THRESHOLDS.shutdownMs + 3_000
  );
  if (signal !== "SIGKILL" && options.checkShutdownBudget !== false)
    checkShutdown(ctx.verdicts, label, result);
  await checkOrphans(ctx.verdicts, ctx.monitor, `${label} (after ${signal})`);
  await checkReleased(ctx.verdicts, ctx.sandbox, label, resident.port);
}

/** Wait for convergence, then measure a quiet window for I1. */
export async function settleAndMeasureIdle(
  ctx: RunContext,
  resident: Resident,
  label: string
): Promise<void> {
  await checkConvergence(
    ctx.verdicts,
    resident,
    ctx.sandbox,
    ctx.corpus,
    `${label}: convergence`
  );
  const from = Date.now();
  // Sample first so children that predate the window (owner-lock helper) are not counted as new.
  await ctx.monitor.sample();
  const childPidsBefore = ctx.monitor.residentChildPids.size;
  ctx.monitor.event("quiet-window", label);
  await Bun.sleep(ctx.idleQuietMs);
  await ctx.monitor.sample();
  await ctx.monitor.measureGrowth();
  await checkIdle(ctx.verdicts, ctx.monitor, {
    from,
    to: Date.now(),
    childPidsBefore,
  });
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms} ms`)),
          ms
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
