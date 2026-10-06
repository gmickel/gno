/**
 * Torture tier (fn-203 R5): each fault class in isolation, with its own
 * observations. Every gap named in the fn-203 problem statement is reached by
 * at least one class here, so a run either proves it harmless or files it.
 *
 * @module scripts/soak/scenarios/torture
 */

// node:fs/promises — chmod/mkdir/rm have no Bun equivalent
import { chmod, mkdir, rm } from "node:fs/promises";
// node:path — Bun has no path utilities
import { join } from "node:path";

import type { RunContext } from "../kit";

import {
  fsChurn,
  mcpChurn,
  openMcp,
  orphanedMcpParent,
  restReaders,
  sseHerd,
} from "../actors";
import { buildConfig, writeConfig } from "../corpus";
import { fakePreset } from "../fake-llm";
import {
  getJson,
  postJson,
  residentPaths,
  startResident,
  stopResident,
} from "../gno";
import {
  checkConvergence,
  checkIdle,
  checkIntegrity,
  checkOrphans,
  checkReleased,
  checkResponsiveness,
  checkRetries,
} from "../invariants";
import { bringDown, bringUp, withTimeout } from "../kit";
import { isAlive, listProcesses } from "../procfs";
import { freePort, gnoCmd, holdLock, runGno, spawnTagged } from "../sandbox";

export type TortureClass =
  | "failing-collection"
  | "lease-held"
  | "signals"
  | "embed-faults"
  | "sleep-wake"
  | "desktop-shell-kill"
  | "update-cmd"
  | "session-import-kill"
  | "sse-flood"
  | "mcp-lifecycle"
  | "stale-locks"
  | "config-edit"
  | "macos-ps-sampler";

export const TORTURE_CLASSES: TortureClass[] = [
  "failing-collection",
  "lease-held",
  "signals",
  "embed-faults",
  "sleep-wake",
  "desktop-shell-kill",
  "update-cmd",
  "session-import-kill",
  "sse-flood",
  "mcp-lifecycle",
  "stale-locks",
  "config-edit",
  "macos-ps-sampler",
];

type Runner = (ctx: RunContext) => Promise<void>;

/** Measure a window of `ms` for CPU/children without requiring convergence first. */
async function measureWindow(ctx: RunContext, ms: number): Promise<void> {
  const from = Date.now();
  await ctx.monitor.sample();
  const childPidsBefore = ctx.monitor.residentChildPids.size;
  await Bun.sleep(ms);
  await ctx.monitor.sample();
  await ctx.monitor.measureGrowth();
  await checkIdle(ctx.verdicts, ctx.monitor, {
    from,
    to: Date.now(),
    childPidsBefore,
  });
}

const failingCollection: Runner = async (ctx) => {
  const resident = await bringUp(ctx, { label: "failing-collection" });
  await checkConvergence(
    ctx.verdicts,
    resident,
    ctx.sandbox,
    ctx.corpus,
    "before faults"
  );
  const since = Date.now();
  // A note that can never be read, and a change in the unverifiable collection.
  const unreadable = join(ctx.corpus.layout.notes, "d0", "locked.md");
  await Bun.write(unreadable, "# locked\n");
  await chmod(unreadable, 0o000);
  await Bun.write(
    join(ctx.corpus.layout.cloudish, "c0.md"),
    `# touched ${Date.now()}\n`
  );
  ctx.monitor.event(
    "fault",
    "unreadable note + unverifiable collection touched"
  );
  // Let the backoff grow, then demand an idle resident despite the failing work.
  await Bun.sleep(150_000);
  await measureWindow(ctx, ctx.idleQuietMs);
  checkRetries(ctx.verdicts, ctx.sandbox, "failing-collection", since);
  await chmod(unreadable, 0o644);
  await Bun.write(unreadable, "# unlocked\n");
  ctx.corpus.live.set("d0/locked.md", "unlocked");
  await checkConvergence(
    ctx.verdicts,
    resident,
    ctx.sandbox,
    ctx.corpus,
    "after repair"
  );
  await bringDown(ctx, resident, "SIGTERM", "failing-collection");
};

