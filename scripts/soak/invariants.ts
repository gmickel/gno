/**
 * The nine soak invariants (fn-203 R3). Scenarios call the point checks at
 * the moments that matter (after a stop, after a quiet window, after churn);
 * every call records an observation, and an invariant fails when any of its
 * observations failed.
 *
 * @module scripts/soak/invariants
 */

import { Database } from "bun:sqlite";

import type { Corpus } from "./corpus";
import type { Resident, StopResult } from "./gno";
import type { Monitor } from "./monitor";
import type { ProcInfo } from "./procfs";
import type { Sandbox } from "./sandbox";

import { THRESHOLDS } from "./config";
import { getJson, residentPaths } from "./gno";
import { isAlive } from "./procfs";
import { lockIsFree, portIsFree } from "./sandbox";

export const INVARIANTS = {
  I1: "Idle settles",
  I2: "No orphans or zombies",
  I3: "Locks and files released",
  I4: "Status stays responsive",
  I5: "Shutdown within budget",
  I6: "Bounded resources",
  I7: "Retries are bounded",
  I8: "Index converges",
  I9: "No data loss under kill",
} as const;

export type InvariantId = keyof typeof INVARIANTS;

export interface Observation {
  invariant: InvariantId;
  ok: boolean;
  /** Skipped observations explain why a check could not run. */
  skipped?: boolean;
  scenario: string;
  t: number;
  detail: string;
  evidence?: unknown;
}

export class Verdicts {
  readonly observations: Observation[] = [];
  scenario = "setup";

  observe(
    invariant: InvariantId,
    ok: boolean,
    detail: string,
    evidence?: unknown
  ): Observation {
    const observation = {
      invariant,
      ok,
      scenario: this.scenario,
      t: Date.now(),
      detail,
      evidence,
    };
    this.observations.push(observation);
    return observation;
  }

  skip(invariant: InvariantId, detail: string): void {
    this.observations.push({
      invariant,
      ok: true,
      skipped: true,
      scenario: this.scenario,
      t: Date.now(),
      detail,
    });
  }

  summary(): {
    id: InvariantId;
    name: string;
    status: "pass" | "fail" | "skip";
    failures: number;
    checks: number;
  }[] {
    return (Object.keys(INVARIANTS) as InvariantId[]).map((id) => {
      const all = this.observations.filter((o) => o.invariant === id);
      const real = all.filter((o) => !o.skipped);
      const failures = real.filter((o) => !o.ok).length;
      const status = failures > 0 ? "fail" : real.length > 0 ? "pass" : "skip";
      return {
        id,
        name: INVARIANTS[id],
        status,
        failures,
        checks: real.length,
      };
    });
  }
}

/** Least-squares slope of y over x (per unit x). */
export function slope(points: readonly { x: number; y: number }[]): number {
  if (points.length < 2) return 0;
  const n = points.length;
  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[
      Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
    ] ?? 0
  );
}

/** Max attempts for one (collection, path) inside any 10-minute window. */
export function maxAttemptsPerWindow(
  rows: readonly { key: string; t: number }[],
  windowMs = 600_000
): { key: string; attempts: number } {
  const byKey = new Map<string, number[]>();
  for (const row of rows) {
    const list = byKey.get(row.key) ?? [];
    list.push(row.t);
    byKey.set(row.key, list);
  }
  let worst = { key: "", attempts: 0 };
  for (const [key, times] of byKey) {
    times.sort((a, b) => a - b);
    let start = 0;
    for (let end = 0; end < times.length; end += 1) {
      while ((times[end] as number) - (times[start] as number) > windowMs)
        start += 1;
      const attempts = end - start + 1;
      if (attempts > worst.attempts) worst = { key, attempts };
    }
  }
  return worst;
}

// ── I1 ───────────────────────────────────────────────────────────────────────

export interface IdleWindow {
  from: number;
  to: number;
  childPidsBefore: number;
}

