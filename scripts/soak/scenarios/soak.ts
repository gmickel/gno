/**
 * Soak tier: seeded phases of mixed load and faults for the requested
 * duration, with convergence after each phase, periodic idle windows, and
 * whole-run growth and retry checks (I6, I7) at the end.
 *
 * @module scripts/soak/scenarios/soak
 */

import type { Actor } from "../actors";
import type { Resident } from "../gno";
import type { RunContext } from "../kit";

import { cliWriters, fsChurn, mcpChurn, restReaders, sseHerd } from "../actors";
import { residentPaths } from "../gno";
import {
  checkBoundedResources,
  checkConvergence,
  checkIntegrity,
  checkRetries,
  checkZombies,
} from "../invariants";
import { bringDown, bringUp, settleAndMeasureIdle } from "../kit";
import { holdLock } from "../sandbox";

type Fault =
  | "none"
  | "sigstop"
  | "lease-hold"
  | "embed-errors"
  | "embed-latency"
  | "burst"
  | "sse"
  | "restart"
  | "kill";

const FAULTS: Fault[] = [
  "none",
  "none",
  "sigstop",
  "lease-hold",
  "embed-errors",
  "embed-latency",
  "burst",
  "sse",
  "restart",
  "kill",
];

export async function runSoak(
  ctx: RunContext,
  durationMs: number
): Promise<void> {
  const { verdicts, monitor, rng } = ctx;
  const startedAt = Date.now();
  const end = startedAt + durationMs;
  let resident: Resident = await bringUp(ctx, { label: "soak" });
  verdicts.scenario = "soak/start";
  await settleAndMeasureIdle(ctx, resident, "soak start");
  let lastIdle = Date.now();
  let phase = 0;

  while (Date.now() < end) {
    phase += 1;
    const phaseRng = rng.fork(`phase-${phase}`);
    const phaseMs = Math.min(
      phaseRng.int(2, 6) * 60_000,
      Math.max(30_000, end - Date.now())
    );
    const fault = phaseRng.pick(FAULTS);
    verdicts.scenario = `soak/phase-${phase}/${fault}`;
    monitor.event(
      "phase",
      `${phase}: ${Math.round(phaseMs / 1000)} s, fault ${fault}`
    );

    const actors: Actor[] = [
      fsChurn(ctx.corpus, phaseRng.fork("churn"), monitor, {
        meanDelayMs: phaseRng.int(100, 2_000),
        burstChance: 0.005,
      }),
    ];
    if (phaseRng.chance(0.7))
      actors.push(
        restReaders(resident, phaseRng.fork("readers"), phaseRng.int(1, 10))
      );
    if (phaseRng.chance(0.6))
      actors.push(
        mcpChurn(ctx.sandbox, phaseRng.fork("mcp"), {
          longLived: phaseRng.int(0, 3),
          meanDelayMs: 3_000,
          killChance: 0.1,
        })
      );
    if (phaseRng.chance(0.4))
      actors.push(cliWriters(ctx.sandbox, phaseRng.fork("cli"), 60_000));

    const faultAt =
      Date.now() + phaseRng.int(10_000, Math.max(10_000, phaseMs / 2));
    let releaseFault: (() => Promise<void>) | null = null;
    let sse: Awaited<ReturnType<typeof sseHerd>> | null = null;
    while (Date.now() < faultAt) await Bun.sleep(1_000);
    switch (fault) {
      case "sigstop": {
        monitor.resident = null;
        process.kill(resident.pid, "SIGSTOP");
        monitor.event("fault", "SIGSTOP");
        const pid = resident.pid;
        const target = resident;
        releaseFault = async () => {
          process.kill(pid, "SIGCONT");
          monitor.resident = target;
          monitor.event("fault-cleared", "SIGCONT");
        };
        await Bun.sleep(phaseRng.int(30, 120) * 1_000);
        break;
      }
      case "lease-hold": {
        const lock = holdLock(
          ctx.sandbox,
          residentPaths(ctx.sandbox).writeLock
        );
        monitor.event("fault", "lease held");
        releaseFault = async () => {
          await lock.release();
          monitor.event("fault-cleared", "lease released");
        };
        break;
      }
      case "embed-errors":
      case "embed-latency": {
        await ctx.llm.setFaults(
          fault === "embed-errors" ? { errorRate: 0.7 } : { latencyMs: 3_000 }
        );
        monitor.event("fault", fault);
        releaseFault = async () => {
          await ctx.llm.setFaults({ errorRate: 0, latencyMs: 0 });
          monitor.event("fault-cleared", fault);
        };
        break;
      }
      case "burst": {
        for (let i = 0; i < 1_000; i += 1)
          await ctx.corpus.writeNote(ctx.corpus.newNoteName());
        monitor.event("fault", "burst 1000 notes");
        break;
      }
      case "sse": {
        sse = await sseHerd(resident, phaseRng.int(20, 150));
        sse.abandon(Math.floor(sse.open / 2));
        monitor.event("fault", `sse herd ${sse.open}`);
        break;
      }
      case "restart":
      case "kill":
        break;
      default:
        break;
    }
    while (Date.now() < faultAt + phaseMs / 2 && Date.now() < end + 60_000) {
      await Bun.sleep(5_000);
      if (monitor.resident)
        await checkZombies(verdicts, monitor, `phase ${phase}`);
    }
    if (releaseFault) await releaseFault();
    for (const actor of actors) {
      await actor.stop();
      monitor.event(
        "actor-stats",
        `${actor.name} ${JSON.stringify(actor.stats())}`
      );
    }
    await sse?.close();

    if (fault === "restart" || fault === "kill") {
      const signal =
        fault === "kill"
          ? "SIGKILL"
          : phaseRng.pick(["SIGTERM", "SIGINT", "SIGHUP"] as NodeJS.Signals[]);
      await bringDown(ctx, resident, signal, `soak phase ${phase}`);
      if (signal === "SIGKILL")
        await checkIntegrity(verdicts, ctx.sandbox, `soak phase ${phase}`);
      resident = await bringUp(ctx, { label: `soak-phase-${phase}` });
    }
    await checkConvergence(
      verdicts,
      resident,
      ctx.sandbox,
      ctx.corpus,
      `phase ${phase} (${fault})`,
      fault === "kill" ? "I9" : "I8"
    );
    if (Date.now() - lastIdle > 30 * 60_000) {
      await settleAndMeasureIdle(ctx, resident, `soak phase ${phase}`);
      lastIdle = Date.now();
    }
  }

  verdicts.scenario = "soak/end";
  await settleAndMeasureIdle(ctx, resident, "soak end");
  checkBoundedResources(verdicts, monitor, startedAt, Date.now());
  checkRetries(verdicts, ctx.sandbox, "whole soak", startedAt);
  await bringDown(ctx, resident, "SIGTERM", "soak end");
}