const leaseHeld: Runner = async (ctx) => {
  const resident = await bringUp(ctx, { label: "lease-held" });
  await checkConvergence(
    ctx.verdicts,
    resident,
    ctx.sandbox,
    ctx.corpus,
    "before lease hold"
  );
  const lock = holdLock(ctx.sandbox, residentPaths(ctx.sandbox).writeLock);
  ctx.monitor.event("fault", "write lease held by another process");
  const churn = fsChurn(ctx.corpus, ctx.rng.fork("lease-churn"), ctx.monitor, {
    meanDelayMs: 1_000,
  });
  await ctx.monitor.sample();
  const childrenBefore = ctx.monitor.residentChildPids.size;
  const from = Date.now();
  await Bun.sleep(180_000);
  await churn.stop();
  const minutes = (Date.now() - from) / 60_000;
  const attempts = ctx.monitor.residentChildPids.size - childrenBefore;
  const embed = await getJson<{
    nextRunAt?: number;
    lastResult?: { deferred?: boolean };
  }>(resident, "/api/embed/status");
  ctx.verdicts.observe(
    "I7",
    attempts / minutes <= 30,
    `lease held ${minutes.toFixed(1)} min: ${attempts} lease-probe child processes (${(attempts / minutes).toFixed(1)}/min), embed deferred=${embed?.lastResult?.deferred} nextRunAt=${embed?.nextRunAt ?? "none"}`
  );
  await measureWindow(ctx, 60_000);
  await lock.release();
  ctx.monitor.event("fault-cleared", "write lease released");
  await checkConvergence(
    ctx.verdicts,
    resident,
    ctx.sandbox,
    ctx.corpus,
    "after lease release"
  );
  await bringDown(ctx, resident, "SIGTERM", "lease-held");
};

const signals: Runner = async (ctx) => {
  const states = ["idle", "mid-burst", "mid-embed"] as const;
  const signalsToTry: NodeJS.Signals[] = [
    "SIGTERM",
    "SIGINT",
    "SIGHUP",
    "SIGKILL",
  ];
  for (const signal of signalsToTry) {
    for (const state of states) {
      const label = `${signal} while ${state}`;
      ctx.verdicts.scenario = `torture/signals/${signal}/${state}`;
      const resident = await bringUp(ctx, { label: `sig-${signal}-${state}` });
      if (state === "mid-burst") {
        for (let i = 0; i < 300; i += 1)
          await ctx.corpus.writeNote(ctx.corpus.newNoteName());
        await Bun.sleep(400);
      } else if (state === "mid-embed") {
        await ctx.llm.setFaults({ latencyMs: 2_000 });
        for (let i = 0; i < 50; i += 1)
          await ctx.corpus.writeNote(ctx.corpus.newNoteName());
        await postJson(resident, "/api/embed", {}, 1_000);
        await Bun.sleep(1_500);
      } else {
        await Bun.sleep(1_000);
      }
      await bringDown(ctx, resident, signal, label);
      await ctx.llm.setFaults({ latencyMs: 0 });
      if (signal === "SIGKILL")
        await checkIntegrity(ctx.verdicts, ctx.sandbox, label);
      const recovered = await bringUp(ctx, {
        label: `sig-recover-${signal}-${state}`,
      });
      await checkConvergence(
        ctx.verdicts,
        recovered,
        ctx.sandbox,
        ctx.corpus,
        `restart after ${label}`,
        signal === "SIGKILL" ? "I9" : "I8"
      );
      await bringDown(ctx, recovered, "SIGTERM", `recovered after ${label}`);
      await resetBaseline(ctx, label);
    }
  }
};

const embedFaults: Runner = async (ctx) => {
  const resident = await bringUp(ctx, { label: "embed-faults" });
  await checkConvergence(
    ctx.verdicts,
    resident,
    ctx.sandbox,
    ctx.corpus,
    "before embed faults"
  );
  for (const [name, faults] of [
    ["500s", { errorRate: 1 }],
    ["malformed", { malformedRate: 1 }],
    ["hang", { hang: true }],
    ["down", { down: true }],
  ] as const) {
    ctx.monitor.event("fault", `embedder ${name}`);
    await ctx.llm.setFaults(faults);
    const churn = fsChurn(
      ctx.corpus,
      ctx.rng.fork(`embed-${name}`),
      ctx.monitor,
      { meanDelayMs: 3_000 }
    );
    await Bun.sleep(90_000);
    await churn.stop();
    const embed = await getJson<Record<string, unknown>>(
      resident,
      "/api/embed/status"
    );
    ctx.monitor.event("embed-status", `${name}: ${JSON.stringify(embed)}`);
    await measureWindow(ctx, 30_000);
    await ctx.llm.setFaults({
      errorRate: 0,
      malformedRate: 0,
      hang: false,
      down: false,
    });
    ctx.monitor.event("fault-cleared", `embedder ${name}`);
    // Parked passes only resume on fresh work.
    await ctx.corpus.writeNote(ctx.corpus.newNoteName());
    await checkConvergence(
      ctx.verdicts,
      resident,
      ctx.sandbox,
      ctx.corpus,
      `after embedder ${name}`
    );
  }
  await bringDown(ctx, resident, "SIGTERM", "embed-faults");
};

