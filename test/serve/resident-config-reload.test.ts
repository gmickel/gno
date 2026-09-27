/**
 * A running resident (`gno serve` / `gno daemon`) follows collections added
 * to or removed from its config file without a restart: `/api/status`, MCP
 * `gno_status`, the watcher and search scope all reflect the file, with the
 * sessions refresh's error handling (an unreadable file is an error, never
 * served stale).
 */

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, beforeEach, expect, test } from "bun:test";
// node:fs/promises mkdir: directory creation, no Bun equivalent.
import { mkdir } from "node:fs/promises";
// node:path has no Bun path utilities
import { join } from "node:path";

import type { Collection, Config } from "../../src/config/types";
import type { ResidentRuntime } from "../../src/serve/resident-runtime";

import { saveConfigToPath } from "../../src/config";
import { DEFAULT_FTS_TOKENIZER } from "../../src/config/types";
import { HttpMcpTransport } from "../../src/mcp/http-transport";
import { handleResidentRead } from "../../src/serve/resident-request";
import { startResidentRuntime } from "../../src/serve/resident-runtime";
import { handleSearch, handleStatus } from "../../src/serve/routes/api";
import { safeRm } from "../helpers/cleanup";
import { snapshotSessionEnv, tempDir } from "../sessions/helpers";

let root: string;
let configPath: string;
let runtime: ResidentRuntime | undefined;
let transport: HttpMcpTransport | undefined;
const restoreEnv = snapshotSessionEnv();

const collection = (name: string): Collection => ({
  name,
  path: join(root, name),
  pattern: "**/*.md",
  include: [],
  exclude: [],
});

const configWith = (...names: string[]): Config => ({
  version: "1.0",
  ftsTokenizer: DEFAULT_FTS_TOKENIZER,
  collections: names.map(collection),
  contexts: [],
});

beforeEach(async () => {
  root = await tempDir("gno-resident-config-reload-");
  process.env.GNO_CONFIG_DIR = join(root, "gno-config");
  process.env.GNO_DATA_DIR = join(root, "gno-data");
  process.env.GNO_CACHE_DIR = join(root, "gno-cache");
  configPath = join(root, "index.yml");
  for (const name of ["alpha", "beta", "gamma"]) {
    await mkdir(join(root, name), { recursive: true });
    await Bun.write(join(root, name, `${name}.md`), `# ${name}\n\nzebra\n`);
  }
  await saveConfigToPath(configWith("alpha", "beta"), configPath);
});

afterEach(async () => {
  await transport?.close();
  await runtime?.dispose();
  transport = undefined;
  runtime = undefined;
  restoreEnv();
  await safeRm(root);
});

const read = (
  resident: ResidentRuntime,
  operation: () => Promise<Response> | Response
): Promise<Response> =>
  handleResidentRead(resident, new Request("http://127.0.0.1/api"), operation);

async function apiStatus(resident: ResidentRuntime): Promise<string[]> {
  const res = await read(resident, () =>
    handleStatus(resident.ctxHolder.current, {
      getResidentStatus: () => resident.getStatus(),
    })
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { collections: Array<{ name: string }> };
  return body.collections.map(({ name }) => name).sort();
}

async function searchHits(resident: ResidentRuntime): Promise<string[]> {
  const res = await read(resident, () =>
    handleSearch(
      resident.ctxHolder.current,
      new Request("http://127.0.0.1/api/search", {
        method: "POST",
        body: JSON.stringify({ query: "zebra", limit: 10 }),
      })
    )
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { results: Array<{ uri: string }> };
  return body.results.map(({ uri }) => uri).sort();
}

/** MCP gno_status over the resident HTTP endpoint, on a fresh session. */
async function mcpStatus(resident: ResidentRuntime): Promise<string[]> {
  transport ??= new HttpMcpTransport(resident, { enableWrite: false });
  const http = transport;
  const client = new Client({ name: "config-reload", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3000/mcp"), {
      fetch: (input, init) => http.handleRequest(new Request(input, init)),
    })
  );
  try {
    const result = (await client.callTool({
      name: "gno_status",
      arguments: {},
    })) as {
      isError?: boolean;
      structuredContent?: { collections?: Array<{ name: string }> };
    };
    expect(result.isError).toBeFalsy();
    return (result.structuredContent?.collections ?? [])
      .map(({ name }) => name)
      .sort();
  } finally {
    await client.close();
  }
}

test("a resident adopts collections removed and added in its config file", async () => {
  const started = await startResidentRuntime({
    configPath,
    index: "reload",
    offline: true,
  });
  if (!started.success) throw new Error(started.error);
  runtime = started.runtime;
  await runtime.syncAll({ triggerEmbed: false });
  expect(await apiStatus(runtime)).toEqual(["alpha", "beta"]);
  expect(await searchHits(runtime)).toEqual([
    "gno://alpha/alpha.md",
    "gno://beta/beta.md",
  ]);

  // Removed by hand while the resident runs.
  await saveConfigToPath(configWith("alpha"), configPath);
  expect(await apiStatus(runtime)).toEqual(["alpha"]);
  expect(await mcpStatus(runtime)).toEqual(["alpha"]);
  expect(await searchHits(runtime)).toEqual(["gno://alpha/alpha.md"]);
  expect(runtime.watchService.getState().expectedCollections).toEqual([
    "alpha",
  ]);

  // Added (as `gno collection add` writes it).
  await saveConfigToPath(configWith("alpha", "gamma"), configPath);
  expect(await mcpStatus(runtime)).toEqual(["alpha", "gamma"]);
  expect(await apiStatus(runtime)).toEqual(["alpha", "gamma"]);
  expect(runtime.watchService.getState().expectedCollections.sort()).toEqual([
    "alpha",
    "gamma",
  ]);
});

test("an unreadable config file is an error, never served stale", async () => {
  const started = await startResidentRuntime({
    configPath,
    index: "reload",
    offline: true,
  });
  if (!started.success) throw new Error(started.error);
  runtime = started.runtime;
  const served = runtime.config;

  await Bun.write(configPath, "version: [not valid\n");
  const res = await read(runtime, () => new Response("unreachable"));
  expect(res.status).toBe(500);
  const body = (await res.json()) as {
    error: { message: string; details: { sessionsCode: string } };
  };
  expect(body.error.details.sessionsCode).toBe("SESSIONS_RUNTIME_FAILURE");
  expect(body.error.message).not.toContain(root);
  expect(runtime.config).toBe(served);
});