export async function checkIdle(
  verdicts: Verdicts,
  monitor: Monitor,
  window: IdleWindow
): Promise<void> {
  const samples = monitor.window(monitor.samples, window.from, window.to);
  const growth = monitor.window(monitor.growth, window.from, window.to);
  if (samples.length < 5) {
    verdicts.skip("I1", `too few samples in idle window (${samples.length})`);
    return;
  }
  const first = samples[0] as (typeof samples)[number];
  const last = samples.at(-1) as (typeof samples)[number];
  const seconds = (last.t - first.t) / 1000;
  const cpuPercent = ((last.cpuTotal - first.cpuTotal) / seconds) * 100;
  const wakeups = (last.ctxTotal - first.ctxTotal) / seconds;
  const dbGrowth =
    growth.length >= 2
      ? (growth.at(-1)?.dbBytes ?? 0) - (growth[0]?.dbBytes ?? 0)
      : 0;
  const newErrors =
    growth.length >= 2
      ? (growth.at(-1)?.ingestErrors ?? 0) - (growth[0]?.ingestErrors ?? 0)
      : 0;
  const newChildren = monitor.residentChildPids.size - window.childPidsBefore;
  const newChildCommands = [...monitor.residentChildCommands.values()]
    .slice(window.childPidsBefore)
    .map((command) => command.slice(0, 120));
  const linux = process.platform === "linux";
  const failures: string[] = [];
  if (cpuPercent > THRESHOLDS.idleCpuPercent)
    failures.push(`cpu ${cpuPercent.toFixed(2)}%`);
  if (linux && wakeups > THRESHOLDS.idleWakeupsPerSec)
    failures.push(`wakeups ${wakeups.toFixed(1)}/s`);
  if (dbGrowth > THRESHOLDS.idleDbGrowthBytes)
    failures.push(`db +${dbGrowth} B`);
  if (newErrors > THRESHOLDS.idleNewIngestErrors)
    failures.push(`ingest_errors +${newErrors}`);
  if (newChildren > 0)
    failures.push(
      `${newChildren} new child processes: ${newChildCommands.join(" | ")}`
    );
  verdicts.observe(
    "I1",
    failures.length === 0,
    `${seconds.toFixed(0)} s idle: cpu ${cpuPercent.toFixed(2)}%, wakeups ${linux ? wakeups.toFixed(1) : "n/a"}/s, db +${dbGrowth} B, ingest_errors +${newErrors}, children +${newChildren}${failures.length ? ` [FAIL: ${failures.join(", ")}]` : ""}`,
    { cpuPercent, wakeups, dbGrowth, newErrors, newChildren, newChildCommands }
  );
}

// ── I2 / I3 ──────────────────────────────────────────────────────────────────

/**
 * Tagged processes still alive after `graceMs` other than `expected` (pids
 * the harness intends to be running, e.g. a live resident).
 */
export async function checkOrphans(
  verdicts: Verdicts,
  monitor: Monitor,
  label: string,
  expected: ReadonlySet<number> = new Set()
): Promise<ProcInfo[]> {
  const deadline = Date.now() + THRESHOLDS.orphanGraceMs;
  let left: ProcInfo[] = [];
  do {
    const tagged = await monitor.taggedProcesses();
    const liveTagged = new Set(
      tagged.filter((info) => info.state !== "Z").map((info) => info.pid)
    );
    // A zombie is GNO's fault only when a live GNO process failed to reap it;
    // one parented by the harness or namespace init is not a GNO leftover.
    left = tagged.filter(
      (info) =>
        !expected.has(info.pid) &&
        (info.state !== "Z" || liveTagged.has(info.ppid))
    );
    if (left.length === 0) break;
    await Bun.sleep(250);
  } while (Date.now() < deadline);
  const zombies = left.filter((info) => info.state === "Z");
  verdicts.observe(
    "I2",
    left.length === 0,
    left.length === 0
      ? `${label}: no leftover processes`
      : `${label}: ${left.length} leftover (${zombies.length} zombie): ${left
          .map((info) => `${info.pid} ${info.command.slice(0, 90)}`)
          .join(" | ")}`,
    left.map((info) => ({
      pid: info.pid,
      ppid: info.ppid,
      state: info.state,
      command: info.command,
    }))
  );
  return left;
}

