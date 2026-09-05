/** Drives real owned CLI, stdio MCP and HTTP API processes; never a live vault. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { AskResult, SearchResults } from "../../src/pipeline/types";
import type {
  AdapterRequest,
  AdapterResult,
  EvidenceReader,
} from "./native-adapter";
import type { NativeCapture } from "./native-capture";

import { projectAcceptance } from "./native-adapter";

export interface SurfaceLaunch {
  /** Entrypoint and arguments after `bun --preload native-capture.ts`. */
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Unique private temporary path; contains exact synthetic model inputs. */
  capturePath: string;
  timeoutMs?: number;
}
export type SurfaceInvocation =
  | { surface: "cli" }
  | { surface: "mcp"; tool: string; arguments: Record<string, unknown> }
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
  for (const name of ["GNO_CONFIG_DIR", "GNO_DATA_DIR", "GNO_CACHE_DIR"])
    if (!launch.env[name])
      throw new Error(`Owned surface requires isolated ${name}`);
  if (await Bun.file(launch.capturePath).exists())
    throw new Error(
      "Capture path already exists; stale receipts are forbidden"
    );
  if (invocation.surface === "api") {
    const url = new URL(invocation.url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw new Error("API acceptance requires an owned loopback server");
    let occupied = false;
    try {
      await fetch(new URL("/api/status", url), {
        signal: AbortSignal.timeout(1000),
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
    JSON.stringify({ runId, models: request.manifest.models })
  );
  const env = {
    ...process.env,
    ...launch.env,
    GNO_ACCEPTANCE_CAPTURE: launch.capturePath,
    GNO_OFFLINE: "1",
    GNO_ALLOW_DOWNLOAD: "0",
  };
  if (
    !(await Bun.file(
      `${launch.cwd}/evals/acceptance/native-capture.ts`
    ).exists())
  )
    throw new Error(
      "Copy native-capture.ts into the selected source root before launching"
    );
  const args = [
    "--preload",
    `${launch.cwd}/evals/acceptance/native-capture.ts`,
    ...launch.args,
  ];
  const timeout = launch.timeoutMs ?? 120_000;
  let raw: SearchResults | AskResult | null = null;
  let failure: string | undefined;
  try {
    if (invocation.surface === "mcp") {
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
      try {
        await client.connect(transport, { timeout });
        const response = await client.callTool(
          { name: invocation.tool, arguments: invocation.arguments },
          undefined,
          { timeout }
        );
        if (response.isError)
          throw new Error(`MCP tool error: ${JSON.stringify(response)}`);
        const content = response.content as { type: string; text?: string }[];
        raw = parseOutput(
          response.structuredContent ??
            JSON.parse(
              content.find((item) => item.type === "text")?.text ?? "null"
            )
        );
      } finally {
        await client.close();
      }
    } else {
      const process = Bun.spawn([globalThis.process.execPath, ...args], {
        cwd: launch.cwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = new Response(process.stdout).text();
      const stderr = new Response(process.stderr).text();
      const timer = setTimeout(() => process.kill("SIGKILL"), timeout);
      try {
        if (invocation.surface === "api") {
          const url = new URL(invocation.url);
          if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
            throw new Error("API acceptance requires an owned loopback server");
          const deadline = Date.now() + timeout;
          while (true) {
            if (process.exitCode !== null)
              throw new Error("Owned API process exited before readiness");
            try {
              await fetch(new URL("/api/status", url), {
                signal: AbortSignal.timeout(1000),
              });
              break;
            } catch {
              if (Date.now() >= deadline)
                throw new Error("Owned API readiness timed out");
              await Bun.sleep(50);
            }
          }
          const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(invocation.body),
            signal: AbortSignal.timeout(timeout),
          });
          if (!response.ok)
            throw new Error(
              `API HTTP ${response.status}: ${await response.text()}`
            );
          raw = parseOutput(await response.json());
          process.kill("SIGTERM");
        }
        const code = await process.exited;
        if (invocation.surface === "cli" && code !== 0)
          throw new Error(`CLI exit ${code}: ${await stderr}`);
        if (invocation.surface === "cli")
          raw = parseOutput(JSON.parse(await stdout));
      } finally {
        clearTimeout(timer);
        if (process.exitCode === null) process.kill("SIGKILL");
        await process.exited;
        await Promise.all([stdout, stderr]);
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
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
  return projectAcceptance(request, raw, receipt, readEvidence, failure);
}