const sleepWake: Runner = async (ctx) => {
  const resident = await bringUp(ctx, { label: "sleep-wake" });
  const churn = fsChurn(ctx.corpus, ctx.rng.fork("sleep-churn"), ctx.monitor, {
    meanDelayMs: 500,
  });
  await Bun.sleep(10_000);
  ctx.monitor.resident = null;
  process.kill(resident.pid, "SIGSTOP");
  ctx.monitor.event("fault", "resident SIGSTOP (laptop sleep)");
  await Bun.sleep(90_000);
  process.kill(resident.pid, "SIGCONT");
  ctx.monitor.event("fault-cleared", "resident SIGCONT (wake)");
  ctx.monitor.resident = resident;
  const wokeAt = Date.now();
  await Bun.sleep(30_000);
  await churn.stop();
  checkResponsiveness(ctx.verdicts, ctx.monitor, wokeAt, Date.now());
  await checkConvergence(
    ctx.verdicts,
    resident,
    ctx.sandbox,
    ctx.corpus,
    "after wake"
  );
  await bringDown(ctx, resident, "SIGTERM", "sleep-wake", {
    checkShutdownBudget: true,
  });
};

const desktopShellKill: Runner = async (ctx) => {
  // Same spawn shape as desktop/electrobun-shell: plain (non-detached) child.
  const port = freePort();
  const script = `const p = Bun.spawn({ cmd: ${JSON.stringify(gnoCmd("serve", "--host", "127.0.0.1", "--port", String(port)))}, stdout: "ignore", stderr: "ignore" }); await Bun.sleep(600000);`;
  const shell = spawnTagged(ctx.sandbox, [process.execPath, "-e", script]);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const ok = await fetch(`http://127.0.0.1:${port}/api/resident/status`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) break;
    await Bun.sleep(500);
  }
  shell.kill("SIGKILL");
  await shell.exited;
  ctx.monitor.event(
    "fault",
    "desktop shell stand-in SIGKILLed with serve running"
  );
  const left = await checkOrphans(
    ctx.verdicts,
    ctx.monitor,
    "desktop shell killed"
  );
  for (const info of left) {
    try {
      process.kill(info.pid, "SIGTERM");
    } catch {
      // gone
    }
  }
  await Bun.sleep(12_000);
  await checkReleased(
    ctx.verdicts,
    ctx.sandbox,
    "after orphaned serve cleanup",
    port
  );
};

const updateCmd: Runner = async (ctx) => {
  const scripted = join(ctx.sandbox.root, "scripted");
  await mkdir(scripted, { recursive: true });
  await Bun.write(join(scripted, "s.md"), "# scripted\n");
  const config = buildConfig(ctx.corpus.layout, {
    modelBlock: fakePreset(ctx.llm.baseUrl),
    extraCollections: [
      {
        name: "scripted",
        path: scripted,
        pattern: "**/*",
        include: [],
        exclude: [],
        // updateCmd counts as remote egress; the collection must opt in.
        egressPolicy: "remote",
        updateCmd: "sleep 600",
      },
    ],
  });
  await writeConfig(ctx.sandbox.configDir, config);
  for (const signal of ["SIGKILL", "SIGTERM"] as NodeJS.Signals[]) {
    const update = spawnTagged(
      ctx.sandbox,
      gnoCmd("index", "scripted", "--no-embed")
    );
    let started = false;
    for (let i = 0; i < 40 && !started; i += 1) {
      await Bun.sleep(500);
      started = (await ctx.monitor.taggedProcesses()).some((info) =>
        /\bsleep 600\b/.test(info.command)
      );
    }
    ctx.monitor.event(
      "update-cmd",
      `updateCmd running before ${signal}: ${started}`
    );
    if (!started)
      ctx.notes.push(
        `update-cmd (${signal}): updateCmd never started; the orphan check below is not meaningful`
      );
    update.kill(signal);
    await update.exited;
    ctx.monitor.event(
      "fault",
      `gno index with hanging updateCmd killed with ${signal}`
    );
    const left = await checkOrphans(
      ctx.verdicts,
      ctx.monitor,
      `update killed (${signal}) during updateCmd`
    );
    for (const info of left) {
      try {
        process.kill(info.pid, "SIGKILL");
      } catch {
        // gone
      }
    }
  }
  await writeConfig(
    ctx.sandbox.configDir,
    buildConfig(ctx.corpus.layout, { modelBlock: fakePreset(ctx.llm.baseUrl) })
  );
};

