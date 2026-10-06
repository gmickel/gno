#!/usr/bin/env bun
/**
 * GNO soak and chaos harness (fn-203).
 *
 * Starts real GNO processes in a sealed sandbox (own HOME/XDG/GNO dirs,
 * offline, loopback fake model server), drives them with seeded actors and
 * faults, samples every process continuously, and checks nine invariants.
 * Writes report.json (also the replay input) and report.md.
 *
 * Usage:
 *   bun run soak --tier smoke                     # ~5 min lifecycle cycle
 *   bun run soak --tier torture [--classes a,b]   # each fault class in isolation
 *   bun run soak --tier soak --duration 4h        # seeded mixed load + faults
 *   bun run soak --replay <report.json>           # same seed, tier and options
 *
 * Options: --seed N, --docs N, --duration 30m|4h, --idle-quiet 60s,
 *   --out <dir>, --keep (keep the sandbox), --contain (Linux: run inside a
 *   PID namespace so a killed harness leaves nothing behind).
 *
 * Exit code: 0 all invariants pass (skips allowed), 1 any invariant failed,
 * 2 the harness itself failed.
 */

// node:fs/promises — cp/mkdir are directory-structure ops
import { cp, mkdir } from "node:fs/promises";
// node:os — tmpdir has no Bun equivalent
import { tmpdir } from "node:os";
// node:path — Bun has no path utilities
import { join } from "node:path";

import type { RunContext } from "./kit";

import { THRESHOLDS, TIER_DEFAULTS, type Tier } from "./config";
import { buildConfig, Corpus, writeConfig } from "./corpus";
import { fakePreset, startFakeLlm } from "./fake-llm";
import { Verdicts } from "./invariants";
import { Monitor } from "./monitor";
import { findTagged, listProcesses, markerValues } from "./procfs";
import {
  type Report,
  type RunOptions,
  renderMarkdown,
  writeReport,
} from "./report";
import { createRng } from "./rng";
import {
  createSandbox,
  killAllTagged,
  REPO_ROOT,
  RUN_MARKER,
  removeSandbox,
  runGno,
} from "./sandbox";
import { runSmoke } from "./scenarios/smoke";
import { runSoak } from "./scenarios/soak";
import {
  runTorture,
  TORTURE_CLASSES,
  type TortureClass,
} from "./scenarios/torture";

const CONTAINED_ENV = "GNO_SOAK_CONTAINED";

export function parseDuration(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) throw new Error(`invalid duration: ${value}`);
  const n = Number(match[1]);
  const unit = match[2] ?? "s";
  return Math.round(
    n *
      { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[
        unit as "ms" | "s" | "m" | "h"
      ]
  );
}

interface Cli {
  options: RunOptions;
  out?: string;
  keep: boolean;
}

export function parseArgs(
  argv: string[]
): Cli & { replay?: string; help: boolean } {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const [key, inline] = arg.slice(2).split("=", 2) as [
      string,
      string | undefined,
    ];
    const next = argv[i + 1];
    if (inline !== undefined) flags.set(key, inline);
    else if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      i += 1;
    } else flags.set(key, true);
  }
  const str = (key: string) =>
    typeof flags.get(key) === "string" ? (flags.get(key) as string) : undefined;
  const tier = (str("tier") ?? "smoke") as Tier;
  if (!(tier in TIER_DEFAULTS))
    throw new Error(`unknown tier: ${tier} (smoke, torture, soak)`);
  const classes = str("classes")
    ?.split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  for (const c of classes ?? []) {
    if (!TORTURE_CLASSES.includes(c as TortureClass))
      throw new Error(`unknown torture class: ${c}`);
  }
  return {
    help: flags.has("help"),
    replay: str("replay"),
    out: str("out"),
    keep: flags.has("keep"),
    options: {
      tier,
      seed: str("seed")
        ? Number(str("seed"))
        : Math.floor(Math.random() * 2 ** 31),
      durationMs: str("duration")
        ? parseDuration(str("duration") as string)
        : TIER_DEFAULTS[tier].durationMs,
      docs: str("docs") ? Number(str("docs")) : TIER_DEFAULTS[tier].docs,
      classes,
      idleQuietMs: str("idle-quiet")
        ? parseDuration(str("idle-quiet") as string)
        : THRESHOLDS.idleQuietMs,
      contain: flags.has("contain"),
    },
  };
}

