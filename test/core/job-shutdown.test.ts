import { expect, test } from "bun:test";

import { JobManager } from "../../src/core/job-manager";
import { withInferenceScope } from "../../src/llm/inference-scope";

test("accepted job owns cancellation, fails unfinished at shutdown and releases its lock once", async () => {
  const parent = new AbortController();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  let released = 0;
  const manager = new JobManager({
    lockPath: "unused",
    serverInstanceId: "test",
    toolMutex: { acquire: async () => () => {} },
  });
  const id = await withInferenceScope({ signal: parent.signal }, () =>
    manager.startTypedJobWithLock(
      "embed",
      {
        release: async () => {
          released++;
        },
      },
      async (owned) => {
        signal = owned;
        entered.resolve();
        await finish.promise;
        return { kind: "embed", value: { embedded: 32, errors: 0 } };
      }
    )
  );
  await entered.promise;
  parent.abort();
  expect(signal?.aborted).toBe(false);
  manager.stop();
  const rejected = await manager
    .startTypedJobWithLock("embed", { release: async () => {} }, async () => ({
      kind: "embed",
      value: { embedded: 0, errors: 0 },
    }))
    .catch((error: unknown) => error);
  expect(rejected).toBeInstanceOf(Error);
  await manager.failUnfinished();
  expect(signal?.aborted).toBe(true);
  expect(manager.getJob(id)?.status).toBe("failed");
  expect(released).toBe(1);
  finish.resolve();
  await manager.shutdown();
  expect(manager.getJob(id)?.status).toBe("failed");
  expect(manager.getJob(id)?.typedResult).toBeUndefined();
  expect(released).toBe(1);
});
