/**
 * Resident lifecycle helpers for the soak harness: start `gno serve` or
 * `gno daemon` in the sandbox, wait for readiness, probe status, and stop it
 * with a measured signal.
 *
 * @module scripts/soak/gno
 */

// node:path — Bun has no path utilities
import { join } from "node:path";

import { isAlive } from "./procfs";
import { gnoCmd, type Sandbox, spawnTagged } from "./sandbox";

export type ResidentMode = "serve" | "daemon";

export interface Resident {
  mode: ResidentMode;
  pid: number;
  port: number;
  baseUrl: string;
  logFile: string;
  proc: ReturnType<typeof spawnTagged>;
  startedAt: number;
}

export async function startResident(
  sandbox: Sandbox,
  options: {
    mode?: ResidentMode;
    port: number;
    args?: string[];
    label?: string;
  }
): Promise<Resident> {
  const mode = options.mode ?? "serve";
  const logFile = join(
    sandbox.logDir,
    `${options.label ?? mode}-${Date.now()}.log`
  );
  const proc = spawnTagged(
    sandbox,
    gnoCmd(
      mode,
      "--host",
      "127.0.0.1",
      "--port",
      String(options.port),
      ...(options.args ?? [])
    ),
    { logFile }
  );
  const resident: Resident = {
    mode,
    pid: proc.pid,
    port: options.port,
    baseUrl: `http://127.0.0.1:${options.port}`,
    logFile,
    proc,
    startedAt: Date.now(),
  };
  await waitReady(resident, 120_000);
  return resident;
}

export async function waitReady(
  resident: Resident,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(resident.pid)) {
      const log = await Bun.file(resident.logFile)
        .text()
        .catch(() => "");
      throw new Error(`resident exited during startup:\n${log.slice(-2000)}`);
    }
    const probe = await probeStatus(resident, 2_000);
    if (probe.ok) return;
    await Bun.sleep(250);
  }
  throw new Error(`resident not ready within ${timeoutMs} ms`);
}

export interface StatusProbe {
  ok: boolean;
  ms: number;
  status?: number;
  error?: string;
}

export async function probeStatus(
  resident: Resident,
  timeoutMs = 8_000
): Promise<StatusProbe> {
  const started = performance.now();
  try {
    const response = await fetch(`${resident.baseUrl}/api/resident/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.arrayBuffer();
    return {
      ok: response.ok,
      ms: performance.now() - started,
      status: response.status,
    };
  } catch (error) {
    return {
      ok: false,
      ms: performance.now() - started,
      error: error instanceof Error ? error.name : String(error),
    };
  }
}

export async function getJson<T = Record<string, unknown>>(
  resident: Resident,
  path: string,
  timeoutMs = 10_000
): Promise<T | null> {
  try {
    const response = await fetch(`${resident.baseUrl}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export async function postJson<T = Record<string, unknown>>(
  resident: Resident,
  path: string,
  body: unknown,
  timeoutMs = 30_000
): Promise<{ status: number; body: T | null }> {
  try {
    const response = await fetch(`${resident.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const parsed = (await response.json().catch(() => null)) as T | null;
    return { status: response.status, body: parsed };
  } catch {
    return { status: 0, body: null };
  }
}

export interface StopResult {
  signal: NodeJS.Signals;
  exitMs: number | null;
  exitCode: number | null;
  /** True when the harness had to SIGKILL after the budget. */
  escalated: boolean;
}

/** Send `signal`, wait up to `budgetMs`, escalate to SIGKILL after. */
export async function stopResident(
  resident: Resident,
  signal: NodeJS.Signals,
  budgetMs: number
): Promise<StopResult> {
  const started = performance.now();
  try {
    process.kill(resident.pid, signal);
  } catch {
    return {
      signal,
      exitMs: 0,
      exitCode: resident.proc.exitCode,
      escalated: false,
    };
  }
  const exited = await Promise.race([
    resident.proc.exited.then(() => true),
    Bun.sleep(budgetMs).then(() => false),
  ]);
  if (exited) {
    return {
      signal,
      exitMs: performance.now() - started,
      exitCode: resident.proc.exitCode,
      escalated: false,
    };
  }
  resident.proc.kill("SIGKILL");
  await resident.proc.exited;
  return {
    signal,
    exitMs: null,
    exitCode: resident.proc.exitCode,
    escalated: true,
  };
}

/** Resident lock and pid paths inside the sandbox data dir. */
export function residentPaths(sandbox: Sandbox, index = "default") {
  return {
    writeLock: join(sandbox.dataDir, ".mcp-write.lock"),
    ownerLock: join(sandbox.dataDir, ".resident-owner.lock"),
    db: join(sandbox.dataDir, `index-${index}.sqlite`),
    servePid: join(sandbox.dataDir, "serve.pid"),
    daemonPid: join(sandbox.dataDir, "daemon.pid"),
  };
}
