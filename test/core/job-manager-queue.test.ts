import { afterEach, beforeEach, expect, test } from "bun:test";
// node:async_hooks: request context the queue must not leak between jobs.
import { AsyncLocalStorage } from "node:async_hooks";
// node:fs/promises, node:os, and node:path provide temporary lock structure.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireWriteLock } from "../../src/core/file-lock";
import {
  JobError,
  type JobResult,
  JobManager,
  MAX_PENDING_REINDEX_JOBS,
  type ReindexOptions,
  type ReindexRequest,
  type ReindexScope,
} from "../../src/core/job-manager";
import { withInferenceScope } from "../../src/llm/inference-scope";
import { Mutex } from "../../src/mcp/context";
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

const PLAIN: ReindexOptions = { gitPull: false, runUpdateCmd: false };
const WITH_UPDATE: ReindexOptions = { gitPull: false, runUpdateCmd: true };

let root = "";
let manager: JobManager;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gno-reindex-queue-"));
  manager = new JobManager({
    lockPath: join(root, "write.lock"),
    serverInstanceId: "test",
    toolMutex: new Mutex(),
  });
});

afterEach(async () => {
  await manager.shutdown();
  await safeRm(root);
});

const submit = (request: ReindexRequest) =>
  withInferenceScope({}, () => manager.submitReindex(request));

/** A run that records the scope of each pass and waits until released. */
function gatedRun() {
  const calls: ReindexScope[] = [];
  const started: Array<PromiseWithResolvers<void>> = [];
  const gates: Array<PromiseWithResolvers<void>> = [];
  const step = (n: number) => {
    while (gates.length <= n) {
      gates.push(Promise.withResolvers<void>());
      started.push(Promise.withResolvers<void>());
    }
    return { started: started[n]!.promise, release: () => gates[n]!.resolve() };
  };
  const run: ReindexRequest["run"] = async (scope) => {
    calls.push(scope);
    const n = calls.length - 1;
    step(n);
    started[n]!.resolve();
    await gates[n]!.promise;
    return done;
  };
  return { calls, run, step };
}

const request = (
  run: ReindexRequest["run"],
  collection: string | null,
  paths: string[] | null = null,
  options: ReindexOptions = PLAIN
): ReindexRequest => ({ type: "sync", collection, paths, options, run });

const settle = async (jobId: string) => {
  while (["queued", "running"].includes(manager.getJob(jobId)?.status ?? ""))
    await Bun.sleep(5);
};

test("a single request starts immediately and completes", async () => {
  const { run, step } = gatedRun();
  const first = step(0);
  const accepted = await submit(request(run, "notes"));
  expect(accepted.status).toBe("running");
  await first.started;
  first.release();
  await manager.shutdown();
  expect(manager.getJob(accepted.jobId)?.status).toBe("completed");
});

test("a request while a job runs is queued, then runs after it", async () => {
  const { calls, run, step } = gatedRun();
  const first = step(0);
  const second = step(1);
  const running = await submit(request(run, "a"));
  await first.started;

  const queued = await submit(request(run, "b"));
  expect(queued.status).toBe("queued");
  expect(manager.getJob(queued.jobId)?.status).toBe("queued");
  expect(calls).toHaveLength(1);

  first.release();
  await second.started;
  expect(manager.getJob(running.jobId)?.status).toBe("completed");
  expect(manager.getJob(queued.jobId)?.status).toBe("running");
  second.release();
  await settle(queued.jobId);
  expect(manager.getJob(queued.jobId)?.status).toBe("completed");
});