export async function checkZombies(
  verdicts: Verdicts,
  monitor: Monitor,
  label: string
): Promise<void> {
  const tagged = await monitor.taggedProcesses();
  const liveTagged = new Set(
    tagged.filter((info) => info.state !== "Z").map((info) => info.pid)
  );
  // Same rule as checkOrphans: only zombies a live GNO process failed to reap.
  const zombies = tagged.filter(
    (info) => info.state === "Z" && liveTagged.has(info.ppid)
  );
  verdicts.observe(
    "I2",
    zombies.length === 0,
    zombies.length === 0
      ? `${label}: no zombies`
      : `${label}: zombies ${zombies.map((z) => `${z.pid} (parent ${z.ppid})`).join(",")}`
  );
}

export async function checkReleased(
  verdicts: Verdicts,
  sandbox: Sandbox,
  label: string,
  port: number,
  options: { pidFile?: string; afterKill?: boolean } = {}
): Promise<void> {
  const paths = residentPaths(sandbox);
  const problems: string[] = [];
  // A SIGKILLed process cannot remove its metadata; the kernel still frees
  // its locks and port. After a kill, leftover metadata is reported, not
  // failed: recovery from it is what the stale-locks torture class checks.
  const stale: string[] = [];
  const metadata = options.afterKill ? stale : problems;
  if (!lockIsFree(paths.writeLock)) problems.push("write lock held");
  if (!lockIsFree(paths.ownerLock)) problems.push("owner lock held");
  if (await Bun.file(`${paths.writeLock}.holder.json`).exists())
    metadata.push("write-lease holder sidecar left");
  if (options.pidFile && (await Bun.file(options.pidFile).exists()))
    metadata.push("pid file left");
  if (
    options.pidFile &&
    (await Bun.file(`${options.pidFile}.startlock`).exists())
  )
    metadata.push("detach start-lock left");
  if (!(await portIsFree(port))) problems.push(`port ${port} still bound`);
  const staleNote =
    stale.length > 0 ? ` (after kill, stale: ${stale.join(", ")})` : "";
  verdicts.observe(
    "I3",
    problems.length === 0,
    `${label}: ${problems.length === 0 ? "locks, holder sidecar, pid file, start-lock and port released" : problems.join(", ")}${staleNote}`
  );
}

// ── I4 ───────────────────────────────────────────────────────────────────────

export function checkResponsiveness(
  verdicts: Verdicts,
  monitor: Monitor,
  from: number,
  to: number
): void {
  const probes = monitor.window(monitor.probes, from, to);
  if (probes.length === 0) {
    verdicts.skip("I4", "no status probes in window");
    return;
  }
  const latencies = probes.map((p) => p.ms);
  const failed = probes.filter((p) => !p.ok).length;
  const p99 = percentile(latencies, 99);
  const max = Math.max(...latencies);
  const ok =
    failed === 0 &&
    p99 <= THRESHOLDS.statusP99Ms &&
    max <= THRESHOLDS.statusMaxMs;
  verdicts.observe(
    "I4",
    ok,
    `${probes.length} probes: p99 ${p99.toFixed(0)} ms, max ${max.toFixed(0)} ms, failed ${failed}`,
    { p99, max, failed, count: probes.length }
  );
}

// ── I5 ───────────────────────────────────────────────────────────────────────

export function checkShutdown(
  verdicts: Verdicts,
  label: string,
  result: StopResult
): void {
  const ok =
    !result.escalated &&
    result.exitMs !== null &&
    result.exitMs <= THRESHOLDS.shutdownMs;
  verdicts.observe(
    "I5",
    ok,
    `${label}: ${result.signal} -> ${result.escalated ? "did not exit, SIGKILLed" : `exit ${result.exitCode} after ${(result.exitMs ?? 0).toFixed(0)} ms`}`
  );
}

// ── I6 ───────────────────────────────────────────────────────────────────────

