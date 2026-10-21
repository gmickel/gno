import { afterEach, beforeEach, expect, test } from "bun:test";
// node:fs/promises, node:os, and node:path provide the temporary collection.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { ContextHolder } from "../../src/serve/routes/api";

import {
  type JobResult,
  JobManager,
  MAX_PENDING_REINDEX_JOBS,
} from "../../src/core/job-manager";
import { withInferenceScope } from "../../src/llm/inference-scope";
import { Mutex } from "../../src/mcp/context";
import { handleSync } from "../../src/serve/routes/api";
import { safeRm } from "../helpers/cleanup";

const done: JobResult = {
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

let root = "";
let manager: JobManager;
let holder: ContextHolder;
let release: () => void;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gno-api-sync-queue-"));
  manager = new JobManager({
    lockPath: join(root, "write.lock"),
    serverInstanceId: "test",
    toolMutex: new Mutex(),
  });
  const config: Config = {
    version: "1.0",
    ftsTokenizer: "unicode61",
    collections: [
      {
        name: "notes",
        path: root,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ],
    contexts: [],
  };
  holder = {
    current: { config } as ContextHolder["current"],
    config,
    scheduler: null,
    eventBus: null,
    watchService: null,
    jobManager: manager,
  };
  // A running job, so requests below queue behind it.
  const gate = Promise.withResolvers<void>();
  release = gate.resolve;
  await withInferenceScope({}, () =>
    manager.submitReindex({
      type: "index",
      collection: null,
      paths: null,
      options: { gitPull: false, runUpdateCmd: false },
      run: async () => {
        await gate.promise;
        return done;
      },
    })
  );
});

afterEach(async () => {
  manager.stop();
  release();
  await manager.shutdown();
  await safeRm(root);
});

const post = (body: unknown) =>
  withInferenceScope({}, () =>
    handleSync(
      holder,
      {} as never,
      new Request("http://localhost/api/sync", {
        method: "POST",
        body: JSON.stringify(body),
      })
    )
  );

test("syncs behind a running job are queued and merge per collection", async () => {
  const first = await post({ collection: "notes", paths: ["a.md"] });
  expect(first.status).toBe(202);
  const firstBody = (await first.json()) as { jobId: string; status: string };
  expect(firstBody.status).toBe("queued");

  const second = await post({ collection: "notes", paths: ["b.md"] });
  expect(((await second.json()) as { jobId: string }).jobId).toBe(
    firstBody.jobId
  );
  expect(manager.getJob(firstBody.jobId)?.status).toBe("queued");

  // A whole-collection sync joins the waiting path sync and widens it.
  const whole = await post({ collection: "notes" });
  expect(((await whole.json()) as { jobId: string }).jobId).toBe(
    firstBody.jobId
  );
  expect(manager.getJob(firstBody.jobId)?.scope).toEqual({
    collection: "notes",
    paths: null,
  });
});

test("path errors are rejected before queueing", async () => {
  const cases: Array<[unknown, string]> = [
    [{ paths: ["a.md"] }, "VALIDATION"],
    [{ collection: "notes", paths: [] }, "VALIDATION"],
    [{ collection: "notes", paths: "a.md" }, "VALIDATION"],
    [{ collection: "notes", paths: ["a.md"], gitPull: true }, "VALIDATION"],
    [{ collection: "notes", paths: ["../outside.md"] }, "INVALID_PATH"],
  ];
  for (const [body, code] of cases) {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      code
    );
  }
  expect(manager.listJobs().active).toHaveLength(1);
});

test("a full queue answers 429 QUEUE_FULL", async () => {
  await withInferenceScope({}, async () => {
    for (let i = 0; i < MAX_PENDING_REINDEX_JOBS; i += 1) {
      await manager.submitReindex({
        type: "sync",
        collection: `c${i}`,
        paths: null,
        options: { gitPull: false, runUpdateCmd: false },
        run: async () => done,
      });
    }
  });
  const res = await post({ collection: "notes" });
  expect(res.status).toBe(429);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
    "QUEUE_FULL"
  );
});
