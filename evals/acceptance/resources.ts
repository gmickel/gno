/** Owned-process telemetry only. RSS and GPU accounting are never summed. */
import type { Subprocess } from "bun";

export interface ResourceSample {
  elapsedMs: number;
  rssBytes: number | null;
  gpuBytes: number | null;
  pids: number[];
  errors: string[];
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

  owns(pid: number): boolean {
    return [...this.children].some(
      (child) =>
        child.pid === pid &&
        child.exitCode === null &&
        child.signalCode === null
    );
  }

  async sample(): Promise<void> {
    const pids = [...this.children]
      .filter((child) => child.exitCode === null && child.signalCode === null)
      .map((child) => child.pid);
    const sample: ResourceSample = {
      elapsedMs: performance.now() - this.started,
      rssBytes: null,
      gpuBytes: null,
      pids,
      errors: [],
    };
    try {
      if (!pids.length)
        throw new Error("No live owned PIDs available for resource sampling");
      const result = await telemetry([
        "ps",
        "-o",
        "rss=",
        "-p",
        pids.join(","),
      ]);
      const rows = result.output.trim().split(/\s+/).map(Number);
      if (
        result.exitCode !== 0 ||
        rows.length !== pids.length ||
        rows.some((n) => !Number.isFinite(n) || n <= 0)
      )
        throw new Error("Owned PID RSS sample unavailable");
      sample.rssBytes = rows.reduce((a, b) => a + b, 0) * 1024;
      if (this.gpu) {
        const gpu = await telemetry([
          "nvidia-smi",
          "--query-compute-apps=pid,used_gpu_memory",
          "--format=csv,noheader,nounits",
        ]);
        if (gpu.exitCode !== 0)
          throw new Error("Owned PID GPU accounting unavailable");
        let total = 0;

        for (const row of gpu.output.trim().split("\n")) {
          const [pid, mib] = row.split(",").map(Number);
          if (pid !== undefined && pids.includes(pid)) {
            if (mib === undefined || !Number.isFinite(mib) || mib < 0)
              throw new Error("Invalid GPU accounting");

            total += mib * 1024 * 1024;
          }
        }
        // A successful NVIDIA query with no owned row means zero accounted GPU memory.
        sample.gpuBytes = total;
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
    for (const child of this.children)
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    await Promise.all([...this.children].map((child) => child.exited));
  }
}