/** Re-exec inside a PID namespace so a killed harness takes every child with it (R2). */
async function reexecContained(): Promise<void> {
  if (
    !(
      process.platform === "linux" &&
      Bun.which("unshare") &&
      !process.env[CONTAINED_ENV]
    )
  )
    return;
  const proc = Bun.spawn({
    cmd: [
      "unshare",
      "--user",
      "--map-current-user",
      "--pid",
      "--fork",
      "--kill-child",
      "--mount-proc",
      // bash, not the harness, is PID 1: it reaps orphans that re-parent to
      // it (bun would leave them as zombies). Two commands keep bash from exec'ing.
      "bash",
      "-c",
      '"$@"; exit $?',
      "_",
      process.execPath,
      import.meta.path,
      ...process.argv.slice(2),
    ],
    env: { ...process.env, [CONTAINED_ENV]: "1" },
    // Lifeline: never written. When this launcher dies for any reason the
    // pipe closes, the contained harness exits, and the namespace (PID 1 and
    // every GNO process in it) goes with it.
    stdin: "pipe",
    stdout: "inherit",
    stderr: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => proc.kill(signal));
  }
  process.exit((await proc.exited) ?? 2);
}

/** Inside the namespace: exit when the launcher's lifeline pipe closes. */
function watchLifeline(): void {
  if (!process.env[CONTAINED_ENV]) return;
  process.stdin.on("end", () => {
    console.error(
      "soak: launcher is gone; stopping (the namespace takes every child with it)"
    );
    process.exit(3);
  });
  process.stdin.resume();
}

/** Processes left by earlier (crashed) runs: anything carrying a run marker. */
async function sweepEarlierRuns(currentRun: string): Promise<string[]> {
  const found: string[] = [];
  const markers = await markerValues(RUN_MARKER);
  const processes = await listProcesses();
  // A run is stale when any of its processes was re-parented to init (its
  // harness is gone). Kill every process of a stale run, descendants
  // included; a concurrent live run has no orphans and is left alone.
  const staleRuns = new Set(
    processes
      .filter((info) => info.ppid === 1)
      .map((info) => markers.get(info.pid))
      .filter((run): run is string => run !== undefined && run !== currentRun)
  );
  for (const run of staleRuns) {
    for (let pass = 0; pass < 5; pass += 1) {
      const members = await findTagged(RUN_MARKER, run);
      if (members.length === 0) break;
      for (const info of members) {
        if (pass === 0)
          found.push(
            `run ${run}: pid ${info.pid} killed ${info.command.slice(0, 100)}`
          );
        try {
          process.kill(info.pid, "SIGKILL");
        } catch {
          // gone
        }
      }
      await Bun.sleep(200);
    }
  }
  for (const info of processes) {
    const run = markers.get(info.pid);
    if (run && run !== currentRun && !staleRuns.has(run)) {
      found.push(
        `run ${run}: pid ${info.pid} (live run, left alone) ${info.command.slice(0, 100)}`
      );
    }
  }
  return found;
}

async function gnoIdentity(): Promise<{ version: string; commit: string }> {
  const pkg = (await Bun.file(join(REPO_ROOT, "package.json")).json()) as {
    version: string;
  };
  const sha = Bun.spawnSync([
    "git",
    "-C",
    REPO_ROOT,
    "rev-parse",
    "--short",
    "HEAD",
  ])
    .stdout.toString()
    .trim();
  const dirty = Bun.spawnSync([
    "git",
    "-C",
    REPO_ROOT,
    "status",
    "--porcelain",
    "--",
    "src",
  ])
    .stdout.toString()
    .trim();
  return {
    version: pkg.version,
    commit: `${sha || "unknown"}${dirty ? "+dirty" : ""}`,
  };
}

