/** Shared process, HTTP-client, and schema helpers for packed resident smoke. */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

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
const START_TIMEOUT_MS = 15_000;

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
  expectedMode: "serve" | "daemon"
): Promise<ResidentStatus> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/resident/status`);
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
  throw new Error(`Timed out waiting for packed ${expectedMode} at ${baseUrl}`);
}

export async function stopResident(
  residentProcess: RunningProcess,
  label: string
): Promise<void> {
  if (residentProcess.child.exitCode === null) {
    residentProcess.child.kill("SIGTERM");
  }
  const exitCode = await Promise.race([
    residentProcess.child.exited,
    Bun.sleep(10_000).then(() => {
      residentProcess.child.kill("SIGKILL");
      throw new Error(`${label} did not exit within 10 seconds`);
    }),
  ]);
  const [stdout, stderr] = await Promise.all([
    residentProcess.stdout,
    residentProcess.stderr,
  ]);
  const expectedSignalExit = isExpectedResidentShutdownExit(
    process.platform,
    exitCode
  );
  if (exitCode !== 0 && !expectedSignalExit) {
    throw new Error(
      `${label} exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
  }
  if (expectedSignalExit) {
    console.warn(
      `Packed resident shutdown completed with platform signal exit ${exitCode}.`
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
  forbiddenValues: string[]
): Promise<ResidentStatus> {
  const response = await fetch(`${baseUrl}/api/resident/status`);
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
