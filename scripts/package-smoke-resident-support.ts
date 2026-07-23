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
  transport: { activeSessions: number };
  models: {
    loadedModels: number;
    loadAttempts: number;
    loadSuccesses: number;
  };
}

export interface RunningProcess {
  child: ReturnType<typeof Bun.spawn>;
  stdout: Promise<string>;
  stderr: Promise<string>;
}

export interface ResidentSmokeInput {
  gnoBin: string;
  cwd: string;
  env: Record<string, string>;
  runCommand: CommandRunner;
}

export const JSON_HEADERS = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};
const START_TIMEOUT_MS = 15_000;

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
    env: { ...process.env, ...input.env, NODE_ENV: "production" },
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
  const windowsSignalExit = process.platform === "win32" && exitCode === 130;
  if (exitCode !== 0 && !windowsSignalExit) {
    throw new Error(
      `${label} exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
  }
  if (windowsSignalExit) {
    console.warn(
      "Packed resident shutdown observed Bun's known Windows SIGINT/exit-130 limitation."
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
    env: { ...process.env, ...input.env, NODE_ENV: "production" },
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
  if (
    !isRecord(resident) ||
    resident.mode !== expectedMode ||
    resident.resident !== true ||
    !isRecord(status) ||
    JSON.stringify(status.resident) !== JSON.stringify(resident)
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
