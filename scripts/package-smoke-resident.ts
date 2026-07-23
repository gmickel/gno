/** Packed-install proof for the resident HTTP MCP and lifecycle boundary. */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// node:fs/promises: POSIX permission changes have no Bun-native equivalent.
import { chmod } from "node:fs/promises";
// node:path: portable temporary-path construction has no Bun-native equivalent.
import { join } from "node:path";

import { assertValid, loadSchema } from "../test/spec/schemas/validator";
import {
  createHttpClient,
  freeLoopbackPort,
  isRecord,
  JSON_HEADERS,
  parseJsonObject,
  type ResidentSmokeInput,
  runExpectedFailure,
  spawnResident,
  stopResident,
  validateStatusSurfaces,
  waitForStatus,
} from "./package-smoke-resident-support";

async function proveLoopbackGateway(input: ResidentSmokeInput): Promise<void> {
  const port = await freeLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const residentProcess = spawnResident(input, "serve", [
    "--port",
    String(port),
  ]);
  const clients: Client[] = [];
  try {
    await waitForStatus(baseUrl, "serve");
    const before = await validateStatusSurfaces(baseUrl, "serve", [
      input.cwd,
      input.env.GNO_DATA_DIR ?? "",
      "package-smoke-secret",
    ]);
    const [first, second] = await Promise.all([
      createHttpClient(baseUrl, "packed-http-a"),
      createHttpClient(baseUrl, "packed-http-b"),
    ]);
    clients.push(first.client, second.client);
    const stdioTransport = new StdioClientTransport({
      command: input.gnoBin,
      args: ["mcp"],
      cwd: input.cwd,
      env: {
        ...input.env,
        PATH: globalThis.process.env.PATH ?? "",
      },
      stderr: "pipe",
    });
    const stdioClient = new Client({
      name: "packed-stdio-parity",
      version: "1.0.0",
    });
    clients.push(stdioClient);
    await stdioClient.connect(stdioTransport);

    const [httpTools, secondTools, stdioTools, httpResources, stdioResources] =
      await Promise.all([
        first.client.listTools(),
        second.client.listTools(),
        stdioClient.listTools(),
        first.client.listResources(),
        stdioClient.listResources(),
      ]);
    if (
      JSON.stringify(httpTools) !== JSON.stringify(secondTools) ||
      JSON.stringify(httpTools) !== JSON.stringify(stdioTools) ||
      JSON.stringify(httpResources) !== JSON.stringify(stdioResources)
    ) {
      throw new Error("Packed stdio and two HTTP clients lost MCP parity");
    }

    const search = {
      name: "gno_search",
      arguments: { query: "Package smoke" },
    };
    const results = await Promise.all([
      first.client.callTool(search),
      second.client.callTool(search),
      stdioClient.callTool(search),
      first.client.callTool(search),
    ]);
    if (
      !results.every(
        (result) => JSON.stringify(result) === JSON.stringify(results[0])
      )
    ) {
      throw new Error("Packed repeated MCP calls returned different results");
    }
    const after = await validateStatusSurfaces(baseUrl, "serve", [
      input.cwd,
      input.env.GNO_DATA_DIR ?? "",
      "package-smoke-secret",
    ]);
    if (
      after.transport.activeSessions < 2 ||
      after.models.loadedModels !== before.models.loadedModels ||
      after.models.loadAttempts !== before.models.loadAttempts ||
      after.models.loadSuccesses !== before.models.loadSuccesses
    ) {
      throw new Error(
        "Packed clients did not reuse one warm resident lifecycle"
      );
    }

    const rejectedHost = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...JSON_HEADERS, host: "attacker.invalid" },
      body: "{}",
    });
    const rejectedOrigin = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        origin: "https://attacker.invalid",
      },
      body: "{}",
    });
    const oversized = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ padding: "x".repeat(1024 * 1024) }),
    });
    if (
      rejectedHost.status !== 403 ||
      rejectedOrigin.status !== 403 ||
      oversized.status !== 413
    ) {
      throw new Error(
        `Packed loopback security drifted: Host=${rejectedHost.status}, Origin=${rejectedOrigin.status}, body=${oversized.status}`
      );
    }
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await stopResident(residentProcess, "packed loopback serve");
  }
}

async function writeToken(path: string, token: string): Promise<void> {
  await Bun.write(path, `${token}\n`);
  if (process.platform !== "win32") await chmod(path, 0o600);
}