test("many requests for one collection make one more pass over the union of paths", async () => {
  const { calls, run, step } = gatedRun();
  const first = step(0);
  const second = step(1);
  await submit(request(run, "notes", ["a.md"]));
  await first.started;

  const ids = new Set<string>();
  for (let i = 0; i < 100; i += 1) {
    const accepted = await submit(request(run, "notes", [`doc-${i % 3}.md`]));
    expect(accepted.status).toBe("queued");
    ids.add(accepted.jobId);
  }
  expect(ids.size).toBe(1);
  const [jobId] = [...ids];
  expect(manager.getJob(jobId!)?.scope).toEqual({
    collection: "notes",
    paths: ["doc-0.md", "doc-1.md", "doc-2.md"],
  });

  first.release();
  await second.started;
  second.release();
  await settle(jobId!);
  expect(calls).toHaveLength(2);
  expect(calls[1]?.paths).toEqual(["doc-0.md", "doc-1.md", "doc-2.md"]);
});

test("a path-only job past MAX_REINDEX_PATHS files becomes one plain whole-collection pass", async () => {
  const { calls, run, step } = gatedRun();
  const first = step(0);
  const second = step(1);
  await submit(request(run, "other"));
  await first.started;
  const batch = (from: number) =>
    Array.from({ length: 100 }, (_, i) => `doc-${from + i}.md`);
  const ids = new Set<string>();
  for (const from of [0, 100, 200]) {
    // A path request's options never reach the pass, even once it widens.
    const accepted = await submit(
      request(run, "notes", batch(from), WITH_UPDATE)
    );
    ids.add(accepted.jobId);
  }
  expect(ids.size).toBe(1);
  const [jobId] = [...ids];
  expect(manager.getJob(jobId!)?.scope).toEqual({
    collection: "notes",
    paths: null,
  });
  // A whole-collection request with no update command joins the widened job.
  expect((await submit(request(run, "notes"))).jobId).toBe(jobId!);
  first.release();
  await second.started;
  second.release();
  await settle(jobId!);
  expect(calls[1]).toEqual({
    collection: "notes",
    paths: null,
    options: PLAIN,
  });
});

test("a whole-collection request absorbs path requests and sets the pass options", async () => {
  const { calls, run, step } = gatedRun();
  const first = step(0);
  const second = step(1);
  await submit(request(run, "other"));
  await first.started;
  const a = await submit(request(run, "notes", ["a.md"]));
  const b = await submit(request(run, "notes", null, WITH_UPDATE));
  const c = await submit(request(run, "notes", ["c.md"]));
  expect(new Set([a.jobId, b.jobId, c.jobId]).size).toBe(1);
  expect(manager.getJob(a.jobId)?.scope).toEqual({
    collection: "notes",
    paths: null,
  });
  first.release();
  await second.started;
  second.release();
  await settle(a.jobId);
  expect(calls[1]).toEqual({
    collection: "notes",
    paths: null,
    options: WITH_UPDATE,
  });
});

test("a path-only pass never runs whole-collection options", async () => {
  const { calls, run, step } = gatedRun();
  const first = step(0);
  const second = step(1);
  await submit(request(run, "other"));
  await first.started;
  // A path request asks for no update command, whatever options it carries.
  const queued = await submit(request(run, "notes", ["a.md"], WITH_UPDATE));
  first.release();
  await second.started;
  second.release();
  await settle(queued.jobId);
  expect(calls[1]).toEqual({
    collection: "notes",
    paths: ["a.md"],
    options: PLAIN,
  });
});

test("whole-collection requests with different options stay separate passes", async () => {
  const { calls, run, step } = gatedRun();
  const first = step(0);
  await submit(request(run, "other"));
  await first.started;
  const plain = await submit(request(run, "notes", null, PLAIN));
  const update = await submit(request(run, "notes", null, WITH_UPDATE));
  expect(plain.jobId).not.toBe(update.jobId);
  first.release();
  step(1).release();
  await settle(plain.jobId);
  step(2).release();
  await settle(update.jobId);
  expect(calls.slice(1).map((call) => call.options)).toEqual([
    PLAIN,
    WITH_UPDATE,
  ]);
});

