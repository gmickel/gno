/** Shared process, HTTP-client, and schema helpers for packed resident smoke. */

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import { assertValid, loadSchema } from "../test/spec/schemas/validator";

interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  cmd: string[],
  cwd: string,
  env: Record<string, string>
) => CommandResult;

export interface ResidentStatus {
  schemaVersion: "1.0";
  mode: "serve" | "daemon";
  resident: true;
  listenerPort: number;
  admission: { state: string; activeRequests: number };
  shutdown: { state: string };
  transport: {
    activeRequests: number;
    activeSessions: number;
    queuedRequests: number;
    maxConcurrentRequests: number;
    maxQueuedRequests: number;
    maxSessions: number;
  };
  readers: { active: number; queued: number; limit: number; maxQueued: number };
  models: {
    activeLeases: number;
    leaseAcquisitions: number;
    leaseReleases: number;
    loadedModels: number;
    loadAttempts: number;
    loadSuccesses: number;
    loadFailures: number;
    inflightLoads: number;
  };
  jobs: { active: number; recent: number; failed: number };
  generations: { content: number; index: number };
}

export interface RunningProcess {
  child: ReturnType<typeof Bun.spawn>;
  stdout: Promise<string>;
  stderr: Promise<string>;
}

export interface ResidentSmokeInput {
  gnoBin: string;
  packageRoot: string;
  cwd: string;
  env: Record<string, string>;
  fixtureDir: string;
  runCommand: CommandRunner;
  embeddingModelPath?: string;
}

export const JSON_HEADERS = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};
const START_TIMEOUT_MS = 60_000;
// Resident disposal can spend up to two 5s admission-drain windows before
// releasing model resources. Linux CI needs headroom beyond that product
// deadline, especially after a model-backed smoke run.
export const STOP_TIMEOUT_MS = 30_000;
// Match `gno serve --stop`: SIGKILL is a successful stop, not a smoke failure.
// Wait long enough for the kernel to reap after the forced kill.
export const STOP_KILL_WAIT_MS = 5_000;
const STOP_POLL_MS = 100;
const STOP_OUTPUT_DRAIN_MS = 1_000;

function isResidentProcessRunning(child: RunningProcess["child"]): boolean {
  if (child.exitCode !== null || child.signalCode !== null) {
    return false;
  }
  const pid = child.pid;
  if (typeof pid !== "number") {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForResidentExit(
  child: RunningProcess["child"],
  timeoutMs: number
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      return child.exitCode;
    }
    if (!isResidentProcessRunning(child)) {
      return child.exitCode;
    }
    await Promise.race([child.exited, Bun.sleep(STOP_POLL_MS)]);
  }
  return child.exitCode;
}

async function collectResidentOutput(
  residentProcess: RunningProcess,
  stillRunning: boolean
): Promise<{ stdout: string; stderr: string }> {
  if (stillRunning) {
    return { stdout: "", stderr: "" };
  }
  return Promise.race([
    Promise.all([residentProcess.stdout, residentProcess.stderr]).then(
      ([stdout, stderr]) => ({ stdout, stderr })
    ),
    Bun.sleep(STOP_OUTPUT_DRAIN_MS).then(() => ({ stdout: "", stderr: "" })),
  ]);
}

export function isExpectedResidentShutdownExit(
  platform: NodeJS.Platform,
  exitCode: number
): boolean {
  if (platform === "win32") return exitCode === 130;
  return exitCode === 143;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonObject(
  value: string,
  label: string
): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (isRecord(parsed)) return parsed;
  } catch {
    // Fall through to the stable diagnostic.
  }
  throw new Error(`${label} did not return a JSON object:\n${value}`);
}

export async function freeLoopbackPort(): Promise<number> {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("port probe"),
  });
  const port = probe.port;
  await probe.stop(true);
  if (port === undefined) {
    throw new Error("Bun did not allocate a loopback smoke port");
  }
  return port;
}