export function checkBoundedResources(
  verdicts: Verdicts,
  monitor: Monitor,
  from: number,
  to: number
): void {
  const hours = (to - from) / 3_600_000;
  if (hours < 0.33) {
    verdicts.skip(
      "I6",
      `window ${(hours * 60).toFixed(0)} min is too short for growth slopes (needs 20 min)`
    );
    return;
  }
  const samples = monitor
    .window(monitor.samples, from, to)
    .filter((s) => s.residentRssKb > 0);
  const growth = monitor.window(monitor.growth, from, to);
  const perHour = (points: { x: number; y: number }[]) =>
    slope(points) * 3_600_000;
  const rss = perHour(
    samples.map((s) => ({ x: s.t, y: s.residentRssKb / 1024 }))
  );
  const fds = perHour(samples.map((s) => ({ x: s.t, y: s.residentFds })));
  const errors = perHour(growth.map((g) => ({ x: g.t, y: g.ingestErrors })));
  const logs = perHour(growth.map((g) => ({ x: g.t, y: g.logBytes })));
  const failures: string[] = [];
  if (rss > THRESHOLDS.rssSlopeMbPerHour)
    failures.push(`rss +${rss.toFixed(1)} MB/h`);
  if (fds > THRESHOLDS.fdSlopePerHour)
    failures.push(`fds +${fds.toFixed(1)}/h`);
  if (errors > THRESHOLDS.ingestErrorsPerHour)
    failures.push(`ingest_errors +${errors.toFixed(0)}/h`);
  if (logs > THRESHOLDS.logBytesPerHour)
    failures.push(`logs +${(logs / 1024).toFixed(0)} KB/h`);
  verdicts.observe(
    "I6",
    failures.length === 0,
    `over ${(hours * 60).toFixed(0)} min: rss ${rss.toFixed(1)} MB/h, fds ${fds.toFixed(1)}/h, ingest_errors ${errors.toFixed(0)}/h, logs ${(logs / 1024).toFixed(0)} KB/h`,
    { rss, fds, errors, logs }
  );
}

// ── I7 ───────────────────────────────────────────────────────────────────────

export function ingestErrorRows(
  sandbox: Sandbox,
  sinceMs: number
): { key: string; t: number }[] {
  const db = new Database(residentPaths(sandbox).db, { readonly: true });
  try {
    return db
      .query<{ collection: string; rel_path: string; occurred_at: string }, []>(
        "SELECT collection, rel_path, occurred_at FROM ingest_errors"
      )
      .all()
      .map((row) => ({
        key: `${row.collection}/${row.rel_path}`,
        t: Date.parse(`${row.occurred_at.replace(" ", "T")}Z`),
      }))
      .filter((row) => row.t >= sinceMs - 1_000);
  } finally {
    db.close();
  }
}

export function checkRetries(
  verdicts: Verdicts,
  sandbox: Sandbox,
  label: string,
  sinceMs: number
): void {
  let rows: { key: string; t: number }[];
  try {
    rows = ingestErrorRows(sandbox, sinceMs);
  } catch (error) {
    verdicts.skip(
      "I7",
      `${label}: ingest_errors unreadable (${String(error)})`
    );
    return;
  }
  const worst = maxAttemptsPerWindow(rows);
  verdicts.observe(
    "I7",
    worst.attempts <= THRESHOLDS.maxAttemptsPer10Min,
    `${label}: worst path ${worst.key || "-"} failed ${worst.attempts}x in a 10-min window (${rows.length} error rows)`,
    worst
  );
}

// ── I8 / I9 ──────────────────────────────────────────────────────────────────

function findNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  for (const [k, v] of Object.entries(value)) {
    if (k === key && typeof v === "number") return v;
    const nested = findNumber(v, key);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

export interface ConvergenceState {
  missing: string[];
  extra: string[];
  staleMarkers: string[];
  backlog: number | undefined;
  embedBusy: boolean;
  activeJob: boolean;
  /** Harness bookkeeping drift (disk vs. what the harness thinks it wrote). */
  bookkeepingDrift: string[];
}

export async function convergenceState(
  resident: Resident,
  sandbox: Sandbox,
  corpus: Corpus
): Promise<ConvergenceState> {
  // Ground truth is the disk; the harness's own map only supplies markers.
  const onDisk = new Set(await corpus.walkNotes());
  const bookkeepingDrift = [
    ...[...onDisk]
      .filter((rel) => !corpus.live.has(rel))
      .map((rel) => `on disk, not tracked: ${rel}`),
    ...[...corpus.live.keys()]
      .filter((rel) => !onDisk.has(rel))
      .map((rel) => `tracked, not on disk: ${rel}`),
  ];
  const db = new Database(residentPaths(sandbox).db, { readonly: true });
  let indexed: Map<string, string>;
  try {
    indexed = new Map(
      db
        .query<{ rel_path: string; markdown: string | null }, []>(
          `SELECT d.rel_path, c.markdown FROM documents d
           LEFT JOIN content c ON c.mirror_hash = d.mirror_hash
           WHERE d.collection = 'notes' AND d.active = 1`
        )
        .all()
        .map((row) => [row.rel_path, row.markdown ?? ""])
    );
  } finally {
    db.close();
  }
  const missing = [...onDisk].filter((rel) => !indexed.has(rel));
  const extra = [...indexed.keys()].filter((rel) => !onDisk.has(rel));
  const staleMarkers = [...corpus.live]
    .filter(
      ([rel, marker]) =>
        onDisk.has(rel) &&
        indexed.has(rel) &&
        !(indexed.get(rel) ?? "").includes(marker)
    )
    .map(([rel]) => rel);
  const status = await getJson(resident, "/api/status");
  const embed = await getJson<{ running?: boolean; nextRunAt?: number }>(
    resident,
    "/api/embed/status"
  );
  const jobs = await getJson<{ activeJob?: unknown }>(
    resident,
    "/api/jobs/active"
  );
  return {
    missing,
    extra,
    staleMarkers,
    backlog: findNumber(status, "embeddingBacklog"),
    embedBusy: Boolean(embed?.running) || embed?.nextRunAt != null,
    activeJob: Boolean(jobs?.activeJob),
    bookkeepingDrift,
  };
}

function converged(state: ConvergenceState): boolean {
  return (
    state.missing.length === 0 &&
    state.extra.length === 0 &&
    state.staleMarkers.length === 0 &&
    (state.backlog ?? 0) === 0 &&
    !state.embedBusy &&
    !state.activeJob
  );
}

export async function checkConvergence(
  verdicts: Verdicts,
  resident: Resident,
  sandbox: Sandbox,
  corpus: Corpus,
  label: string,
  invariant: InvariantId = "I8"
): Promise<boolean> {
  const started = Date.now();
  let state = await convergenceState(resident, sandbox, corpus);
  while (!converged(state) && Date.now() - started < THRESHOLDS.convergenceMs) {
    await Bun.sleep(2_000);
    state = await convergenceState(resident, sandbox, corpus);
  }
  const ok = converged(state);
  const took = ((Date.now() - started) / 1000).toFixed(0);
  verdicts.observe(
    invariant,
    ok,
    ok
      ? `${label}: converged in ${took} s (${corpus.live.size} notes)`
      : `${label}: not converged after ${took} s: missing ${state.missing.length}, extra ${state.extra.length}, stale ${state.staleMarkers.length}, backlog ${state.backlog}, embedBusy ${state.embedBusy}, activeJob ${state.activeJob}`,
    {
      ...state,
      missing: state.missing.slice(0, 20),
      extra: state.extra.slice(0, 20),
      staleMarkers: state.staleMarkers.slice(0, 20),
      bookkeepingDrift: state.bookkeepingDrift.slice(0, 20),
    }
  );
  return ok;
}

/** Open the index the way a restarting GNO does (migrations, FTS tokenizer, sqlite-vec) and run integrity_check. */
export async function checkIntegrity(
  verdicts: Verdicts,
  sandbox: Sandbox,
  label: string
): Promise<void> {
  const { SqliteAdapter } = await import("../../src/store/sqlite/adapter");
  const { loadSqliteVec } = await import("../../src/store/vector/variants");
  const adapter = new SqliteAdapter();
  const opened = await adapter.open(
    residentPaths(sandbox).db,
    "snowball english"
  );
  if (!opened.ok) {
    verdicts.observe(
      "I9",
      false,
      `${label}: index failed to open: ${opened.error.message}`
    );
    return;
  }
  try {
    const db = adapter.getRawDb();
    await loadSqliteVec(db);
    const rows = db
      .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
      .all();
    const ok = rows.length === 1 && rows[0]?.integrity_check === "ok";
    verdicts.observe(
      "I9",
      ok,
      `${label}: integrity_check ${ok ? "ok" : JSON.stringify(rows.slice(0, 5))}`
    );
  } finally {
    await adapter.close();
  }
}

export function pidAlive(pid: number): boolean {
  return isAlive(pid);
}