test("a queued pass does not run in the previous job's request context", async () => {
  const requestContext = new AsyncLocalStorage<string>();
  const seen: Array<string | undefined> = [];
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  await requestContext.run("first request", () =>
    submit(
      request(async () => {
        seen.push(requestContext.getStore());
        entered.resolve();
        await gate.promise;
        return done;
      }, "a")
    )
  );
  await entered.promise;
  const queued = await requestContext.run("second request", () =>
    submit(
      request(async () => {
        seen.push(requestContext.getStore());
        return done;
      }, "b")
    )
  );
  gate.resolve();
  await settle(queued.jobId);
  expect(seen).toEqual(["first request", undefined]);
});

test("the pending bound rejects further scopes with QUEUE_FULL", async () => {
  const { run, step } = gatedRun();
  const first = step(0);
  await submit(request(run, "running"));
  await first.started;
  for (let i = 0; i < MAX_PENDING_REINDEX_JOBS; i += 1) {
    await submit(request(run, `c${i}`));
  }
  const full = submit(request(run, "one-more"));
  expect(full).rejects.toMatchObject({ code: "QUEUE_FULL" });
  await full.catch(() => undefined);
  // Joining a collection that already waits still works at the bound.
  const merged = await submit(request(run, "c0", ["a.md"]));
  expect(merged.status).toBe("queued");
  manager.stop();
  first.release();
});

test("an immediate start reports LOCKED while another process holds the write lease", async () => {
  const held = await acquireWriteLock(join(root, "write.lock"), 1000);
  expect(held).not.toBeNull();
  const short = new JobManager({
    lockPath: join(root, "write.lock"),
    serverInstanceId: "test",
    toolMutex: new Mutex(),
    lockTimeoutMs: 100,
  });
  try {
    const attempt = withInferenceScope({}, () =>
      short.submitReindex(request(async () => done, "notes"))
    );
    expect(attempt).rejects.toBeInstanceOf(JobError);
    expect(attempt).rejects.toMatchObject({ code: "LOCKED" });
    await attempt.catch(() => undefined);
    expect(short.listJobs().active).toHaveLength(0);
  } finally {
    await held?.release();
    await short.shutdown();
  }
});

test("queued work is failed at shutdown and unknown to a restarted process", async () => {
  const { run, step } = gatedRun();
  const first = step(0);
  await submit(request(run, "a"));
  await first.started;
  const queued = await submit(request(run, "b"));

  manager.stop();
  expect(manager.getJob(queued.jobId)).toMatchObject({
    status: "failed",
    error: "Resident runtime is shutting down",
  });
  first.release();
  await manager.shutdown();

  const restarted = new JobManager({
    lockPath: join(root, "write.lock"),
    serverInstanceId: "restarted",
    toolMutex: new Mutex(),
  });
  expect(restarted.getJob(queued.jobId)).toBeUndefined();
});

test("queued work accepted before a policy change fails instead of running", async () => {
  const { calls, run, step } = gatedRun();
  const first = step(0);
  manager.setAuthorizationEpoch("before");
  await submit(request(run, "a"));
  await first.started;
  const queued = await submit(request(run, "b"));
  expect(manager.setAuthorizationEpoch("after")).toBe(2);
  first.release();
  await settle(queued.jobId);
  expect(calls).toHaveLength(1);
  expect(manager.getJob(queued.jobId)).toMatchObject({
    status: "failed",
    error:
      "STALE_EGRESS_POLICY: collection policy changed; retry to re-authorize",
  });
});

test("a request after a policy change does not join work accepted under the old policy", async () => {
  const { calls, run, step } = gatedRun();
  const first = step(0);
  manager.setAuthorizationEpoch("before");
  await submit(request(run, "a"));
  await first.started;
  const stale = await submit(request(run, "b"));
  manager.setAuthorizationEpoch("after");
  const fresh = await submit(request(run, "b"));
  expect(fresh.jobId).not.toBe(stale.jobId);
  first.release();
  step(1).release();
  await settle(stale.jobId);
  await settle(fresh.jobId);
  expect(manager.getJob(stale.jobId)?.status).toBe("failed");
  expect(manager.getJob(fresh.jobId)?.status).toBe("completed");
  expect(calls).toHaveLength(2);
});
