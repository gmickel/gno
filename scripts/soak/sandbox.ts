/**
 * Sealed sandbox for a soak run: its own HOME, XDG and GNO directories,
 * offline model policy, and a run marker in every child's environment so
 * teardown can find anything left behind (fn-203 R1, R2).
 *
 * @module scripts/soak/sandbox
 */

// node:fs/promises — mkdir/mkdtemp/rm are directory-structure ops
import { mkdir, mkdtemp, rm } from "node:fs/promises";
// node:os — tmpdir has no Bun equivalent
import { tmpdir } from "node:os";
// node:path — Bun has no path utilities
import { join, resolve } from "node:path";

import { findTagged, isAlive, type ProcInfo } from "./procfs";

export const RUN_MARKER = "GNO_SOAK_RUN";
export const REPO_ROOT = resolve(import.meta.dir, "../..");
export const GNO_ENTRY = join(REPO_ROOT, "src/index.ts");

export interface Sandbox {
  runId: string;
  root: string;
  home: string;
  configDir: string;
  dataDir: string;
  cacheDir: string;
  corpusDir: string;
  logDir: string;
  env: Record<string, string>;
  /** Pids the harness itself manages (excluded from orphan sweeps while live). */
  owned: Set<number>;
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: "pipe" | "ignore";
  /** File to append stdout+stderr to; default: ignore. */
  logFile?: string;
  detached?: boolean;
}

export async function createSandbox(
  runId: string,
  keepRoot?: string
): Promise<Sandbox> {
  const root =
    keepRoot ?? (await mkdtemp(join(tmpdir(), `gno-soak-${runId}-`)));
  const dirs = {
    home: join(root, "home"),
    configDir: join(root, "config"),
    dataDir: join(root, "data"),
    cacheDir: join(root, "cache"),
    corpusDir: join(root, "corpus"),
    logDir: join(root, "logs"),
  };
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  // Only PATH and the bun location survive from the parent environment;
  // nothing else of the user's setup leaks in.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: dirs.home,
    XDG_CONFIG_HOME: join(dirs.home, ".config"),
    XDG_DATA_HOME: join(dirs.home, ".local/share"),
    XDG_CACHE_HOME: join(dirs.home, ".cache"),
    XDG_STATE_HOME: join(dirs.home, ".local/state"),
    GNO_CONFIG_DIR: dirs.configDir,
    GNO_DATA_DIR: dirs.dataDir,
    GNO_CACHE_DIR: dirs.cacheDir,
    GNO_OFFLINE: "1",
    HF_HUB_OFFLINE: "1",
    NO_COLOR: "1",
    TMPDIR: join(root, "tmp"),
    [RUN_MARKER]: runId,
  };
  await mkdir(env.TMPDIR as string, { recursive: true });
  return { runId, root, ...dirs, env, owned: new Set() };
}

/** Spawn a process carrying the run marker. */
export function spawnTagged(
  sandbox: Sandbox,
  cmd: string[],
  options: SpawnOptions = {}
): Bun.Subprocess<"pipe" | "ignore", "pipe" | "ignore", "pipe" | "ignore"> {
  const log = options.logFile ? Bun.file(options.logFile) : null;
  const proc = Bun.spawn({
    cmd,
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...sandbox.env, ...options.env },
    stdin: options.stdin ?? "ignore",
    stdout: log ?? "ignore",
    stderr: log ?? "ignore",
    detached: options.detached ?? false,
  });
  sandbox.owned.add(proc.pid);
  void proc.exited.then(() => sandbox.owned.delete(proc.pid));
  return proc as never;
}

/** `bun src/index.ts <args>` inside the sandbox. */
export function gnoCmd(...args: string[]): string[] {
  return [process.execPath, GNO_ENTRY, ...args];
}

/** Run a gno CLI command to completion and capture its output. */
export async function runGno(
  sandbox: Sandbox,
  args: string[],
  options: { timeoutMs?: number; env?: Record<string, string> } = {}
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
}> {
  const started = performance.now();
  const proc = Bun.spawn({
    cmd: gnoCmd(...args),
    cwd: REPO_ROOT,
    env: { ...sandbox.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  sandbox.owned.add(proc.pid);
  let timedOut = false;
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, options.timeoutMs)
    : null;
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timer) clearTimeout(timer);
  sandbox.owned.delete(proc.pid);
  return { code, stdout, stderr, ms: performance.now() - started, timedOut };
}

/** Processes still carrying this run's marker that the harness did not expect. */
export async function sweepTagged(sandbox: Sandbox): Promise<ProcInfo[]> {
  return await findTagged(RUN_MARKER, sandbox.runId);
}

/** Kill every tagged process (teardown). Returns what was found first. */
export async function killAllTagged(sandbox: Sandbox): Promise<ProcInfo[]> {
  const found = await sweepTagged(sandbox);
  for (const info of found) {
    try {
      process.kill(info.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && found.some((info) => isAlive(info.pid))) {
    await Bun.sleep(100);
  }
  return found;
}

/** True when `path` can be locked right now without waiting (lockf/flock). */
export function lockIsFree(path: string): boolean {
  const lockf = Bun.which("lockf");
  if (lockf) {
    return Bun.spawnSync([lockf, "-t", "0", path, "true"]).exitCode === 0;
  }
  const flock = Bun.which("flock");
  if (flock) {
    return Bun.spawnSync([flock, "-n", path, "true"]).exitCode === 0;
  }
  return true;
}

/** Hold a file lock from a separate tagged process until released. */
export function holdLock(
  sandbox: Sandbox,
  path: string
): { release: () => Promise<void> } {
  const tool = Bun.which("lockf") ? "lockf" : "flock";
  const cmd =
    tool === "lockf"
      ? ["lockf", "-k", path, "sh", "-c", "read _"]
      : ["flock", path, "sh", "-c", "read _"];
  const proc = spawnTagged(sandbox, cmd, { stdin: "pipe" });
  return {
    release: async () => {
      try {
        (proc.stdin as unknown as { end(): void }).end();
      } catch {
        proc.kill("SIGTERM");
      }
      await proc.exited;
    },
  };
}

export async function portIsFree(port: number): Promise<boolean> {
  try {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: { data() {} },
    });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** A free loopback port (may race, good enough for one harness run). */
export function freePort(): number {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const { port } = server;
  server.stop(true);
  return port;
}

export async function removeSandbox(sandbox: Sandbox): Promise<void> {
  await rm(sandbox.root, { recursive: true, force: true });
}