export async function main(argv: string[]): Promise<number> {
  const cli = parseArgs(argv);
  if (cli.help) {
    console.log(
      `Usage: bun run soak --tier smoke|torture|soak [--seed N] [--duration 4h] [--docs N]\n       [--classes ${TORTURE_CLASSES.join(",")}]\n       [--idle-quiet 60s] [--out dir] [--keep] [--contain] [--replay report.json]\n\nGNO_SOAK_CPU_PROF=<dir> writes a CPU profile of each resident to <dir> when it exits.`
    );
    return 0;
  }
  let options = cli.options;
  if (cli.replay) {
    const previous = (await Bun.file(cli.replay).json()) as Report;
    options = {
      ...previous.options,
      contain: cli.options.contain || previous.options.contain,
    };
  }
  if (options.contain) await reexecContained();
  watchLifeline();

  const runId = `${options.tier}-${options.seed}-${Date.now().toString(36)}`;
  const reportDir = cli.out ?? join(tmpdir(), "gno-soak-reports", runId);
  const staleFromEarlierRuns = await sweepEarlierRuns(runId);
  const rng = createRng(options.seed);
  const sandbox = await createSandbox(runId);
  const faultRng = rng.fork("llm-faults");
  const llm = startFakeLlm(() => faultRng.next());
  const corpus = new Corpus(sandbox.corpusDir, rng.fork("corpus"));
  const monitor = new Monitor(sandbox);
  const verdicts = new Verdicts();
  const notes: string[] = [];
  const started = Date.now();
  console.log(`soak ${runId}: sandbox ${sandbox.root}, report ${reportDir}`);
  let harnessError: unknown = null;

  try {
    await corpus.generate(options.docs);
    await writeConfig(
      sandbox.configDir,
      buildConfig(corpus.layout, { modelBlock: fakePreset(llm.baseUrl) })
    );
    const initial = await runGno(sandbox, ["index"], {
      timeoutMs: 30 * 60_000,
    });
    monitor.event(
      "setup",
      `initial gno index exit ${initial.code} in ${(initial.ms / 1000).toFixed(1)} s`
    );
    if (initial.code !== 0 && initial.code !== 1) {
      notes.push(
        `initial gno index exited ${initial.code}: ${initial.stderr.slice(-500)}`
      );
    }
    monitor.start();
    const ctx: RunContext = {
      sandbox,
      monitor,
      verdicts,
      corpus,
      llm,
      rng,
      notes,
      idleQuietMs: options.idleQuietMs,
    };
    if (options.tier === "smoke") await runSmoke(ctx, options.durationMs);
    else if (options.tier === "torture")
      await runTorture(
        ctx,
        (options.classes as TortureClass[] | undefined) ?? TORTURE_CLASSES
      );
    else await runSoak(ctx, options.durationMs);
  } catch (error) {
    harnessError = error;
    notes.push(
      `harness error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
    );
  } finally {
    monitor.stop();
    verdicts.scenario = "teardown";
    // A timed-out scenario may still be running; it can start nothing new now.
    sandbox.closed = true;
    const leftovers = await killAllTagged(sandbox);
    verdicts.observe(
      "I2",
      leftovers.length === 0,
      leftovers.length === 0
        ? "teardown: no tagged processes left"
        : `teardown: killed ${leftovers.length} leftover: ${leftovers.map((p) => `${p.pid} ${p.command.slice(0, 80)}`).join(" | ")}`
    );
    llm.stop();
    await corpus.unlockEdge();
  }

  const finished = Date.now();
  const summary = verdicts.summary();
  const report: Report = {
    runId,
    options,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    gno: await gnoIdentity(),
    platform: { os: process.platform, arch: process.arch, bun: Bun.version },
    thresholds: THRESHOLDS,
    summary,
    failures: verdicts.observations.filter((o) => !o.ok && !o.skipped),
    observations: verdicts.observations,
    timeline: monitor.timeline,
    notes,
    staleFromEarlierRuns,
    sandboxRoot: cli.keep ? sandbox.root : "(removed)",
  };
  await mkdir(reportDir, { recursive: true });
  await cp(sandbox.logDir, join(reportDir, "logs"), { recursive: true }).catch(
    () => undefined
  );
  const written = await writeReport(reportDir, report);
  if (!cli.keep) await removeSandbox(sandbox);
  console.log(renderMarkdown(report).split("## All observations")[0]);
  console.log(`report: ${written.md}`);
  if (harnessError) return 2;
  return summary.some((s) => s.status === "fail") ? 1 : 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