const sessionImportKill: Runner = async (ctx) => {
  const { initSessionArchive, addSessionSource } =
    await import("../../../src/sessions/setup");
  const { writeSyntheticCodexRollouts } =
    await import("../../../test/sessions/helpers");
  const root = join(ctx.sandbox.root, "sessions");
  const sourceRoot = join(root, "sources", "codex");
  await mkdir(sourceRoot, { recursive: true });
  await writeSyntheticCodexRollouts(sourceRoot, 120, 200);
  const configPath = join(root, "archive.yml");
  const previous = {
    config: process.env.GNO_CONFIG_DIR,
    data: process.env.GNO_DATA_DIR,
    cache: process.env.GNO_CACHE_DIR,
  };
  Object.assign(process.env, {
    GNO_CONFIG_DIR: ctx.sandbox.configDir,
    GNO_DATA_DIR: ctx.sandbox.dataDir,
    GNO_CACHE_DIR: ctx.sandbox.cacheDir,
  });
  try {
    await initSessionArchive({
      configPath,
      indexName: "sessions",
      archiveRoot: join(root, "archive"),
      collection: "sessions",
    });
    await addSessionSource({
      configPath,
      id: "codex-soak",
      harness: "codex",
      path: sourceRoot,
      collection: "sessions",
    });
  } finally {
    // Assigning undefined to process.env stores the string "undefined".
    for (const [key, value] of [
      ["GNO_CONFIG_DIR", previous.config],
      ["GNO_DATA_DIR", previous.data],
      ["GNO_CACHE_DIR", previous.cache],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const resident = await startResident(ctx.sandbox, {
    port: freePort(),
    args: ["--config", configPath, "--index", "sessions"],
    label: "sessions-serve",
  });
  ctx.monitor.resident = resident;
  void postJson(
    resident,
    "/api/sessions/import",
    { sourceId: "codex-soak" },
    600_000
  );
  await Bun.sleep(3_000);
  const children = (await listProcesses()).filter(
    (info) => info.ppid === resident.pid
  );
  ctx.monitor.event(
    "fault",
    `SIGKILL serve during session import (children: ${children.map((c) => c.pid).join(",") || "none"})`
  );
  ctx.monitor.resident = null;
  await stopResident(resident, "SIGKILL", 5_000);
  const left = await checkOrphans(
    ctx.verdicts,
    ctx.monitor,
    "serve SIGKILLed during session import"
  );
  for (const info of left) {
    try {
      process.kill(info.pid, "SIGKILL");
    } catch {
      // gone
    }
  }
};

const sseFlood: Runner = async (ctx) => {
  const resident = await bringUp(ctx, { label: "sse-flood" });
  await Bun.sleep(5_000);
  const before = await ctx.monitor.sample();
  const herd = await sseHerd(resident, 300);
  herd.abandon(150);
  const churn = fsChurn(ctx.corpus, ctx.rng.fork("sse-churn"), ctx.monitor, {
    meanDelayMs: 200,
  });
  await Bun.sleep(60_000);
  await churn.stop();
  const during = await ctx.monitor.sample();
  await herd.close();
  await Bun.sleep(15_000);
  const after = await ctx.monitor.sample();
  const fdsBack = (after?.residentFds ?? 0) - (before?.residentFds ?? 0);
  ctx.verdicts.observe(
    "I6",
    herd.open > 0 && fdsBack <= 25,
    `sse flood: ${herd.open}/300 subscribers opened (150 abandoned); resident fds ${before?.residentFds} -> ${during?.residentFds} -> ${after?.residentFds} after close; rss ${(((during?.residentRssKb ?? 0) - (before?.residentRssKb ?? 0)) / 1024).toFixed(1)} MB during`
  );
  checkResponsiveness(
    ctx.verdicts,
    ctx.monitor,
    resident.startedAt,
    Date.now()
  );
  await bringDown(ctx, resident, "SIGTERM", "sse-flood");
};

const mcpLifecycle: Runner = async (ctx) => {
  const churn = mcpChurn(ctx.sandbox, ctx.rng.fork("mcp-life"), {
    longLived: 3,
    meanDelayMs: 500,
    killChance: 0.3,
  });
  await Bun.sleep(60_000);
  await churn.stop();
  ctx.monitor.event(
    "actor-stats",
    `mcp-churn ${JSON.stringify(churn.stats())}`
  );
  await checkOrphans(ctx.verdicts, ctx.monitor, "after mcp churn");
  await orphanedMcpParent(ctx.sandbox);
  ctx.monitor.event("fault", "mcp parent SIGKILLed without closing stdin");
  await checkOrphans(ctx.verdicts, ctx.monitor, "mcp parent killed");
  // A long-lived idle MCP server (the agent-session shape) should cost ~nothing.
  const idle = await openMcp(ctx.sandbox);
  await idle.call("gno_search", { query: "alpha", limit: 2 });
  const from = Date.now();
  const first = await ctx.monitor.sample();
  await Bun.sleep(60_000);
  const last = await ctx.monitor.sample();
  const cpu =
    (((last?.cpuTotal ?? 0) - (first?.cpuTotal ?? 0)) /
      ((Date.now() - from) / 1000)) *
    100;
  ctx.verdicts.observe(
    "I1",
    cpu <= 0.5,
    `idle stdio MCP server: ${cpu.toFixed(2)}% CPU over 60 s`
  );
  await idle.close();
  await checkOrphans(ctx.verdicts, ctx.monitor, "idle mcp closed");
};

const staleLocks: Runner = async (ctx) => {
  const paths = residentPaths(ctx.sandbox);
  // Stale detach pid file naming a dead pid.
  await Bun.write(
    paths.servePid,
    JSON.stringify({
      pid: 999_999,
      cmd: "serve",
      version: "0.0.0",
      started_at: new Date(Date.now() - 3_600_000).toISOString(),
      port: 1,
    })
  );
  const port = freePort();
  const start = await runGno(
    ctx.sandbox,
    ["serve", "--detach", "--port", String(port)],
    { timeoutMs: 60_000 }
  );
  ctx.verdicts.observe(
    "I3",
    start.code === 0,
    `serve --detach over a stale pid file: exit ${start.code} ${start.stderr.trim().slice(0, 200)}`
  );
  const stop = await runGno(ctx.sandbox, ["serve", "--stop"], {
    timeoutMs: 30_000,
  });
  ctx.monitor.event("detach", `serve --stop exit ${stop.code}`);
  await checkReleased(ctx.verdicts, ctx.sandbox, "after serve --stop", port, {
    pidFile: paths.servePid,
  });
  // Stale holder sidecar for the write lease from a dead process.
  await Bun.write(
    `${paths.writeLock}.holder.json`,
    JSON.stringify({
      pid: 999_999,
      command: "gno update",
      startedAtIso: new Date(0).toISOString(),
    })
  );
  const update = await runGno(ctx.sandbox, ["update", "--lock-wait", "10s"], {
    timeoutMs: 120_000,
  });
  ctx.verdicts.observe(
    "I3",
    update.code === 0,
    `gno update with a stale write-lease holder sidecar: exit ${update.code}`
  );
  // Stale per-directory tags lock left by a crashed `gno tags` write.
  const docDir = join(ctx.corpus.layout.notes, "d1");
  await Bun.write(join(docDir, ".mcp-write.lock"), "999999\n");
  const target = [...ctx.corpus.live.keys()].find((rel) =>
    rel.startsWith("d1/")
  );
  if (target) {
    const tags = await runGno(
      ctx.sandbox,
      ["tags", "add", `gno://notes/${target}`, "soak-tag"],
      { timeoutMs: 60_000 }
    );
    ctx.verdicts.observe(
      "I3",
      tags.code === 0,
      `gno tags add with a stale lock from a dead pid: exit ${tags.code} ${tags.stderr.trim().slice(0, 160)}`
    );
  } else {
    ctx.verdicts.skip("I3", "no note under d1 for the tags lock check");
  }
  await rm(join(docDir, ".mcp-write.lock"), { force: true });
};

const configEdit: Runner = async (ctx) => {
  const resident = await bringUp(ctx, { label: "config-edit" });
  const churn = fsChurn(ctx.corpus, ctx.rng.fork("config-churn"), ctx.monitor, {
    meanDelayMs: 300,
  });
  const readers = restReaders(resident, ctx.rng.fork("config-readers"), 3);
  const base = { modelBlock: fakePreset(ctx.llm.baseUrl) };
  for (let i = 0; i < 6; i += 1) {
    const include = {
      office: i % 2 === 0,
      cloudish: i % 3 !== 0,
      edge: i % 2 === 1,
    };
    await writeConfig(
      ctx.sandbox.configDir,
      buildConfig(ctx.corpus.layout, { ...base, include })
    );
    ctx.monitor.event("config", `rewrote config ${JSON.stringify(include)}`);
    await Bun.sleep(15_000);
  }
  await writeConfig(
    ctx.sandbox.configDir,
    buildConfig(ctx.corpus.layout, base)
  );
  await churn.stop();
  await readers.stop();
  checkResponsiveness(
    ctx.verdicts,
    ctx.monitor,
    resident.startedAt,
    Date.now()
  );
  await checkConvergence(
    ctx.verdicts,
    resident,
    ctx.sandbox,
    ctx.corpus,
    "after config edits"
  );
  await bringDown(ctx, resident, "SIGTERM", "config-edit");
};

const macosPsSampler: Runner = async (ctx) => {
  if (process.platform !== "darwin") {
    ctx.verdicts.skip(
      "I1",
      "macos-ps-sampler: darwin only (file conversion memory sampler spawns ps)"
    );
    return;
  }
  const before = new Set((await listProcesses()).map((p) => p.pid));
  let psSpawns = 0;
  const watcher = setInterval(async () => {
    for (const info of await listProcesses()) {
      if (!before.has(info.pid) && /(^|\/)ps( |$)/.test(info.command)) {
        before.add(info.pid);
        psSpawns += 1;
      }
    }
  }, 50);
  const result = await runGno(ctx.sandbox, ["update", "office"], {
    timeoutMs: 300_000,
  });
  clearInterval(watcher);
  ctx.verdicts.observe(
    "I1",
    psSpawns <= 20,
    `office update (exit ${result.code}) spawned ${psSpawns} ps processes`
  );
};

export const TORTURE_RUNNERS: Record<TortureClass, Runner> = {
  "failing-collection": failingCollection,
  "lease-held": leaseHeld,
  signals,
  "embed-faults": embedFaults,
  "sleep-wake": sleepWake,
  "desktop-shell-kill": desktopShellKill,
  "update-cmd": updateCmd,
  "session-import-kill": sessionImportKill,
  "sse-flood": sseFlood,
  "mcp-lifecycle": mcpLifecycle,
  "stale-locks": staleLocks,
  "config-edit": configEdit,
  "macos-ps-sampler": macosPsSampler,
};

/** Reindex with no resident running so each class starts from a converged index (setup, not measured). */
export async function resetBaseline(
  ctx: RunContext,
  label: string
): Promise<void> {
  const result = await runGno(ctx.sandbox, ["index"], {
    timeoutMs: 15 * 60_000,
  });
  ctx.monitor.event(
    "baseline",
    `${label}: gno index exit ${result.code} in ${(result.ms / 1000).toFixed(0)} s`
  );
}

export async function runTorture(
  ctx: RunContext,
  classes: readonly TortureClass[]
): Promise<void> {
  for (const [index, name] of classes.entries()) {
    ctx.verdicts.scenario = `torture/${name}`;
    ctx.monitor.event("torture", name);
    await resetBaseline(ctx, name);
    try {
      await withTimeout(TORTURE_RUNNERS[name](ctx), 45 * 60_000, name);
    } catch (error) {
      // A timed-out runner keeps running in the background; stop everything
      // rather than let it overlap the next class.
      const skipped = classes.slice(index + 1);
      ctx.notes.push(
        `torture/${name} aborted: ${error instanceof Error ? error.message : String(error)}${skipped.length ? `; skipped ${skipped.join(", ")}` : ""}`
      );
      ctx.monitor.event("error", `${name}: ${String(error)}`);
      if (ctx.monitor.resident && isAlive(ctx.monitor.resident.pid)) {
        await stopResident(ctx.monitor.resident, "SIGKILL", 5_000);
      }
      ctx.monitor.resident = null;
      await ctx.llm.setFaults({
        latencyMs: 0,
        errorRate: 0,
        malformedRate: 0,
        hang: false,
        down: false,
      });
      break;
    }
  }
}
