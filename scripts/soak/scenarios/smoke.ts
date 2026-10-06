/**
 * Smoke tier (fn-203 R6): one lifecycle cycle with every invariant touched,
 * sized to finish in under 10 minutes on a Linux CI runner.
 *
 * @module scripts/soak/scenarios/smoke
 */

import type { RunContext } from "../kit";

import { cliWriters, fsChurn, mcpChurn, restReaders } from "../actors";
import { residentPaths } from "../gno";
import {
  checkConvergence,
  checkIntegrity,
  checkOrphans,
  checkReleased,
  checkRetries,
  checkShutdown,
  checkZombies,
} from "../invariants";
import { bringDown, bringUp, settleAndMeasureIdle } from "../kit";
import { isAlive } from "../procfs";
import { freePort, runGno } from "../sandbox";

export async function runSmoke(
  ctx: RunContext,
  churnMs: number
): Promise<void> {
  const { verdicts, monitor, corpus, rng } = ctx;
  const startedAt = Date.now();

  verdicts.scenario = "smoke/steady";
  let resident = await bringUp(ctx, { label: "smoke-serve" });
  await settleAndMeasureIdle(ctx, resident, "initial");

  verdicts.scenario = "smoke/churn";
  monitor.event("phase", `churn ${churnMs} ms`);
  const actors = [
    fsChurn(corpus, rng.fork("churn"), monitor, {
      meanDelayMs: 150,
      burstChance: 0.01,
      burstSize: 100,
    }),
    restReaders(resident, rng.fork("readers"), 5),
    mcpChurn(ctx.sandbox, rng.fork("mcp"), {
      longLived: 2,
      meanDelayMs: 2_000,
      killChance: 0.2,
    }),
    cliWriters(ctx.sandbox, rng.fork("cli"), 20_000),
  ];
  const churnEnd = Date.now() + churnMs;
  while (Date.now() < churnEnd) {
    await Bun.sleep(5_000);
    await checkZombies(verdicts, monitor, "during churn");
  }
  for (const actor of actors) {
    await actor.stop();
    monitor.event(
      "actor-stats",
      `${actor.name} ${JSON.stringify(actor.stats())}`
    );
  }
  await settleAndMeasureIdle(ctx, resident, "after churn");
  checkRetries(verdicts, ctx.sandbox, "smoke", startedAt);
  await bringDown(ctx, resident, "SIGTERM", "smoke serve");

  verdicts.scenario = "smoke/kill";
  resident = await bringUp(ctx, { label: "smoke-kill" });
  for (let i = 0; i < 150; i += 1) await corpus.writeNote(corpus.newNoteName());
  await Bun.sleep(rng.int(300, 1_500));
  await bringDown(ctx, resident, "SIGKILL", "smoke serve mid-burst");
  await checkIntegrity(verdicts, ctx.sandbox, "after SIGKILL");
  resident = await bringUp(ctx, { label: "smoke-recover" });
  await checkConvergence(
    verdicts,
    resident,
    ctx.sandbox,
    corpus,
    "restart after SIGKILL",
    "I9"
  );
  await bringDown(ctx, resident, "SIGTERM", "smoke recovered serve");

  verdicts.scenario = "smoke/detach";
  const port = freePort();
  const start = await runGno(
    ctx.sandbox,
    ["daemon", "--detach", "--port", String(port), "--no-sync-on-start"],
    {
      timeoutMs: 60_000,
    }
  );
  const pidFile = residentPaths(ctx.sandbox).daemonPid;
  const pid = Number.parseInt(
    (
      await Bun.file(pidFile)
        .text()
        .catch(() => "")
    ).trim(),
    10
  );
  monitor.event("detach", `daemon --detach exit ${start.code} pid ${pid}`);
  const status = await runGno(ctx.sandbox, ["daemon", "--status", "--json"], {
    timeoutMs: 30_000,
  });
  monitor.event("detach", `daemon --status exit ${status.code}`);
  const stopStarted = performance.now();
  const stop = await runGno(ctx.sandbox, ["daemon", "--stop"], {
    timeoutMs: 30_000,
  });
  const stopMs = performance.now() - stopStarted;
  checkShutdown(verdicts, "daemon --stop", {
    signal: "SIGTERM",
    exitMs:
      stop.code === 0 && !(Number.isFinite(pid) && isAlive(pid))
        ? stopMs
        : null,
    exitCode: stop.code,
    escalated: stop.code !== 0 || (Number.isFinite(pid) && isAlive(pid)),
  });
  await checkOrphans(verdicts, monitor, "after daemon --stop");
  await checkReleased(verdicts, ctx.sandbox, "after daemon --stop", port, {
    pidFile,
  });
}
