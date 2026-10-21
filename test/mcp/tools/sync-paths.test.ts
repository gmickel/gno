/**
 * gno_sync path-level reindex through the real tool, store and job manager.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
// node:fs/promises, node:os, and node:path build the temporary collection.
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection } from "../../../src/config/types";
import type { ToolContext } from "../../../src/mcp/server";

import { createDefaultConfig } from "../../../src/config/defaults";
import { JobManager } from "../../../src/core/job-manager";
import { withInferenceScope } from "../../../src/llm/inference-scope";
import { Mutex } from "../../../src/mcp/context";
import { handleSync } from "../../../src/mcp/tools/sync";
import { SqliteAdapter } from "../../../src/store/sqlite/adapter";
import { safeRm } from "../../helpers/cleanup";

let root = "";
let docs = "";
let store: SqliteAdapter;
let manager: JobManager;
let ctx: ToolContext;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gno-sync-paths-"));
  docs = join(root, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(join(docs, "a.md"), "# A one\n\nalpha\n");
  await writeFile(join(docs, "b.md"), "# B one\n\nbravo\n");
  const collections: Collection[] = [
    { name: "notes", path: docs, pattern: "**/*", include: [], exclude: [] },
  ];
  store = new SqliteAdapter();
  expect((await store.open(join(root, "index.sqlite"), "unicode61")).ok).toBe(
    true
  );
  expect((await store.syncCollections(collections)).ok).toBe(true);
  const toolMutex = new Mutex();
  manager = new JobManager({
    lockPath: join(root, ".mcp-write.lock"),
    serverInstanceId: "test",
    toolMutex,
  });
  ctx = {
    indexName: "default",
    store,
    config: { ...createDefaultConfig(), collections },
    collections,
    actualConfigPath: join(root, "config.yml"),
    toolMutex,
    jobManager: manager,
    serverInstanceId: "test",
    writeLockPath: join(root, ".mcp-write.lock"),
    enableWrite: true,
    isShuttingDown: () => false,
  };
});

afterEach(async () => {
  await manager.shutdown();
  await store.close();
  await safeRm(root);
});

const sync = (args: Parameters<typeof handleSync>[0]) =>
  withInferenceScope({}, () => handleSync(args, ctx));

async function syncAndWait(args: Parameters<typeof handleSync>[0]) {
  const result = await sync(args);
  expect(result.isError).toBeFalsy();
  const jobId = (result.structuredContent as { jobId: string }).jobId;
  for (;;) {
    const status = manager.getJob(jobId)?.status;
    if (status === "completed") return result;
    if (status === "failed") throw new Error(manager.getJob(jobId)?.error);
    await Bun.sleep(10);
  }
}

const title = async (relPath: string) => {
  const read = await store.getDocument("notes", relPath);
  return read.ok ? read.value : null;
};

test("only the listed paths are re-read, and a deleted path goes inactive", async () => {
  await syncAndWait({ collection: "notes" });
  expect((await title("a.md"))?.title).toBe("A one");

  await writeFile(join(docs, "a.md"), "# A two\n\nalpha\n");
  await writeFile(join(docs, "b.md"), "# B two\n\nbravo\n");
  const result = await syncAndWait({ collection: "notes", paths: ["a.md"] });
  expect(result.structuredContent).toMatchObject({
    status: "started",
    paths: ["a.md"],
  });
  expect((await title("a.md"))?.title).toBe("A two");
  expect((await title("b.md"))?.title).toBe("B one");

  await rm(join(docs, "b.md"));
  await syncAndWait({ collection: "notes", paths: [join(docs, "b.md")] });
  expect((await title("b.md"))?.active).toBe(false);
});

test("invalid path lists are rejected before anything is queued", async () => {
  await symlink(root, join(docs, "escape"));
  const cases: Array<[Parameters<typeof handleSync>[0], string]> = [
    [{ collection: "notes", paths: [] }, "INVALID_INPUT"],
    [{ paths: ["a.md"] }, "INVALID_INPUT"],
    [{ collection: "notes", paths: ["a.md"], gitPull: true }, "INVALID_INPUT"],
    [{ collection: "notes", paths: ["../outside.md"] }, "INVALID_PATH"],
    [{ collection: "notes", paths: ["/etc/hosts"] }, "INVALID_PATH"],
    [{ collection: "notes", paths: ["escape/index.sqlite"] }, "INVALID_PATH"],
    [
      { collection: "notes", paths: ["escape/missing/gone.md"] },
      "INVALID_PATH",
    ],
  ];
  for (const [args, code] of cases) {
    const result = await sync(args);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: code });
  }
  expect(manager.listJobs().active).toHaveLength(0);
  expect(manager.listJobs().recent).toHaveLength(0);
});