async function proveNonLoopbackDaemon(
  input: ResidentSmokeInput
): Promise<void> {
  const port = await freeLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const allowedHost = `127.0.0.1:${port}`;
  const allowedOrigin = baseUrl;
  const tokenFile = join(input.cwd, "resident-token");
  const firstToken = "a".repeat(64);
  const secondToken = "b".repeat(64);
  await writeToken(tokenFile, firstToken);

  const securedArgs = [
    "--port",
    String(port),
    "--host",
    "0.0.0.0",
    "--mcp-token-file",
    tokenFile,
    "--mcp-allowed-host",
    allowedHost,
    "--mcp-allowed-origin",
    allowedOrigin,
    "--no-sync-on-start",
  ];
  runExpectedFailure(
    input,
    [
      input.gnoBin,
      "serve",
      ...securedArgs.filter((arg) => arg !== "--no-sync-on-start"),
    ],
    /serve remains loopback-only/
  );
  runExpectedFailure(
    input,
    [
      input.gnoBin,
      "daemon",
      "--port",
      String(port),
      "--host",
      "0.0.0.0",
      "--mcp-allowed-host",
      allowedHost,
      "--mcp-allowed-origin",
      allowedOrigin,
      "--no-sync-on-start",
    ],
    /requires tokenFile plus exact allowedHosts and allowedOrigins/
  );

  const residentProcess = spawnResident(input, "daemon", securedArgs);
  const clients: Client[] = [];
  try {
    await waitForStatus(baseUrl, "daemon");
    await validateStatusSurfaces(baseUrl, "daemon", [
      input.cwd,
      input.env.GNO_DATA_DIR ?? "",
      firstToken,
      secondToken,
    ]);
    const unauthorized = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        host: allowedHost,
        origin: allowedOrigin,
      },
      body: "{}",
    });
    const wrongToken = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        authorization: "Bearer wrong-token",
        host: allowedHost,
        origin: allowedOrigin,
      },
      body: "{}",
    });
    if (unauthorized.status !== 401 || wrongToken.status !== 401) {
      throw new Error(
        `Packed daemon token security drifted: missing=${unauthorized.status}, wrong=${wrongToken.status}`
      );
    }

    const first = await createHttpClient(baseUrl, "packed-daemon-a", {
      authorization: `Bearer ${firstToken}`,
      origin: allowedOrigin,
    });
    clients.push(first.client);
    const writeError = await first.client
      .callTool({
        name: "gno_capture",
        arguments: { content: "must not be written" },
      })
      .then(
        () => null,
        (error: unknown) => error
      );
    if (!(writeError instanceof Error)) {
      throw new Error(
        "Packed bearer authentication incorrectly granted writes"
      );
    }

    await writeToken(tokenFile, secondToken);
    const staleSession = await first.client.listTools().then(
      () => null,
      (error: unknown) => error
    );
    if (!(staleSession instanceof Error)) {
      throw new Error("Packed token rotation did not revoke the old session");
    }
    const second = await createHttpClient(baseUrl, "packed-daemon-b", {
      authorization: `Bearer ${secondToken}`,
      origin: allowedOrigin,
    });
    clients.push(second.client);
    await second.client.listTools();
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await stopResident(residentProcess, "packed secured daemon");
  }
}

async function proveDetachedStatus(
  input: ResidentSmokeInput,
  kind: "serve" | "daemon",
  restart: boolean
): Promise<void> {
  if (process.platform === "win32") {
    console.warn(
      `Packed ${kind} --detach status skipped: detached mode is unsupported on Windows.`
    );
    return;
  }
  const cycles = restart ? 2 : 1;
  let previousPid: number | null = null;
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const port = await freeLoopbackPort();
    const pidFile = join(input.cwd, `${kind}-${cycle}.pid`);
    const logFile = join(input.cwd, `${kind}-${cycle}.log`);
    input.runCommand(
      [
        input.gnoBin,
        kind,
        "--detach",
        "--port",
        String(port),
        "--pid-file",
        pidFile,
        "--log-file",
        logFile,
        ...(kind === "daemon" ? ["--no-sync-on-start"] : []),
      ],
      input.cwd,
      input.env
    );
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForStatus(baseUrl, kind);
    const status = parseJsonObject(
      input.runCommand(
        [
          input.gnoBin,
          kind,
          "--status",
          "--json",
          "--pid-file",
          pidFile,
          "--log-file",
          logFile,
        ],
        input.cwd,
        input.env
      ).stdout,
      `gno ${kind} --status --json`
    );
    assertValid(status, await loadSchema("process-status"));
    if (
      status.running !== true ||
      !isRecord(status.resident) ||
      status.resident.mode !== kind ||
      status.resident.resident !== true
    ) {
      throw new Error(`Packed ${kind} status missed its resident snapshot`);
    }
    if (
      previousPid !== null &&
      typeof status.pid === "number" &&
      status.pid === previousPid
    ) {
      throw new Error(`Packed ${kind} restart reused the old process`);
    }
    previousPid = typeof status.pid === "number" ? status.pid : null;
    input.runCommand(
      [
        input.gnoBin,
        kind,
        "--stop",
        "--pid-file",
        pidFile,
        "--log-file",
        logFile,
      ],
      input.cwd,
      input.env
    );
  }
}

export async function verifyPackedResidentGateway(
  input: ResidentSmokeInput
): Promise<void> {
  await proveLoopbackGateway(input);
  await proveNonLoopbackDaemon(input);
  await proveDetachedStatus(input, "serve", true);
  await proveDetachedStatus(input, "daemon", false);
}
