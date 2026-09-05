/** Drives owned CLI, stdio/resident MCP and REST processes; never a live vault. */
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
// Bun has no directory creation or canonical path equivalent.
import { lstat, mkdir, realpath } from "node:fs/promises";
// Bun has no path manipulation API.
import { dirname, join } from "node:path";

import type { AskResult, SearchResults } from "../../src/pipeline/types";
import type { ChildEvent } from "./child-receipt";
import type {
  AdapterRequest,
  AdapterResult,
  EvidenceReader,
} from "./native-adapter";
import type { NativeCapture } from "./native-capture";

import {
  assertPackageSmokePathContained,
  buildPackageSmokeProcessEnv,
} from "../../scripts/package-smoke-isolation";
import { projectAcceptance } from "./native-adapter";
import { OwnedResources } from "./resources";

export interface SurfaceLaunch {
  /** Entrypoint and arguments after `bun --preload native-capture.ts`. */
  args: string[];
  cwd: string;
  isolatedRoot: string;
  env: Record<string, string>;
  /** Unique private temporary path; contains exact synthetic model inputs. */
  capturePath: string;
  timeoutMs?: number;
}
export type SurfaceInvocation =
  | { surface: "cli" }
  | {
      surface: "mcp";
      transport?: "stdio";
      tool: string;
      arguments: Record<string, unknown>;
    }
  | {
      surface: "mcp";
      transport: "http";
      url: string;
      tool: string;
      arguments: Record<string, unknown>;
    }
  | { surface: "api"; url: string; body: Record<string, unknown> };

function parseOutput(value: unknown): SearchResults | AskResult {
  if (!value || typeof value !== "object")
    throw new Error("Surface returned non-object output");
  const object = value as Record<string, unknown>;
  if (
    !Array.isArray(object.results) ||
    !object.meta ||
    typeof object.meta !== "object"
  )
    throw new Error("Surface omitted results/meta");
  return value as SearchResults | AskResult;
}

async function isolatedEnv(
  launch: SurfaceLaunch
): Promise<Record<string, string>> {
  await assertPackageSmokePathContained(
    launch.isolatedRoot,
    launch.capturePath,
    "capture"
  );
  const directory = dirname(launch.capturePath);
  await mkdir(directory, { recursive: true });
  const env: Record<string, string> = { GNO_NO_AUTO_DOWNLOAD: "1" };
  for (const [key, name] of Object.entries({
    HOME: "home",
    XDG_CONFIG_HOME: "config",
    XDG_DATA_HOME: "data",
    XDG_CACHE_HOME: "cache",
    GNO_CONFIG_DIR: "config/gno",
    GNO_DATA_DIR: "data/gno",
    GNO_CACHE_DIR: "cache/gno",
    GNO_SKILLS_HOME_OVERRIDE: "skills/home",
    CLAUDE_SKILLS_DIR: "skills/claude",
    CODEX_SKILLS_DIR: "skills/codex",
    OPENCODE_SKILLS_DIR: "skills/opencode",
    OPENCLAW_SKILLS_DIR: "skills/openclaw",
    HERMES_SKILLS_DIR: "skills/hermes",
    APPDATA: "appdata",
    LOCALAPPDATA: "localappdata",
    USERPROFILE: "home",
    TEMP: "tmp",
    TMP: "tmp",
    TMPDIR: "tmp",
    npm_config_cache: "npm/cache",
    npm_config_prefix: "npm/prefix",
    npm_config_userconfig: "npm/config",
  })) {
    env[key] = launch.env[key] ?? join(directory, name);
    await assertPackageSmokePathContained(launch.isolatedRoot, env[key], key);
    if (key !== "npm_config_userconfig")
      await mkdir(env[key], { recursive: true });
  }
  let configPath = join(env.GNO_CONFIG_DIR!, "index.yml");
  for (let i = 0; i < launch.args.length; i++) {
    const arg = launch.args[i]!;
    if (arg === "--config" || arg.startsWith("--config=")) {
      configPath =
        arg === "--config" ? (launch.args[i + 1] ?? "") : arg.slice(9);
      await assertPackageSmokePathContained(
        launch.isolatedRoot,
        configPath,
        "config argument"
      );
    }
  }
  await assertPackageSmokePathContained(
    launch.isolatedRoot,
    configPath,
    "surface config"
  );
  if (await Bun.file(configPath).exists()) {
    const config = Bun.YAML.parse(await Bun.file(configPath).text()) as {
      collections?: Array<{ path?: string }>;
    };
    for (const collection of config.collections ?? [])
      await assertPackageSmokePathContained(
        launch.isolatedRoot,
        collection.path ?? "",
        "surface corpus"
      );
  }
  const safe = await buildPackageSmokeProcessEnv(launch.isolatedRoot, env);
  safe.XDG_STATE_HOME = join(directory, "state");
  await mkdir(safe.XDG_STATE_HOME, { recursive: true });
  return safe;
}

