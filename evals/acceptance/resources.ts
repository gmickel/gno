/** Owned-process telemetry only. RSS and GPU accounting are never summed. */
import type { Subprocess } from "bun";

import {
  childIdentitySchema,
  type ChildEvent,
  type ChildIdentity,
} from "./child-receipt";

export interface ResourceSample {
  elapsedMs: number;
  rssBytes: number | null;
  gpuBytes: number | null;
  pids: number[];
  errors: string[];
  processes?: Array<{
    pid: number;
    rssBytes: number;
    gpuBytes?: number;
    nativeIdentity?: ChildIdentity;
  }>;
}

async function telemetry(
  cmd: string[]
): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "ignore",
    timeout: 2000,
    killSignal: "SIGKILL",
  });
  try {
    const output = await new Response(child.stdout).text();
    return { output, exitCode: await child.exited };
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await child.exited;
  }
}

export class OwnedResources {
  private readonly children = new Set<Subprocess>();
  private readonly transports = new Map<
    number,
    { live: () => boolean; close: () => Promise<void> }
  >();
  private readonly descendants = new Map<
    string,
    { identity: ChildIdentity; start: string; exited: boolean }
  >();
  readonly descendantEvents: ChildEvent[] = [];
  readonly samples: ResourceSample[] = [];
  readonly errors: string[] = [];
  private stopped = false;
  private sampling = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> = Promise.resolve();
  private readonly started = performance.now();

  constructor(private readonly gpu: boolean = false) {}

  /** Register immediately after spawn, before awaiting readiness. */
  own(child: Subprocess): void {
    if (this.stopped) {
      child.kill("SIGKILL");
      throw new Error("Resource scope already closed");
    }
    this.children.add(child);
  }

  ownTransport(
    pid: number,
    live: () => boolean,
    close: () => Promise<void>
  ): void {
    if (this.stopped || !Number.isSafeInteger(pid) || pid <= 0)
      throw new Error("Invalid transport owner");
    this.transports.set(pid, { live, close });
  }

  async observeDescendant(
    owner: { pid: number },
    event: ChildEvent
  ): Promise<void> {
    if (event.event !== "birth" && event.event !== "exit")
      throw new Error("Invalid native descendant event");
    const identity = childIdentitySchema.parse(event.identity);
    if (identity.parentPid !== owner.pid)
      throw new Error("Foreign native descendant owner");
    const prior = this.descendants.get(identity.token);
    if (event.event === "exit") {
      if (!prior || JSON.stringify(prior.identity) !== JSON.stringify(identity))
        throw new Error("Unknown native descendant exit");
      const state = await processIdentity(identity.pid);
      if (state?.start === prior.start)
        throw new Error("Native descendant still live after exit receipt");
      prior.exited = true;
    } else {
      if (!this.owns(owner.pid) || prior)
        throw new Error("Unowned/duplicate native descendant birth");
      if (
        [...this.descendants.values()].some(
          (item) =>
            item.identity.parentPid === owner.pid &&
            item.identity.generation >= identity.generation
        )
      )
        throw new Error("Stale native descendant generation");
      const state = await processIdentity(identity.pid);
      if (!state || state.parentPid !== owner.pid)
        throw new Error("Native descendant ancestry unavailable");
      this.descendants.set(identity.token, {
        identity,
        start: state.start,
        exited: false,
      });
    }
    this.descendantEvents.push(event);
  }

  owns(pid: number): boolean {
    return (
      this.transports.get(pid)?.live() === true ||
      [...this.children].some(
        (child) =>
          child.pid === pid &&
          child.exitCode === null &&
          child.signalCode === null
      )
    );
  }

