/**
 * Continuous measurement for a soak run: per-second samples of every tagged
 * GNO process, status-probe latency, and index/log growth. Invariants read
 * the recorded series afterwards.
 *
 * @module scripts/soak/monitor
 */

import { Database } from "bun:sqlite";
// node:fs/promises — stat for file sizes (Bun.file().size is 0 for missing files)
import { readdir, stat } from "node:fs/promises";
// node:path — Bun has no path utilities
import { join } from "node:path";

import type { Resident } from "./gno";
import type { Sandbox } from "./sandbox";

import { SAMPLE_INTERVAL_MS, STATUS_PROBE_MS } from "./config";
import { probeStatus } from "./gno";
import {
  hasEnvMarker,
  listProcesses,
  markerValues,
  type ProcInfo,
} from "./procfs";
import { RUN_MARKER } from "./sandbox";

export interface Sample {
  t: number;
  /** Cumulative CPU seconds of every tagged process ever seen. */
  cpuTotal: number;
  /** Cumulative context switches (Linux). */
  ctxTotal: number;
  procCount: number;
  rssKb: number;
  /** Resident process only. */
  residentRssKb: number;
  residentFds: number;
  residentThreads: number;
  fds: number;
  zombies: number[];
  children: number;
}

export interface ProbeSample {
  t: number;
  ok: boolean;
  ms: number;
}

export interface GrowthSample {
  t: number;
  dbBytes: number;
  ingestErrors: number;
  logBytes: number;
}

export interface TimelineEvent {
  t: number;
  kind: string;
  detail: string;
}

export class Monitor {
  readonly samples: Sample[] = [];
  readonly probes: ProbeSample[] = [];
  readonly growth: GrowthSample[] = [];
  readonly timeline: TimelineEvent[] = [];
  /** Distinct child pids observed under the resident, for spawn-rate checks. */
  readonly residentChildPids = new Set<number>();
  /** Command line of every resident child, by pid, in first-seen order. */
  readonly residentChildCommands = new Map<number, string>();
  resident: Resident | null = null;
  private readonly tagged = new Set<number>();
  private readonly untagged = new Set<number>();
  private readonly lastCpu = new Map<number, number>();
  private readonly lastCtx = new Map<number, number>();
  private cpuTotal = 0;
  private ctxTotal = 0;
  private timers: ReturnType<typeof setInterval>[] = [];
  private sampling = false;

  constructor(private readonly sandbox: Sandbox) {}

  event(kind: string, detail = ""): void {
    this.timeline.push({ t: Date.now(), kind, detail });
  }

