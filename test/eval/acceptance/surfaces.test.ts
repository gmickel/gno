import { expect, test } from "bun:test";
// Bun has no temporary-directory creation/removal APIs.
import { mkdtemp, rm } from "node:fs/promises";
// Bun has no OS temporary-directory API.
import { tmpdir } from "node:os";
// Bun has no path manipulation API.
import { join } from "node:path";

import type { AdapterRequest } from "../../../evals/acceptance/native-adapter";
import type {
  SurfaceInvocation,
  SurfaceLaunch,
} from "../../../evals/acceptance/surface-adapter";

import { ACCEPTANCE_SCHEMA_VERSION } from "../../../evals/acceptance/manifest";
import { runSurfaceAcceptance } from "../../../evals/acceptance/surface-adapter";

const raw = {
  results: [],
  meta: {
    query: "synthetic",
    mode: "hybrid",
    totalResults: 0,
    vectorsUsed: false,
    reranked: false,
  },
};
const serverScript = `
const mode = process.argv[2];
const value = ${JSON.stringify(raw)};
console.error("synthetic-surface-start", process.pid, process.env.GNO_LLAMA_GPU, process.env.GNO_LLAMA_BUILD);
function rpc(message) {
 if (message.id === undefined) return null;
 let result;
 if (message.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: {tools:{}}, serverInfo: {name:"synthetic",version:"1"} };
 else if (message.method === "tools/list") result = { tools: [{name:"gno_query",description:"test",inputSchema:{type:"object"}}] };
 else result = {content:[{type:"text",text:JSON.stringify(value)}],structuredContent:value};
 return {jsonrpc:"2.0",id:message.id,result};
}
if (mode === "stdio") {
 let buffer = "";
 for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  while (buffer.includes("\\n")) {
   const index = buffer.indexOf("\\n");
   const line = buffer.slice(0,index); buffer = buffer.slice(index+1);
   if (!line) continue;
   const reply = rpc(JSON.parse(line));
   if (reply) console.log(JSON.stringify(reply));
  }
 }
} else {
 Bun.serve({hostname:"127.0.0.1",port:Number(process.argv[3]),async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/api/status") return Response.json({ready:true,pid:process.pid});
  if (mode === "never") return new Promise(()=>{});
  if (url.pathname === "/mcp") {
   if (request.method === "DELETE") return new Response(null,{status:204});
   if (request.method !== "POST") return new Response(null,{status:405});
   const reply = rpc(await request.json());
   return reply ? Response.json(reply) : new Response(null,{status:202});
  }
  return Response.json(mode === "wrapped" ? {data:value} : value);
 }});
}
`;

async function fixture(mode: string) {
  const root = await mkdtemp(join(tmpdir(), "acceptance-surface-"));
  const portReservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const port = portReservation.port;
  await portReservation.stop(true);
  const path = join(root, "server.ts");
  await Bun.write(path, serverScript);
  const surface = mode === "stdio" || mode === "http" ? "mcp" : "api";
  const hash = "a".repeat(64);
  const request: AdapterRequest = {
    manifest: {
      schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
      role: "baseline",
      identity: {
        commit: "a".repeat(40),
        indexId: "synthetic",
        indexSha256: hash,
        bunVersion: Bun.version,
        nativeDependencies: {},
        platform: process.platform,
        architecture: process.arch,
      },
      fixtureVersion: "synthetic",
      fixtures: [{ path: "synthetic", sha256: hash }],
      models: [],
      cases: [
        {
          caseId: "one",
          fixtureSha256: hash,
          surface,
          preset: "test",
          configuration: surface === "mcp" ? { mcpTransport: mode } : {},
        },
      ],
      intendedDeltas: [],
    },
    caseId: "one",
    query: "synthetic",
    operation: "hybrid",
    options: { noExpand: true },
    expectedBackend: "cuda",
  };
  const launch: SurfaceLaunch = {
    cwd: process.cwd(),
    isolatedRoot: root,
    args: [path, mode, String(port)],
    env: {
      GNO_CONFIG_DIR: join(root, "config"),
      GNO_DATA_DIR: join(root, "data"),
      GNO_CACHE_DIR: join(root, "cache"),
    },
    capturePath: join(root, "capture.json"),
    timeoutMs: 5000,
  };
  const invocation: SurfaceInvocation =
    surface === "mcp"
      ? mode === "http"
        ? {
            surface: "mcp",
            transport: "http",
            url: `http://127.0.0.1:${port}/mcp`,
            tool: "gno_query",
            arguments: { query: "synthetic" },
          }
        : {
            surface: "mcp",
            transport: "stdio",
            tool: "gno_query",
            arguments: { query: "synthetic" },
          }
      : {
          surface: "api",
          url: `http://127.0.0.1:${port}/api/query`,
          body: { query: "synthetic" },
        };
  return { root, request, launch, invocation };
}
const read = async () => ({ content: "", sourceHash: "a".repeat(64) });