  async sample(): Promise<void> {
    const pids = [...this.children]
      .filter((child) => child.exitCode === null && child.signalCode === null)
      .map((child) => child.pid);
    for (const [pid, owner] of this.transports)
      if (owner.live() && !pids.includes(pid)) pids.push(pid);
    const nativeIdentities = new Map<number, ChildIdentity>();
    const identityErrors: string[] = [];
    for (const descendant of this.descendants.values()) {
      if (descendant.exited) continue;
      const state = await processIdentity(descendant.identity.pid);
      if (descendant.exited) continue;
      if (
        !state ||
        state.start !== descendant.start ||
        state.parentPid !== descendant.identity.parentPid
      ) {
        identityErrors.push(
          `Native descendant identity unavailable:${descendant.identity.pid}`
        );
        continue;
      }
      if (!pids.includes(descendant.identity.pid))
        pids.push(descendant.identity.pid);
      nativeIdentities.set(descendant.identity.pid, descendant.identity);
    }
    const sample: ResourceSample = {
      elapsedMs: performance.now() - this.started,
      rssBytes: null,
      gpuBytes: null,
      pids,
      errors: identityErrors,
    };
    this.errors.push(...identityErrors);
    try {
      if (!pids.length)
        throw new Error("No live owned PIDs available for resource sampling");
      const result = await telemetry([
        "ps",
        "-o",
        "pid=,rss=",
        "-p",
        pids.join(","),
      ]);
      const rows = result.output
        .trim()
        .split("\n")
        .map((row) => row.trim().split(/\s+/).map(Number));
      if (
        result.exitCode !== 0 ||
        rows.length !== pids.length ||
        rows.some(
          ([pid, rss]) =>
            pid === undefined ||
            !pids.includes(pid) ||
            rss === undefined ||
            !Number.isFinite(rss) ||
            rss <= 0
        )
      )
        throw new Error("Owned PID RSS sample unavailable");
      sample.processes = rows.map(([pid, rss]) => ({
        pid: pid!,
        rssBytes: rss! * 1024,
        ...(nativeIdentities.has(pid!)
          ? { nativeIdentity: nativeIdentities.get(pid!) }
          : {}),
      }));
      sample.rssBytes = identityErrors.length
        ? null
        : sample.processes.reduce((total, item) => total + item.rssBytes, 0);
      if (this.gpu) {
        const gpu = await telemetry([
          "nvidia-smi",
          "--query-compute-apps=pid,used_gpu_memory",
          "--format=csv,noheader,nounits",
        ]);
        if (gpu.exitCode !== 0)
          throw new Error("Owned PID GPU accounting unavailable");
        let total = 0;
        for (const item of sample.processes) item.gpuBytes = 0;

        for (const row of gpu.output.trim().split("\n")) {
          const [pid, mib] = row.split(",").map(Number);
          if (pid !== undefined && pids.includes(pid)) {
            if (mib === undefined || !Number.isFinite(mib) || mib < 0)
              throw new Error("Invalid GPU accounting");

            total += mib * 1024 * 1024;
            const item = sample.processes.find((row) => row.pid === pid);
            if (item) item.gpuBytes = (item.gpuBytes ?? 0) + mib * 1024 * 1024;
          }
        }
        // A successful NVIDIA query with no owned row means zero accounted GPU memory.
        sample.gpuBytes = identityErrors.length ? null : total;
      }
    } catch (error) {
      sample.errors.push(String(error));
      this.errors.push(String(error));
    }
    this.samples.push(sample);
  }

  start(intervalMs = 100): void {
    if (
      this.timer ||
      this.stopped ||
      !Number.isFinite(intervalMs) ||
      intervalMs < 10
    )
      throw new Error("Invalid sampler start");
    this.timer = setInterval(() => {
      if (this.sampling) return;
      this.sampling = true;
      this.pending = this.sample().finally(() => {
        this.sampling = false;
      });
    }, intervalMs);
  }

  async stopSampling(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
  }

  /** Kill only subprocess handles registered by this run; never discovered PIDs. */
  async close(): Promise<void> {
    this.stopped = true;
    await this.stopSampling();
    for (const owner of this.transports.values()) await owner.close();
    for (const child of this.children)
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    await Promise.all([...this.children].map((child) => child.exited));
    // Product disconnect handling owns descendant termination. Never kill a PID
    // discovered through evidence; a surviving owned identity is incomplete QA.
    const deadline = Date.now() + 2500;
    for (const descendant of this.descendants.values()) {
      while (true) {
        const state = await processIdentity(descendant.identity.pid);
        if (!state || state.start !== descendant.start) break;
        if (Date.now() >= deadline) {
          this.errors.push(
            `Owned native descendant survived cleanup:${descendant.identity.pid}`
          );
          break;
        }
        await Bun.sleep(25);
      }
    }
  }
}

async function processIdentity(
  pid: number
): Promise<{ parentPid: number; start: string } | undefined> {
  const result = await telemetry([
    "ps",
    "-o",
    "ppid=,lstart=",
    "-p",
    String(pid),
  ]);
  if (result.exitCode !== 0 || !result.output.trim()) return undefined;
  const [parent, ...start] = result.output.trim().split(/\s+/);
  const parentPid = Number(parent);
  if (!Number.isSafeInteger(parentPid) || !start.length)
    throw new Error("Invalid process identity");
  if (process.platform === "linux") {
    try {
      const value = await Bun.file(`/proc/${pid}/stat`).text();
      const fields = value.slice(value.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z" || Number(fields[1]) !== parentPid || !fields[19])
        return undefined;
      return { parentPid, start: `linux-start-ticks:${fields[19]}` };
    } catch {
      return undefined;
    }
  }
  return { parentPid, start: start.join(" ") };
}
