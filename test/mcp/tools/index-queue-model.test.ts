/**
 * A queued gno_index pass looks up its embedding model when it runs, not when
 * it was submitted: a server reload in between disposes the old adapter.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
// node:fs/promises, node:os, and node:path build the temporary collection.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection, Config } from "../../../src/config/types";
import type { JobResult } from "../../../src/core/job-manager";
import type { LlmAdapter } from "../../../src/llm/nodeLlamaCpp/adapter";
import type { ToolContext } from "../../../src/mcp/server";

import { createDefaultConfig } from "../../../src/config/defaults";
import { JobManager } from "../../../src/core/job-manager";
import { withInferenceScope } from "../../../src/llm/inference-scope";
import { Mutex } from "../../../src/mcp/context";
import { handleIndex } from "../../../src/mcp/tools/index-cmd";
import { SqliteAdapter } from "../../../src/store/sqlite/adapter";
import { safeRm } from "../../helpers/cleanup";

let root = "";
let store: SqliteAdapter;
let manager: JobManager;
let ctx: ToolContext;
let collection: Collection;

/** An adapter that records the model it was asked for and has none cached. */
function fakeAdapter() {
  const requested: string[] = [];
  const adapter = {
    createEmbeddingPort: async (modelUri: string) => {
      requested.push(modelUri);
      return { ok: false, error: { message: "not cached" } };
    },
  } as unknown as LlmAdapter;
  return { adapter, requested };
}

const configWith = (embed?: string): Config => {
  const collections = [
    embed ? { ...collection, models: { embed } } : collection,
  ];
  return { ...createDefaultConfig(), collections };
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gno-index-queue-model-"));
  const docs = join(root, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(join(docs, "a.md"), "# A\n\nalpha\n");
  collection = {
    name: "notes",
    path: docs,
    pattern: "**/*",
    include: [],
    exclude: [],
  };
  store = new SqliteAdapter();
  expect((await store.open(join(root, "index.sqlite"), "unicode61")).ok).toBe(
    true
  );
  expect((await store.syncCollections([collection])).ok).toBe(true);
  const toolMutex = new Mutex();
  manager = new JobManager({
    lockPath: join(root, ".mcp-write.lock"),
    serverInstanceId: "test",
    toolMutex,
  });
  const config = configWith();
  ctx = {
    indexName: "default",
    store,
    config,
    collections: config.collections,
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

test("a queued pass embeds with the adapter and model current when it runs", async () => {
  const stale = fakeAdapter();
  const live = fakeAdapter();
  ctx.getModelAdapter = () => stale.adapter;

  // Hold the queue with another collection's pass.
  const gate = Promise.withResolvers<void>();
  const blocking = Promise.withResolvers<void>();
  await withInferenceScope({}, () =>
    manager.submitReindex({
      type: "index",
      collection: "other",
      paths: null,
      options: { gitPull: false, runUpdateCmd: false },
      run: async (): Promise<JobResult> => {
        blocking.resolve();
        await gate.promise;
        return {
          kind: "sync",
          value: {
            collections: [],
            totalDurationMs: 0,
            totalFilesProcessed: 0,
            totalFilesAdded: 0,
            totalFilesUpdated: 0,
            totalFilesErrored: 0,
            totalFilesSkipped: 0,
          },
        };
      },
    })
  );
  await blocking.promise;

  const result = await withInferenceScope({}, () =>
    handleIndex({ collection: "notes", paths: ["a.md"] }, ctx)
  );
  expect(result.structuredContent).toMatchObject({ status: "queued" });
  const { jobId } = result.structuredContent as { jobId: string };

  // A reload while the pass waits: new config, new adapter.
  ctx.config = configWith("file:/models/reloaded-embed.gguf");
  ctx.getModelAdapter = () => live.adapter;
  gate.resolve();
  while (["queued", "running"].includes(manager.getJob(jobId)?.status ?? "")) {
    await Bun.sleep(10);
  }

  expect(stale.requested).toEqual([]);
  expect(live.requested).toEqual(["file:/models/reloaded-embed.gguf"]);
  expect(manager.getJob(jobId)?.error).toContain("MODEL_NOT_FOUND");
});