async function mcpOutput(
  client: Client,
  invocation: Extract<SurfaceInvocation, { surface: "mcp" }>,
  timeout: number,
  capturePath: string
): Promise<SearchResults | AskResult> {
  const response = await client.callTool(
    { name: invocation.tool, arguments: invocation.arguments },
    { timeout }
  );
  await Bun.write(`${capturePath}.response.json`, JSON.stringify(response));
  if (response.isError)
    throw new Error(`MCP tool error: ${JSON.stringify(response)}`);
  const content = response.content as { type: string; text?: string }[];
  return parseOutput(
    response.structuredContent ??
      JSON.parse(content.find((item) => item.type === "text")?.text ?? "null")
  );
}

/** Read to EOF from a fresh handle: exists() caches a BunFile's old size across rename. */
export async function readChildEventLedger(
  path: string
): Promise<ChildEvent[] | null> {
  try {
    const events = (await Bun.file(path).json()) as ChildEvent[];
    if (!Array.isArray(events))
      throw new Error("Invalid descendant event ledger");
    return events;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

export async function runSurfaceAcceptance(
  request: AdapterRequest,
  launch: SurfaceLaunch,
  invocation: SurfaceInvocation,
  readEvidence: EvidenceReader
): Promise<AdapterResult> {
  const entry = request.manifest.cases.find(
    (item) => item.caseId === request.caseId
  );
  if (entry?.surface !== invocation.surface)
    throw new Error("Manifest surface mismatch");
  if (
    invocation.surface === "mcp" &&
    (entry.configuration.mcpTransport ?? "stdio") !==
      (invocation.transport ?? "stdio")
  )
    throw new Error("Manifest MCP transport mismatch");
  for (const name of ["GNO_CONFIG_DIR", "GNO_DATA_DIR", "GNO_CACHE_DIR"])
    if (!launch.env[name])
      throw new Error(`Owned surface requires isolated ${name}`);
  const safeEnv = await isolatedEnv(launch);
  for (const suffix of [
    "",
    ".request.json",
    ".stdout.log",
    ".stderr.log",
    ".response.json",
    ".diagnostics.json",
  ])
    if (await Bun.file(`${launch.capturePath}${suffix}`).exists())
      throw new Error(
        "Capture path already exists; stale receipts are forbidden"
      );
  if ("url" in invocation) {
    const url = new URL(invocation.url);
    if (
      url.protocol !== "http:" ||
      url.username ||
      url.password ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
      throw new Error("API acceptance requires an owned loopback server");
    if (invocation.surface === "mcp" && url.pathname !== "/mcp")
      throw new Error("Resident MCP endpoint must be /mcp");
    let occupied = false;
    try {
      await fetch(new URL("/api/status", url), {
        signal: AbortSignal.timeout(1000),
        redirect: "error",
      });
      occupied = true;
    } catch {
      /* Unreachable is required before owning the listener. */
    }
    if (occupied) throw new Error("Refusing an already-running API listener");
  }
  const runId = crypto.randomUUID();
  await Bun.write(
    `${launch.capturePath}.request.json`,
    JSON.stringify({
      runId,
      caseId: request.caseId,
      models: request.manifest.models,
    })
  );
  const env = {
    ...safeEnv,
    GNO_ACCEPTANCE_CAPTURE: launch.capturePath,
    GNO_OFFLINE: "1",
    GNO_ALLOW_DOWNLOAD: "0",
    GNO_LLAMA_GPU: request.expectedBackend,
    GNO_LLAMA_BUILD: "never",
  };
  if (request.expectedBackend === "cuda" && launch.env.CUDA_PATH) {
    const cudaPath = await realpath(launch.env.CUDA_PATH);
    if (!(await lstat(cudaPath)).isDirectory())
      throw new Error("CUDA_PATH must be an existing runtime directory");
    Object.assign(env, { CUDA_PATH: cudaPath });
  }
  if (
    !(await Bun.file(
      `${launch.cwd}/evals/acceptance/native-capture.ts`
    ).exists())
  )
    throw new Error(
      "Copy native-capture.ts into the selected source root before launching"
    );
  const childMode = await Bun.file(
    `${launch.cwd}/src/llm/native-worker/entry.ts`
  ).exists();
  const args = [
    "--preload",
    `${launch.cwd}/evals/acceptance/${childMode ? "parent-capture" : "native-capture"}.ts`,
    ...launch.args,
  ];
  const harnessSha256: Record<string, string> = {};
  for (const name of [
    "native-capture.ts",
    "capture-contract.ts",
    "parent-capture.ts",
    "native-child-preload.ts",
    "child-receipt.ts",
  ]) {
    const file = Bun.file(join(launch.cwd, "evals/acceptance", name));
    if (await file.exists())
      harnessSha256[name] = new Bun.CryptoHasher("sha256")
        .update(await file.arrayBuffer())
        .digest("hex");
  }
  const timeout = launch.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new Error("Invalid surface timeout");
  const cwd = await realpath(launch.cwd);
  const started = performance.now();
  let pid: number | null = null;
  let raw: SearchResults | AskResult | null = null;
  let failure: string | undefined;
  const resources = new OwnedResources(request.expectedBackend === "cuda");
  let seenEvents = 0;
  let eventUpdates = Promise.resolve();
  let eventTimer: ReturnType<typeof setInterval> | undefined;
  const readEvents = async () => {
    if (!childMode || pid === null) return;
    const events = await readChildEventLedger(
      `${launch.capturePath}.children/children.json`
    );
    if (events === null) return;
    if (!Array.isArray(events) || events.length < seenEvents)
      throw new Error("Invalid descendant event ledger");
    for (const event of events.slice(seenEvents)) {
      seenEvents += 1;
      if (event.identity.runId !== runId)
        throw new Error("Foreign descendant run");
      await resources.observeDescendant({ pid }, event);
    }
  };
  const observe = () => {
    resources.start();
    eventTimer = setInterval(() => {
      eventUpdates = eventUpdates.then(readEvents).catch((error: unknown) => {
        resources.errors.push(String(error));
      });
    }, 25);
  };
  try {
    if (invocation.surface === "mcp" && invocation.transport !== "http") {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args,
        cwd: launch.cwd,
        env,
        stderr: "pipe",
      });
      const client = new Client({
        name: "gno-native-acceptance",
        version: "1",
      });
      const stderr = Bun.file(`${launch.capturePath}.stderr.log`).writer();
      const stdout = Bun.file(`${launch.capturePath}.stdout.log`).writer();
      let receiver: typeof transport.onmessage;
      Object.defineProperty(transport, "onmessage", {
        get: () => {
          const current = receiver;
          if (!current) return undefined;
          return (
            message: Parameters<NonNullable<typeof transport.onmessage>>[0]
          ) => {
            void stdout.write(`${JSON.stringify(message)}\n`);
            current(message);
          };
        },
        set: (value: typeof transport.onmessage) => {
          receiver = value;
        },
      });
      transport.stderr?.on("data", (data: Uint8Array) => {
        void stderr.write(data);
      });
      try {
        await client.connect(transport, { timeout });
        pid = transport.pid;
        if (pid === null) throw new Error("MCP transport omitted owned PID");
        resources.ownTransport(
          pid,
          () => transport.pid !== null,
          async () => {
            await client.close();
          }
        );
        observe();
        raw = await mcpOutput(client, invocation, timeout, launch.capturePath);
      } finally {
        pid ??= transport.pid;
        await resources.stopSampling();
        // Direct SDK v2 owns the handle and escalates EOF -> TERM -> KILL.
        try {
          await client.close();
        } finally {
          await stderr.end();
          await stdout.end();
        }
      }
    } else {
      const process = Bun.spawn([globalThis.process.execPath, ...args], {
        cwd: launch.cwd,
        env,
        stdout: Bun.file(`${launch.capturePath}.stdout.log`),
        stderr: Bun.file(`${launch.capturePath}.stderr.log`),
      });
      pid = process.pid;
      resources.own(process);
      observe();
      const timer = setTimeout(() => process.kill("SIGKILL"), timeout);
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        if ("url" in invocation) {
          const url = new URL(invocation.url);
          if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
            throw new Error("API acceptance requires an owned loopback server");
          const deadline = Date.now() + timeout;
          while (true) {
            if (process.exitCode !== null || process.signalCode !== null)
              throw new Error("Owned API process exited before readiness");
            try {
              const ready = await fetch(new URL("/api/status", url), {
                signal: AbortSignal.timeout(1000),
                redirect: "error",
              });
              if (ready.ok) break;
              throw new Error(`Readiness HTTP ${ready.status}`);
            } catch {
              if (Date.now() >= deadline)
                throw new Error("Owned API readiness timed out");
              await Bun.sleep(50);
            }
          }
          if (invocation.surface === "mcp") {
            const transport = new StreamableHTTPClientTransport(url, {
              fetch: (input, init) =>
                fetch(input, {
                  ...init,
                  redirect: "error",
                  signal: AbortSignal.any([
                    AbortSignal.timeout(
                      init?.method === "DELETE" ? 1000 : timeout
                    ),
                    ...(init?.signal ? [init.signal] : []),
                  ]),
                }),
            });
            const client = new Client({
              name: "gno-native-acceptance",
              version: "1",
            });
            try {
              await client.connect(transport, { timeout });
              raw = await mcpOutput(
                client,
                invocation,
                timeout,
                launch.capturePath
              );
            } finally {
              try {
                await transport.terminateSession();
              } finally {
                await client.close();
              }
            }
          } else {
            const response = await fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(invocation.body),
              signal: AbortSignal.timeout(timeout),
              redirect: "error",
            });
            const text = await response.text();
            await Bun.write(`${launch.capturePath}.response.json`, text);
            if (!response.ok)
              throw new Error(`API HTTP ${response.status}: ${text}`);
            raw = parseOutput(JSON.parse(text));
          }
          await resources.stopSampling();
          process.kill("SIGTERM");
          cleanupTimer = setTimeout(() => {
            if (process.exitCode === null && process.signalCode === null)
              process.kill("SIGKILL");
          }, 2000);
        }
        const code = await process.exited;
        if (invocation.surface === "cli" && code !== 0)
          throw new Error(
            `CLI exit ${code}: see ${launch.capturePath}.stderr.log`
          );
        if (invocation.surface === "cli")
          raw = parseOutput(
            JSON.parse(
              await Bun.file(`${launch.capturePath}.stdout.log`).text()
            )
          );
      } finally {
        clearTimeout(timer);
        clearTimeout(cleanupTimer);
        if (process.exitCode === null && process.signalCode === null)
          process.kill("SIGKILL");
        await process.exited;
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  clearInterval(eventTimer);
  await eventUpdates;
  try {
    await readEvents();
  } catch (error) {
    resources.errors.push(String(error));
  }
  await resources.close();
  await Bun.write(
    `${launch.capturePath}.diagnostics.json`,
    JSON.stringify({
      runId,
      pid,
      resources: resources.samples,
      resourceErrors: resources.errors,
      nativeChildren: resources.descendantEvents,
      harnessSha256,
      cwd,
      invocation,
      nativePolicy: {
        gpu: request.expectedBackend,
        build: "never",
        cudaPath: launch.env.CUDA_PATH ?? null,
      },
      durationMs: performance.now() - started,
      failure: failure ?? null,
    })
  );
  let receipt: NativeCapture = {
    runId,
    kind: "native",
    modelInputs: [],
    modelOutputs: [],
    backends: [],
    models: [],
    capabilities: [],
    errors: [],
  };
  try {
    const captured = (await Bun.file(
      launch.capturePath
    ).json()) as NativeCapture;
    if (captured.runId !== runId || captured.kind !== "native")
      throw new Error("Capture receipt run identity mismatch");
    receipt = captured;
  } catch (error) {
    failure = [failure, error instanceof Error ? error.message : String(error)]
      .filter(Boolean)
      .join("; ");
  }
  receipt.errors.push(...resources.errors);
  return projectAcceptance(request, raw, receipt, readEvidence, failure);
}