  start(): void {
    this.timers.push(setInterval(() => void this.sample(), SAMPLE_INTERVAL_MS));
    this.timers.push(setInterval(() => void this.probe(), STATUS_PROBE_MS));
    this.timers.push(setInterval(() => void this.measureGrowth(), 5_000));
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  private async isTagged(info: ProcInfo): Promise<boolean> {
    if (this.tagged.has(info.pid)) return true;
    if (this.untagged.has(info.pid) || info.pid === process.pid) return false;
    const yes = await hasEnvMarker(info.pid, RUN_MARKER, this.sandbox.runId);
    (yes ? this.tagged : this.untagged).add(info.pid);
    return yes;
  }

  /** Current tagged processes (also used by the orphan invariant). */
  async taggedProcesses(): Promise<ProcInfo[]> {
    const all = await listProcesses();
    const live = new Set(all.map((info) => info.pid));
    // Forget exited pids in both caches so a reused pid is classified afresh.
    for (const pid of this.untagged)
      if (!live.has(pid)) this.untagged.delete(pid);
    for (const pid of this.tagged) if (!live.has(pid)) this.tagged.delete(pid);
    if (process.platform !== "linux") {
      // macOS: one `ps -E` per sample instead of one ps per unknown pid.
      const markers = await markerValues(RUN_MARKER);
      return all.filter(
        (info) =>
          info.pid !== process.pid &&
          markers.get(info.pid) === this.sandbox.runId
      );
    }
    const out: ProcInfo[] = [];
    for (const info of all) if (await this.isTagged(info)) out.push(info);
    return out;
  }

  async sample(): Promise<Sample | null> {
    // A caller that needs a fresh sample waits out a timer-driven one in flight.
    while (this.sampling) await Bun.sleep(20);
    this.sampling = true;
    try {
      const procs = await this.taggedProcesses();
      for (const info of procs) {
        const prev = this.lastCpu.get(info.pid) ?? 0;
        if (info.cpuSeconds >= prev) this.cpuTotal += info.cpuSeconds - prev;
        this.lastCpu.set(info.pid, info.cpuSeconds);
        const prevCtx = this.lastCtx.get(info.pid) ?? 0;
        const ctx = info.ctxSwitches ?? 0;
        if (ctx >= prevCtx) this.ctxTotal += ctx - prevCtx;
        this.lastCtx.set(info.pid, ctx);
      }
      const residentPid = this.resident?.pid;
      const resident = procs.find((info) => info.pid === residentPid);
      const children = procs.filter((info) => info.ppid === residentPid);
      for (const child of children) {
        this.residentChildPids.add(child.pid);
        const known = this.residentChildCommands.get(child.pid);
        if (known === undefined || known.startsWith("write-lease holder (")) {
          this.residentChildCommands.set(
            child.pid,
            await this.describeChild(child)
          );
        }
      }
      const sample: Sample = {
        t: Date.now(),
        cpuTotal: this.cpuTotal,
        ctxTotal: this.ctxTotal,
        procCount: procs.length,
        rssKb: procs.reduce((sum, info) => sum + info.rssKb, 0),
        residentRssKb: resident?.rssKb ?? 0,
        residentFds: resident?.fds ?? 0,
        residentThreads: resident?.threads ?? 0,
        fds: procs.reduce((sum, info) => sum + (info.fds ?? 0), 0),
        zombies: procs
          .filter((info) => info.state === "Z")
          .map((info) => info.pid),
        children: children.length,
      };
      this.samples.push(sample);
      return sample;
    } finally {
      this.sampling = false;
    }
  }

  private async probe(): Promise<void> {
    const resident = this.resident;
    if (!resident) return;
    const result = await probeStatus(resident);
    if (this.resident !== resident) return;
    this.probes.push({ t: Date.now(), ok: result.ok, ms: result.ms });
  }

  async measureGrowth(): Promise<GrowthSample> {
    const size = async (path: string): Promise<number> => {
      try {
        return (await stat(path)).size;
      } catch {
        return 0;
      }
    };
    const db = join(this.sandbox.dataDir, "index-default.sqlite");
    const dbBytes = (await size(db)) + (await size(`${db}-wal`));
    let ingestErrors = 0;
    try {
      const handle = new Database(db, { readonly: true });
      try {
        ingestErrors =
          handle
            .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM ingest_errors")
            .get()?.n ?? 0;
      } finally {
        handle.close();
      }
    } catch {
      ingestErrors = this.growth.at(-1)?.ingestErrors ?? 0;
    }
    let logBytes = 0;
    try {
      for (const name of await readdir(this.sandbox.logDir)) {
        logBytes += await size(join(this.sandbox.logDir, name));
      }
    } catch {
      logBytes = 0;
    }
    const sample = { t: Date.now(), dbBytes, ingestErrors, logBytes };
    this.growth.push(sample);
    return sample;
  }

  /** A lease-holder child is named by the holder sidecar the resident writes for it. */
  private async describeChild(child: ProcInfo): Promise<string> {
    if (!child.command.includes("READY")) return child.command;
    try {
      const holder = (await Bun.file(
        join(this.sandbox.dataDir, ".mcp-write.lock.holder.json")
      ).json()) as { command?: string };
      return `write-lease holder for ${holder.command ?? "unknown"}`;
    } catch {
      return `write-lease holder (${child.command})`;
    }
  }

  /** Samples inside [from, to]. */
  window<T extends { t: number }>(
    series: readonly T[],
    from: number,
    to: number
  ): T[] {
    return series.filter((entry) => entry.t >= from && entry.t <= to);
  }
}