export function spawnResident(
  input: ResidentSmokeInput,
  command: "serve" | "daemon",
  args: string[]
): RunningProcess {
  const child = Bun.spawn([input.gnoBin, command, ...args], {
    cwd: input.cwd,
    env: { ...input.env, NODE_ENV: "production" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    child,
    stdout: new Response(child.stdout).text(),
    stderr: new Response(child.stderr).text(),
  };
}

export async function waitForStatus(
  baseUrl: string,
  expectedMode: "serve" | "daemon",
  residentProcess?: RunningProcess,
  headers?: HeadersInit
): Promise<ResidentStatus> {
  const startedAt = performance.now();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const processState = residentProcess;
    if (processState && processState.child.exitCode !== null) {
      const [stdout, stderr] = await Promise.all([
        processState.stdout,
        processState.stderr,
      ]);
      throw new Error(
        `Packed ${expectedMode} exited ${processState.child.exitCode} before listener readiness after ${Math.round(performance.now() - startedAt)}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`
      );
    }
    try {
      const response = await fetch(`${baseUrl}/api/resident/status`, {
        headers,
      });
      if (response.ok) {
        const value: unknown = await response.json();
        if (
          isRecord(value) &&
          value.schemaVersion === "1.0" &&
          value.mode === expectedMode &&
          value.resident === true
        ) {
          return value as unknown as ResidentStatus;
        }
      } else {
        await response.body?.cancel();
      }
    } catch {
      // Process is still opening the listener.
    }
    await Bun.sleep(100);
  }
  throw new Error(
    `Timed out after ${Math.round(performance.now() - startedAt)}ms waiting for packed ${expectedMode} listener readiness at ${baseUrl}; process=${residentProcess?.child.exitCode ?? "running"}`
  );
}

export async function stopResident(
  residentProcess: RunningProcess,
  label: string,
  timeoutMs = STOP_TIMEOUT_MS,
  killWaitMs = STOP_KILL_WAIT_MS
): Promise<void> {
  const { child } = residentProcess;
  let forcedKill = false;
  if (isResidentProcessRunning(child)) {
    child.kill("SIGTERM");
  }

  let exitCode = await waitForResidentExit(child, timeoutMs);
  if (exitCode === null && isResidentProcessRunning(child)) {
    forcedKill = true;
    child.kill("SIGKILL");
    exitCode = await waitForResidentExit(child, killWaitMs);
  }

  const stillRunning = exitCode === null && isResidentProcessRunning(child);
  const { stdout, stderr } = await collectResidentOutput(
    residentProcess,
    stillRunning
  );
  if (stillRunning) {
    throw new Error(
      `${label} did not exit after SIGTERM (${String(timeoutMs)}ms) + SIGKILL (${String(killWaitMs)}ms)\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
  }

  const resolvedExit = exitCode ?? child.exitCode ?? (forcedKill ? 137 : 0);
  if (stdout || stderr) {
    console.warn(
      `${label} process output\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
  }
  if (forcedKill) {
    console.warn(
      `${label} required SIGKILL after ${String(timeoutMs)}ms SIGTERM (exit ${String(resolvedExit)}).`
    );
    return;
  }
  const expectedSignalExit = isExpectedResidentShutdownExit(
    process.platform,
    resolvedExit
  );
  if (resolvedExit !== 0 && !expectedSignalExit) {
    throw new Error(
      `${label} exited ${String(resolvedExit)}\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
  }
  if (expectedSignalExit) {
    console.warn(
      `Packed resident shutdown completed with platform signal exit ${String(resolvedExit)}.`
    );
  }
}

export function runExpectedFailure(
  input: ResidentSmokeInput,
  cmd: string[],
  expected: RegExp
): void {
  const result = Bun.spawnSync(cmd, {
    cwd: input.cwd,
    env: { ...input.env, NODE_ENV: "production" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString() ?? "";
  if (result.exitCode === 0 || !expected.test(`${stdout}\n${stderr}`)) {
    throw new Error(
      `Expected command to fail with ${expected}: ${cmd.join(" ")}\nexit ${result.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
  }
}

export async function validateStatusSurfaces(
  baseUrl: string,
  expectedMode: "serve" | "daemon",
  forbiddenValues: string[]
): Promise<ResidentStatus> {
  const [residentResponse, statusResponse] = await Promise.all([
    fetch(`${baseUrl}/api/resident/status`),
    fetch(`${baseUrl}/api/status`),
  ]);
  // The shared schema helper initializes one AJV registry; load serially.
  const residentSchema = await loadSchema("resident-status");
  const statusSchema = await loadSchema("status");
  if (!(residentResponse.ok && statusResponse.ok)) {
    throw new Error(
      `Packed status endpoints failed: resident=${residentResponse.status}, status=${statusResponse.status}`
    );
  }
  const resident: unknown = await residentResponse.json();
  const status: unknown = await statusResponse.json();
  assertValid(resident, residentSchema);
  assertValid(status, statusSchema);
  const embeddedResident = isRecord(status) ? status.resident : null;
  if (
    !isRecord(resident) ||
    resident.mode !== expectedMode ||
    resident.resident !== true ||
    !isRecord(embeddedResident) ||
    embeddedResident.schemaVersion !== resident.schemaVersion ||
    embeddedResident.mode !== resident.mode ||
    embeddedResident.resident !== resident.resident ||
    embeddedResident.listenerPort !== resident.listenerPort ||
    !isRecord(embeddedResident.admission) ||
    !isRecord(resident.admission) ||
    embeddedResident.admission.state !== resident.admission.state ||
    !isRecord(embeddedResident.shutdown) ||
    !isRecord(resident.shutdown) ||
    embeddedResident.shutdown.state !== resident.shutdown.state
  ) {
    throw new Error("Packed status endpoints disagree on resident lifecycle");
  }
  const serializedResident = JSON.stringify(resident);
  for (const forbidden of forbiddenValues) {
    if (serializedResident.includes(forbidden)) {
      throw new Error("Packed resident status leaked sensitive state");
    }
  }
  return resident as unknown as ResidentStatus;
}

export async function validateResidentStatusSurface(
  baseUrl: string,
  expectedMode: "serve" | "daemon",
  forbiddenValues: string[],
  headers?: HeadersInit
): Promise<ResidentStatus> {
  const response = await fetch(`${baseUrl}/api/resident/status`, { headers });
  if (!response.ok) {
    throw new Error(
      `Packed resident status endpoint failed: ${response.status}`
    );
  }
  const resident: unknown = await response.json();
  assertValid(resident, await loadSchema("resident-status"));
  if (
    !isRecord(resident) ||
    resident.mode !== expectedMode ||
    resident.resident !== true
  ) {
    throw new Error("Packed resident status returned the wrong lifecycle");
  }
  const serialized = JSON.stringify(resident);
  for (const forbidden of forbiddenValues) {
    if (serialized.includes(forbidden)) {
      throw new Error("Packed resident status leaked sensitive state");
    }
  }
  return resident as unknown as ResidentStatus;
}

export function residentOwnershipState(status: ResidentStatus): object {
  return {
    admission: status.admission,
    shutdown: status.shutdown,
    transport: status.transport,
    readers: status.readers,
    models: status.models,
    jobs: status.jobs,
    generations: status.generations,
  };
}

/**
 * Accept settled warm reuse and one recovery load after a prior failed warmup.
 * Reject inconsistent counters, more than one recovery load, new failures,
 * unbalanced leases, or leftover active/inflight state.
 */
export function isValidPackedWarmModelReuse(
  before: ResidentStatus["models"],
  after: ResidentStatus["models"],
  expectedLeaseCount: number
): boolean {
  const beforeSettled =
    before.loadedModels === 1 &&
    before.loadSuccesses >= 1 &&
    before.loadAttempts === before.loadSuccesses + before.loadFailures &&
    before.activeLeases === 0 &&
    before.leaseAcquisitions === before.leaseReleases &&
    before.inflightLoads === 0;
  const beforeRecoverable =
    before.loadedModels === 0 &&
    before.loadSuccesses === 0 &&
    before.loadAttempts === before.loadFailures &&
    before.loadFailures >= 1 &&
    before.activeLeases === 0 &&
    before.leaseAcquisitions === before.leaseReleases &&
    before.inflightLoads === 0;
  if (!(beforeSettled || beforeRecoverable)) return false;

  const acquired = after.leaseAcquisitions - before.leaseAcquisitions;
  const released = after.leaseReleases - before.leaseReleases;
  const expectedLoadDelta = beforeRecoverable ? 1 : 0;
  return (
    after.loadedModels === 1 &&
    after.loadAttempts === before.loadAttempts + expectedLoadDelta &&
    after.loadSuccesses === before.loadSuccesses + expectedLoadDelta &&
    after.loadFailures === before.loadFailures &&
    acquired === expectedLeaseCount &&
    released === acquired &&
    after.activeLeases === 0 &&
    after.leaseAcquisitions === after.leaseReleases &&
    after.inflightLoads === 0
  );
}

export async function proveResidentUnaffectedByDirectSetup(
  input: ResidentSmokeInput,
  baseUrl: string
): Promise<void> {
  const forbidden = [
    input.cwd,
    input.env.GNO_DATA_DIR ?? "",
    "package-smoke-secret",
  ];
  const before = await validateResidentStatusSurface(
    baseUrl,
    "serve",
    forbidden
  );
  const result = parseJsonObject(
    input.runCommand(
      [
        input.gnoBin,
        "setup",
        input.fixtureDir,
        "--name",
        "package-smoke",
        "--no-semantic",
        "--json",
      ],
      input.cwd,
      input.env
    ).stdout,
    "resident-running direct setup"
  );
  assertValid(result, await loadSchema("setup-command-result"));
  if (
    result.status !== "completed" ||
    !isRecord(result.semantic) ||
    result.semantic.status !== "skipped" ||
    result.semantic.pid !== null
  ) {
    throw new Error("Direct setup did not remain standalone beside a resident");
  }
  const after = await validateResidentStatusSurface(
    baseUrl,
    "serve",
    forbidden
  );
  if (
    JSON.stringify(residentOwnershipState(after)) !==
    JSON.stringify(residentOwnershipState(before))
  ) {
    throw new Error(
      "Direct setup attached to or enqueued work in the resident runtime"
    );
  }
}

export async function createHttpClient(
  baseUrl: string,
  name: string,
  headers: Record<string, string> = {}
): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
}> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    { requestInit: { headers } }
  );
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}
