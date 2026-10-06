/**
 * Process-table sampling for the soak harness: CPU, memory, fds, threads,
 * wakeups and zombie state per process, plus environment-marker lookup so a
 * leftover process is found whatever its parent (fn-203 R2).
 *
 * Linux reads /proc; macOS falls back to `ps` (no fd or wakeup counts).
 *
 * @module scripts/soak/procfs
 */

// node:fs/promises — readdir of /proc and /proc/<pid>/fd has no Bun equivalent
import { readdir } from "node:fs/promises";

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Single-letter state: R, S, D, Z, T, ... */
  state: string;
  /** User + system CPU time in seconds. */
  cpuSeconds: number;
  rssKb: number;
  threads: number;
  /** Open file descriptors (Linux only). */
  fds?: number;
  /** Voluntary + involuntary context switches (Linux only). */
  ctxSwitches?: number;
  command: string;
}

const IS_LINUX = process.platform === "linux";
let clockTicks: number | null = null;

async function ticksPerSecond(): Promise<number> {
  if (clockTicks !== null) return clockTicks;
  const proc = Bun.spawnSync(["getconf", "CLK_TCK"]);
  const parsed = Number.parseInt(proc.stdout.toString().trim(), 10);
  clockTicks = Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
  return clockTicks;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}

async function linuxProc(pid: number, hz: number): Promise<ProcInfo | null> {
  const stat = await readText(`/proc/${pid}/stat`);
  if (!stat) return null;
  const close = stat.lastIndexOf(")");
  const fields = stat.slice(close + 2).split(" ");
  // fields[0] is state (field 3); utime/stime are fields 14/15.
  const state = fields[0] ?? "?";
  const ppid = Number(fields[1]);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  const threads = Number(fields[17]);
  const rssPages = Number(fields[21]);
  const status = (await readText(`/proc/${pid}/status`)) ?? "";
  const field = (name: string): number => {
    const match = status.match(new RegExp(`^${name}:\\s+(\\d+)`, "m"));
    return match ? Number(match[1]) : 0;
  };
  let fds: number | undefined;
  try {
    fds = (await readdir(`/proc/${pid}/fd`)).length;
  } catch {
    fds = undefined;
  }
  const cmdline = (await readText(`/proc/${pid}/cmdline`)) ?? "";
  return {
    pid,
    ppid,
    state,
    cpuSeconds: (utime + stime) / hz,
    rssKb: field("VmRSS") || (rssPages * 4096) / 1024,
    threads,
    fds,
    ctxSwitches:
      field("voluntary_ctxt_switches") + field("nonvoluntary_ctxt_switches"),
    command: cmdline.split("\0").join(" ").trim(),
  };
}

function parseCpuTime(value: string): number {
  // ps TIME: [[dd-]hh:]mm:ss[.ff]
  const [dayPart, rest] = value.includes("-") ? value.split("-") : ["0", value];
  const parts = (rest ?? "0").split(":").map(Number);
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return Number(dayPart) * 86_400 + seconds;
}

/** All processes visible to this user. */
export async function listProcesses(): Promise<ProcInfo[]> {
  if (IS_LINUX) {
    const hz = await ticksPerSecond();
    const entries = await readdir("/proc");
    const infos = await Promise.all(
      entries
        .filter((e) => /^\d+$/.test(e))
        .map((e) => linuxProc(Number(e), hz))
    );
    return infos.filter((info): info is ProcInfo => info !== null);
  }
  const proc = Bun.spawnSync([
    "ps",
    "-axo",
    "pid=,ppid=,stat=,time=,rss=,command=",
  ]);
  const out: ProcInfo[] = [];
  for (const line of proc.stdout.toString().split("\n")) {
    const match = line
      .trim()
      .match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    out.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      state: (match[3] ?? "?").charAt(0),
      cpuSeconds: parseCpuTime(match[4] ?? "0"),
      rssKb: Number(match[5]),
      threads: 1,
      command: match[6] ?? "",
    });
  }
  return out;
}

/** Root pids plus every descendant found in `all`. */
export function treeOf(
  roots: readonly number[],
  all: readonly ProcInfo[]
): ProcInfo[] {
  const children = new Map<number, ProcInfo[]>();
  for (const info of all) {
    const list = children.get(info.ppid) ?? [];
    list.push(info);
    children.set(info.ppid, list);
  }
  const byPid = new Map(all.map((info) => [info.pid, info]));
  const seen = new Set<number>();
  const out: ProcInfo[] = [];
  const stack = [...roots];
  while (stack.length > 0) {
    const pid = stack.pop() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const info = byPid.get(pid);
    if (info) out.push(info);
    for (const child of children.get(pid) ?? []) stack.push(child.pid);
  }
  return out;
}

/** True when the process environment carries `name=value`. */
export async function hasEnvMarker(
  pid: number,
  name: string,
  value: string
): Promise<boolean> {
  const needle = `${name}=${value}`;
  if (IS_LINUX) {
    try {
      const bytes = await Bun.file(`/proc/${pid}/environ`).bytes();
      return new TextDecoder().decode(bytes).split("\0").includes(needle);
    } catch {
      return false;
    }
  }
  // macOS: `ps eww` appends the environment of the user's own processes.
  const proc = Bun.spawnSync([
    "ps",
    "eww",
    "-o",
    "command=",
    "-p",
    String(pid),
  ]);
  return proc.stdout.toString().includes(needle);
}

/**
 * pid -> value of env var `name` for every process that has it. Linux reads
 * each /proc/<pid>/environ; macOS asks `ps -E` once for all processes (the
 * user's own processes show their environment).
 */
export async function markerValues(name: string): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (IS_LINUX) {
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const value = await envValue(Number(entry), name);
      if (value !== null) out.set(Number(entry), value);
    }
    return out;
  }
  const proc = Bun.spawnSync(["ps", "-axwwE", "-o", "pid=,command="]);
  const pattern = new RegExp(`(?:^|\\s)${name}=(\\S+)`);
  for (const line of proc.stdout.toString().split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    const value = match?.[2]?.match(pattern)?.[1];
    if (match && value) out.set(Number(match[1]), value);
  }
  return out;
}

/** Every live process tagged with the run marker, excluding `except`. */
export async function findTagged(
  name: string,
  value: string,
  except: ReadonlySet<number> = new Set()
): Promise<ProcInfo[]> {
  const markers = await markerValues(name);
  return (await listProcesses()).filter(
    (info) =>
      !except.has(info.pid) &&
      info.pid !== process.pid &&
      markers.get(info.pid) === value
  );
}

/** Value of env var `name` in a process, or null (Linux reads environ; macOS uses `ps eww`). */
export async function envValue(
  pid: number,
  name: string
): Promise<string | null> {
  let text: string;
  if (IS_LINUX) {
    try {
      text = new TextDecoder().decode(
        await Bun.file(`/proc/${pid}/environ`).bytes()
      );
    } catch {
      return null;
    }
    for (const entry of text.split("\0")) {
      if (entry.startsWith(`${name}=`)) return entry.slice(name.length + 1);
    }
    return null;
  }
  const proc = Bun.spawnSync([
    "ps",
    "eww",
    "-o",
    "command=",
    "-p",
    String(pid),
  ]);
  const match = proc.stdout
    .toString()
    .match(new RegExp(`(?:^|\\s)${name}=(\\S+)`));
  return match?.[1] ?? null;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
