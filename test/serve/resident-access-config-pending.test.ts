/**
 * A config edit a resident cannot adopt (another client indexed a
 * collection the edited file omits) leaves the old config served. A
 * non-admin principal must not keep reading under the old `access` rules:
 * it is refused, without naming any collection, until the edit is adopted.
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
import type {
  HttpMcpRequestContext,
  HttpMcpTransport as Transport,
} from "../../src/mcp/http-transport";
import type { ResidentRuntime } from "../../src/serve/resident-runtime";

import { saveConfigToPath } from "../../src/config";
import { DEFAULT_FTS_TOKENIZER } from "../../src/config/types";
import { classifyDestination } from "../../src/core/destination-classifier";
import { HttpMcpTransport } from "../../src/mcp/http-transport";
import { createGnoClient } from "../../src/sdk";
import { startResidentRuntime } from "../../src/serve/resident-runtime";
import { safeRm } from "../helpers/cleanup";
import { snapshotSessionEnv, tempDir } from "../sessions/helpers";

let root: string;
let configPath: string;
let runtime: ResidentRuntime | undefined;
let transport: Transport | undefined;
const restoreEnv = snapshotSessionEnv();

const collection = (
  name: string,
  access?: Collection["access"]
): Collection => ({
  name,
  path: join(root, name),
  pattern: "**/*.md",
  include: [],
  exclude: [],
  ...(access ? { access } : {}),
});

const configWith = (collections: Collection[]): Config => ({
  version: "1.0",
  ftsTokenizer: DEFAULT_FTS_TOKENIZER,
  collections,
  contexts: [],
});

const PUBLIC = { public: true } as const;
const INDEX_QUERY = /\?index=.*$/;

const READER: HttpMcpRequestContext = {
  authenticated: true,
  identity: "assistant",
  principal: { name: "assistant", admin: false, mayAssertSubject: true },
  subject: { id: "u:bob", context: "1to1", hash: "hash-u:bob" },
  // A same-host gateway client: egress allows the default policy.
  peerClassification: classifyDestination({
    kind: "network",
    hostname: "127.0.0.1",
  }),
};
const UNRESTRICTED: HttpMcpRequestContext = { identity: "loopback" };

beforeEach(async () => {
  root = await tempDir("gno-resident-access-pending-");
  process.env.GNO_CONFIG_DIR = join(root, "gno-config");
  process.env.GNO_DATA_DIR = join(root, "gno-data");
  process.env.GNO_CACHE_DIR = join(root, "gno-cache");
  configPath = join(root, "index.yml");
  for (const name of ["alpha", "beta", "gamma"]) {
    await mkdir(join(root, name), { recursive: true });
    // Served notes need provenance under collection access.
    await Bun.write(
      join(root, name, `${name}.md`),
      `---\ngno:\n  metadata:\n    derived_from: ["sp:${name}"]\n---\n# ${name}\n\nzebra\n`
    );
  }
});

afterEach(async () => {
  await transport?.close();
  await runtime?.dispose();
  transport = undefined;
  runtime = undefined;
  restoreEnv();
  await safeRm(root);
});

/** gno_search for `zebra` over the resident HTTP endpoint as `caller`. */
async function search(
  resident: ResidentRuntime,
  caller: HttpMcpRequestContext
): Promise<{ isError?: boolean; text: string; uris: string[] }> {
  transport ??= new HttpMcpTransport(resident, { enableWrite: false });
  const http = transport;
  const client = new Client({ name: "access-pending", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3000/mcp"), {
      fetch: (input, init) =>
        http.handleRequest(new Request(input, init), caller),
    })
  );
  try {
    const result = (await client.callTool({
      name: "gno_search",
      arguments: { query: "zebra" },
    })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
      structuredContent?: { results?: Array<{ uri: string }> };
    };
    return {
      isError: result.isError,
      text: result.content.map(({ text }) => text).join("\n"),
      uris: (result.structuredContent?.results ?? [])
        .map(({ uri }) => uri.replace(INDEX_QUERY, ""))
        .sort(),
    };
  } finally {
    await client.close();
  }
}

test("a scoped caller is refused, unnamed, while an access edit waits on a stale collection", async () => {
  const served = [collection("alpha", PUBLIC), collection("beta", PUBLIC)];
  await saveConfigToPath(configWith(served), configPath);
  const started = await startResidentRuntime({
    configPath,
    index: "pending",
    offline: true,
  });
  if (!started.success) throw new Error(started.error);
  runtime = started.runtime;
  await runtime.syncAll({ triggerEmbed: false });

  // Another client with a wider config indexes gamma into the same index.
  const wider = await createGnoClient({
    config: configWith([...served, collection("gamma", PUBLIC)]),
    dbPath: join(root, "gno-data", "index-pending.sqlite"),
    indexName: "pending",
  });
  try {
    await wider.update();
  } finally {
    await wider.close();
  }

  // The served config is current: the scoped caller reads as if gamma were
  // absent.
  expect(await search(runtime, READER)).toEqual({
    isError: undefined,
    text: expect.any(String),
    uris: ["gno://alpha/alpha.md", "gno://beta/beta.md"],
  });

  // The operator makes alpha private; gamma blocks adopting the edit.
  await saveConfigToPath(
    configWith([collection("alpha", { owner: "u:carol" }), served[1]!]),
    configPath
  );
  const refused = await search(runtime, READER);
  expect(refused.isError).toBe(true);
  expect(refused.uris).toEqual([]);
  expect(refused.text).toContain("has not applied its current config");
  for (const name of ["alpha", "beta", "gamma"]) {
    expect(refused.text).not.toContain(name);
  }
  expect(runtime.config.collections[0]?.access).toEqual(PUBLIC);

  // Unrestricted callers keep the named refusal.
  const named = await search(runtime, UNRESTRICTED);
  expect(named.isError).toBe(true);
  expect(named.text).toContain("gamma (1 document)");

  // Back to the served file: nothing is pending, gamma is again invisible.
  await saveConfigToPath(configWith(served), configPath);
  expect((await search(runtime, READER)).uris).toEqual([
    "gno://alpha/alpha.md",
    "gno://beta/beta.md",
  ]);
});