test("real owned REST, stdio MCP and resident MCP HTTP retain output and stop children without claiming native coverage", async () => {
  for (const mode of ["api", "stdio", "http"]) {
    const f = await fixture(mode);
    try {
      const result = await runSurfaceAcceptance(
        f.request,
        f.launch,
        f.invocation,
        read
      );
      expect(result.raw).toEqual(raw);
      expect(result.coverage).toBe("incomplete");
      const diagnostics = await Bun.file(
        `${f.launch.capturePath}.diagnostics.json`
      ).json();
      expect(diagnostics.failure).toBeNull();
      expect(diagnostics.pid).toBeGreaterThan(0);
      expect(() => process.kill(diagnostics.pid, 0)).toThrow();
      expect(
        await Bun.file(`${f.launch.capturePath}.stderr.log`).text()
      ).toContain("synthetic-surface-start");
      expect(
        await Bun.file(`${f.launch.capturePath}.stderr.log`).text()
      ).toContain("cuda never");
      expect(
        await Bun.file(`${f.launch.capturePath}.stdout.log`).exists()
      ).toBe(true);
      if (mode === "stdio") {
        const messages = (
          await Bun.file(`${f.launch.capturePath}.stdout.log`).text()
        )
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(
          messages.filter(
            (message) => message.result?.protocolVersion === "2025-11-25"
          )
        ).toHaveLength(1);
      }
      expect(
        await Bun.file(`${f.launch.capturePath}.response.json`).exists()
      ).toBe(true);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
}, 20000);

test("resident timeout and unexpected REST wrapper retain diagnostics and incomplete output", async () => {
  for (const mode of ["never", "wrapped"]) {
    const f = await fixture(mode);
    try {
      f.launch.timeoutMs = 1000;
      const result = await runSurfaceAcceptance(
        f.request,
        f.launch,
        f.invocation,
        read
      );
      expect(result.coverage).toBe("incomplete");
      const diagnostics = await Bun.file(
        `${f.launch.capturePath}.diagnostics.json`
      ).json();
      expect(diagnostics.failure).not.toBeNull();
      expect(() => process.kill(diagnostics.pid, 0)).toThrow();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
}, 10000);

test("occupied listeners, transport pin mismatch and escaped writable paths fail before spawn", async () => {
  const f = await fixture("http");
  const existing = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ live: true }),
  });
  try {
    if (!("url" in f.invocation)) throw new Error("Expected HTTP invocation");
    f.invocation.url = `http://127.0.0.1:${existing.port}/mcp`;
    await expect(
      runSurfaceAcceptance(f.request, f.launch, f.invocation, read)
    ).rejects.toThrow("already-running");
    f.request.manifest.cases[0]!.configuration.mcpTransport = "stdio";
    await expect(
      runSurfaceAcceptance(f.request, f.launch, f.invocation, read)
    ).rejects.toThrow("transport mismatch");
    f.request.manifest.cases[0]!.configuration.mcpTransport = "http";
    f.launch.env.GNO_DATA_DIR = process.cwd();
    await expect(
      runSurfaceAcceptance(f.request, f.launch, f.invocation, read)
    ).rejects.toThrow("outside");
    expect(
      await Bun.file(`${f.launch.capturePath}.request.json`).exists()
    ).toBe(false);
  } finally {
    await existing.stop(true);
    await rm(f.root, { recursive: true, force: true });
  }
});
