import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, expect, test } from "bun:test";
// node:fs/promises for mkdir/mkdtemp (filesystem structure ops)
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os provides the temporary root
import { tmpdir } from "node:os";
// node:path has no Bun path utilities
import { join } from "node:path";

import { getIndexDbPath } from "../../src/app/constants";
import { runCli } from "../../src/cli/run";
import { createMcpServerSurface } from "../../src/mcp/context";
import { createGnoClient } from "../../src/sdk/client";
import { handleMetadata } from "../../src/serve/routes/api";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import {
  createLegacyParityToolContext,
  LEGACY_PARITY_SERVER_IDENTITY,
} from "../fixtures/mcp/legacy-parity-context";
import { safeRm } from "../helpers/cleanup";
import { assertValid, loadSchema } from "../spec/schemas/validator";

let root: string;
let store: SqliteAdapter;

async function cli(...args: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const write = process.stdout.write.bind(process.stdout);
  const log = console.log;
  process.stdout.write = (chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  console.log = (...items: unknown[]) => {
    out += `${items.join(" ")}\n`;
  };
  try {
    return { code: await runCli(["node", "gno", ...args]), out };
  } finally {
    process.stdout.write = write;
    console.log = log;
  }
}

const note = (title: string, metadata: string) =>
  `---\ntitle: ${title}\ngno:\n  metadata:\n${metadata}---\n\n${title} body.\n`;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "gno-metadata-"));
  const notes = join(root, "notes");
  await mkdir(notes);
  process.env.GNO_CONFIG_DIR = join(root, "config");
  process.env.GNO_DATA_DIR = join(root, "data");
  process.env.GNO_CACHE_DIR = join(root, "cache");
  await Bun.write(
    join(notes, "a.md"),
    note(
      "Atlas",
      "    project: atlas\n    status: approved\n    reviewers: [ana, sam]\n"
    )
  );
  await Bun.write(
    join(notes, "b.md"),
    note(
      "Borealis",
      "    project: borealis\n    status: approved\n    confidence: 0.9\n"
    )
  );
  await Bun.write(join(notes, "c.md"), "# Plain\n\nNo metadata.\n");
  expect((await cli("init", notes, "--name", "notes")).code).toBe(0);
  expect((await cli("update")).code).toBe(0);
  store = new SqliteAdapter();
  const opened = await store.open(getIndexDbPath(), "snowball english");
  if (!opened.ok) throw new Error(opened.error.message);
});

afterAll(async () => {
  await store.close();
  await safeRm(root);
  for (const key of ["GNO_CONFIG_DIR", "GNO_DATA_DIR", "GNO_CACHE_DIR"])
    Reflect.deleteProperty(process.env, key);
});

test("CLI, SDK, REST and MCP report the same metadata summary", async () => {
  const fromCli = JSON.parse(
    (await cli("metadata", "--collection", "notes", "--json")).out
  );
  expect(fromCli).toMatchObject({
    collection: "notes",
    documents: 3,
    documentsWithMetadata: 2,
  });
  expect(fromCli.keys).toEqual([
    {
      key: "project",
      types: ["string"],
      documents: 2,
      values: [
        { value: "atlas", documents: 1 },
        { value: "borealis", documents: 1 },
      ],
      valuesTruncated: false,
    },
    {
      key: "status",
      types: ["string"],
      documents: 2,
      values: [{ value: "approved", documents: 2 }],
      valuesTruncated: false,
    },
    {
      key: "confidence",
      types: ["number"],
      documents: 1,
      values: [{ value: 0.9, documents: 1 }],
      valuesTruncated: false,
    },
    {
      key: "reviewers",
      types: ["string[]"],
      documents: 1,
      values: [
        { value: "ana", documents: 1 },
        { value: "sam", documents: 1 },
      ],
      valuesTruncated: false,
    },
  ]);
  expect(assertValid(fromCli, await loadSchema("metadata-summary"))).toBe(true);

  const client = await createGnoClient({
    downloadPolicy: { offline: true, allowDownload: false },
  });
  try {
    expect(await client.listMetadata({ collection: "notes" })).toEqual(fromCli);
  } finally {
    await client.close();
  }

  const rest = await handleMetadata(
    store,
    new URL("http://localhost/api/metadata?collection=notes")
  );
  expect(await rest.json()).toEqual(fromCli);

  const ctx = createLegacyParityToolContext(false);
  ctx.store = store;
  const server = createMcpServerSurface(ctx, LEGACY_PARITY_SERVER_IDENTITY);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: "metadata", version: "1.0.0" });
  await mcp.connect(clientSide);
  try {
    const result = (await mcp.callTool({
      name: "gno_list_metadata",
      arguments: { collection: "notes" },
    })) as { structuredContent?: unknown };
    expect(result.structuredContent).toEqual(fromCli);
  } finally {
    await mcp.close();
    await server.close();
  }
});

test("values caps the listed values and rejects an out-of-range cap", async () => {
  const capped = JSON.parse(
    (await cli("metadata", "--values", "1", "--json")).out
  );
  const project = capped.keys.find(
    (key: { key: string }) => key.key === "project"
  );
  expect(project.values).toHaveLength(1);
  expect(project.valuesTruncated).toBe(true);
  expect((await cli("metadata", "--values", "0")).code).toBe(1);
  const rest = await handleMetadata(
    store,
    new URL("http://localhost/api/metadata?values=101")
  );
  expect(rest.status).toBe(400);
});
