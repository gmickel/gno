import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises provides temp directories and mode inspection without Bun equivalents.
import { mkdir, mkdtemp, stat } from "node:fs/promises";
// node:os has no Bun equivalent.
import { tmpdir } from "node:os";
// node:path has no Bun path utilities.
import { join } from "node:path";

import type { FolderSetupReceipt } from "../../src/core/setup-receipt";

import {
  getSetupSemanticReceiptPath,
  loadSetupSemanticReceipt,
  scheduleSetupSemantic,
  setupSemanticSourceFingerprint,
  updateSetupSemanticReceipt,
} from "../../src/cli/commands/setup-semantic";
import { runSetupSemanticWorker } from "../../src/cli/setup-semantic-worker";
import {
  persistSetupReceipt,
  setupFingerprint,
} from "../../src/core/setup-receipt";
import { safeRm } from "../helpers/cleanup";
import { assertValid, loadSchema } from "../spec/schemas/validator";

const tempRoots: string[] = [];

function completedSetupReceipt(
  root: string,
  overrides: Partial<FolderSetupReceipt> = {}
): FolderSetupReceipt {
  const folder = join(root, "docs");
  const receiptPath = join(root, "data", "setup.json");
  return {
    schemaVersion: "1.0",
    status: "completed",
    generatedAt: "2026-07-24T10:00:00.000Z",
    input: {
      folder,
      folderFingerprint: setupFingerprint(folder),
      indexName: "default",
      requestedName: null,
      excludes: [".git"],
      secretRiskAuthorized: false,
    },
    fingerprints: {
      input: setupFingerprint("input"),
      config: setupFingerprint("config"),
      index: setupFingerprint("index"),
    },
    collection: {
      name: "docs",
      path: folder,
      disposition: "created",
    },
    paths: {
      config: join(root, "config", "index.yml"),
      receipt: receiptPath,
    },
    stages: {
      preflight: stage(),
      config_saved: stage(),
      store_synced: stage(),
      lexical_indexed: stage(),
      lexical_proved: stage(),
      completed: stage(),
    },
    pending: [],
    failure: null,
    activation: {
      schemaVersion: "1.0",
      collection: "docs",
      fingerprint: setupFingerprint("activation"),
      ready: true,
      generatedAt: "2026-07-24T10:00:00.000Z",
      stages: {
        index: activationStage(),
        lexical: activationStage(),
        semantic: {
          status: "pending",
          startedAt: null,
          completedAt: null,
          latencyMs: null,
          code: "semantic_not_checked",
        },
        connector: {
          status: "skipped",
          startedAt: null,
          completedAt: null,
          latencyMs: null,
          code: "connector_not_requested",
        },
      },
      evidence: {
        probeHash: setupFingerprint("probe"),
        resultUri: "gno://docs/readme.md",
        resultSourceHash: setupFingerprint("source"),
      },
    },
    ...overrides,
  };
}

function stage() {
  return {
    status: "passed" as const,
    token: setupFingerprint(crypto.randomUUID()),
    startedAt: "2026-07-24T10:00:00.000Z",
    completedAt: "2026-07-24T10:00:00.000Z",
    code: null,
    remediation: null,
  };
}

function activationStage() {
  return {
    status: "passed" as const,
    startedAt: "2026-07-24T10:00:00.000Z",
    completedAt: "2026-07-24T10:00:00.000Z",
    latencyMs: 1,
  };
}

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `gno-setup-semantic-${label}-`));
  tempRoots.push(root);
  await mkdir(join(root, "docs"), { recursive: true });
  return root;
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await safeRm(root);
  }
});

describe("setup semantic handoff", () => {
  test("records skipped privately without spawning", async () => {
    const root = await tempRoot("skipped");
    let spawnCount = 0;
    const receipt = await scheduleSetupSemantic({
      setupReceipt: completedSetupReceipt(root),
      dataDir: join(root, "data"),
      configPath: join(root, "config", "index.yml"),
      indexName: "default",
      offline: false,
      disabled: true,
      spawnWorker: async () => {
        spawnCount += 1;
        return { pid: 10 };
      },
    });

    expect(receipt.status).toBe("skipped");
    expect(spawnCount).toBe(0);
    expect(await loadSetupSemanticReceipt(receipt.receiptPath)).toEqual(
      receipt
    );
    assertValid(receipt, await loadSchema("setup-semantic-receipt"));
    if (process.platform !== "win32") {
      expect((await stat(receipt.receiptPath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(receipt.receiptPath, ".."))).mode & 0o777).toBe(
        0o700
      );
    }
  });

  test("disabled setup records skipped across live and completed jobs, then re-enables", async () => {
    const root = await tempRoot("disabled-transition");
    const setupReceipt = completedSetupReceipt(root);
    const base = {
      setupReceipt,
      dataDir: join(root, "data"),
      configPath: join(root, "config", "index.yml"),
      indexName: "default",
      offline: false,
    };
    const scheduled = await scheduleSetupSemantic({
      ...base,
      spawnWorker: async () => ({ pid: process.pid }),
      processIsAlive: () => true,
    });
    let disabledSpawns = 0;
    const skippedLive = await scheduleSetupSemantic({
      ...base,
      disabled: true,
      spawnWorker: async () => {
        disabledSpawns += 1;
        return { pid: 999 };
      },
      processIsAlive: () => true,
    });

    expect(skippedLive.status).toBe("skipped");
    expect(skippedLive.jobId).toBe(scheduled.jobId);
    expect(skippedLive.pid).toBe(process.pid);
    expect(disabledSpawns).toBe(0);
    expect(await loadSetupSemanticReceipt(skippedLive.receiptPath)).toEqual(
      skippedLive
    );

    let embedCalls = 0;
    expect(
      await runSetupSemanticWorker(skippedLive.receiptPath, scheduled.jobId, {
        embedFn: async () => {
          embedCalls += 1;
          return {
            success: true,
            embedded: 1,
            errors: 0,
            duration: 1,
            model: "test-model",
            searchAvailable: true,
          };
        },
      })
    ).toBe(0);
    expect(embedCalls).toBe(0);

    const skippedAgain = await scheduleSetupSemantic({
      ...base,
      disabled: true,
      processIsAlive: () => true,
    });
    expect(skippedAgain.status).toBe("skipped");
    expect(skippedAgain.pid).toBe(process.pid);

    let prematureSpawns = 0;
    const stillSkipped = await scheduleSetupSemantic({
      ...base,
      spawnWorker: async () => {
        prematureSpawns += 1;
        return { pid: 778 };
      },
      processIsAlive: () => true,
    });
    expect(stillSkipped).toEqual(skippedAgain);
    expect(prematureSpawns).toBe(0);

    const completed = await updateSetupSemanticReceipt(
      scheduled.receiptPath,
      scheduled.jobId,
      (current) => ({
        ...current,
        status: "completed",
        generatedAt: "2026-07-24T10:01:00.000Z",
        completedAt: "2026-07-24T10:01:00.000Z",
        pid: null,
        counts: { embedded: 1, errors: 0 },
        error: null,
      })
    );
    expect(completed.status).toBe("completed");

    const skippedCompleted = await scheduleSetupSemantic({
      ...base,
      disabled: true,
      processIsAlive: () => false,
    });
    expect(skippedCompleted.status).toBe("skipped");
    expect(
      await loadSetupSemanticReceipt(skippedCompleted.receiptPath)
    ).toEqual(skippedCompleted);

    let enabledSpawns = 0;
    const enabled = await scheduleSetupSemantic({
      ...base,
      spawnWorker: async () => {
        enabledSpawns += 1;
        return { pid: 777 };
      },
      processIsAlive: () => false,
    });
    expect(enabled.status).toBe("scheduled");
    expect(enabled.pid).toBe(777);
    expect(enabledSpawns).toBe(1);
  });

  test("semantic source identity ignores created versus reused disposition", async () => {
    const root = await tempRoot("stable-disposition");
    const created = completedSetupReceipt(root);
    const reused: FolderSetupReceipt = {
      ...created,
      collection: {
        ...created.collection,
        disposition: "reused",
      },
    };

    expect(setupSemanticSourceFingerprint(reused)).toBe(
      setupSemanticSourceFingerprint(created)
    );
  });

  test("schedules once and reuses a matching live worker concurrently", async () => {
    const root = await tempRoot("live");
    const options = {
      setupReceipt: completedSetupReceipt(root),
      dataDir: join(root, "data"),
      configPath: join(root, "config", "index.yml"),
      indexName: "default",
      offline: false,
      spawnWorker: async () => {
        spawnCount += 1;
        return { pid: 4321 };
      },
      processIsAlive: (pid: number) => pid === 4321,
    };
    let spawnCount = 0;
    const [left, right] = await Promise.all([
      scheduleSetupSemantic(options),
      scheduleSetupSemantic(options),
    ]);

    expect(spawnCount).toBe(1);
    expect(left.jobId).toBe(right.jobId);
    expect(left.pid).toBe(4321);
    expect(right.pid).toBe(4321);
  });

  test("replaces a dead worker and reports spawn failure as resumable pending", async () => {
    const root = await tempRoot("dead");
    const setupReceipt = completedSetupReceipt(root);
    const base = {
      setupReceipt,
      dataDir: join(root, "data"),
      configPath: join(root, "config", "index.yml"),
      indexName: "default",
      offline: true,
      processIsAlive: () => false,
    };
    const scheduled = await scheduleSetupSemantic({
      ...base,
      spawnWorker: async () => ({ pid: 111 }),
    });
    expect(scheduled.status).toBe("scheduled");

    const pending = await scheduleSetupSemantic({
      ...base,
      spawnWorker: async () => {
        throw new Error("spawn unavailable");
      },
    });
    expect(pending.status).toBe("pending");
    expect(pending.error?.message).toBe("spawn unavailable");
    expect(pending.resumeCommand).toContain("--offline embed docs");
    expect(await loadSetupSemanticReceipt(pending.receiptPath)).toEqual(
      pending
    );
  });

  test("preserves a different live job so it can still complete", async () => {
    const root = await tempRoot("identity");
    const setupReceipt = completedSetupReceipt(root);
    const base = {
      setupReceipt,
      dataDir: join(root, "data"),
      configPath: join(root, "config", "index.yml"),
      indexName: "default",
      processIsAlive: () => true,
    };
    const first = await scheduleSetupSemantic({
      ...base,
      offline: false,
      spawnWorker: async () => ({ pid: 222 }),
    });
    let replacementSpawns = 0;
    const second = await scheduleSetupSemantic({
      ...base,
      offline: true,
      spawnWorker: async () => {
        replacementSpawns += 1;
        return { pid: 333 };
      },
    });

    expect(first.status).toBe("scheduled");
    expect(second).toEqual(first);
    expect(replacementSpawns).toBe(0);
    expect(await loadSetupSemanticReceipt(first.receiptPath)).toEqual(first);

    const completed = await updateSetupSemanticReceipt(
      first.receiptPath,
      first.jobId,
      (current) => ({
        ...current,
        status: "completed",
        generatedAt: "2026-07-24T10:01:00.000Z",
        completedAt: "2026-07-24T10:01:00.000Z",
        pid: null,
        counts: { embedded: 1, errors: 0 },
        error: null,
      })
    );
    expect(completed.status).toBe("completed");
  });

  test("rejects a corrupt local receipt instead of casting it", async () => {
    const root = await tempRoot("corrupt");
    const path = getSetupSemanticReceiptPath({
      dataDir: join(root, "data"),
      indexName: "default",
      folderRealpath: join(root, "docs"),
    });
    await mkdir(join(path, ".."), { recursive: true });
    await Bun.write(path, JSON.stringify({ schemaVersion: "1.0" }));
    expect(await loadSetupSemanticReceipt(path)).toBeNull();

    const skipped = await scheduleSetupSemantic({
      setupReceipt: completedSetupReceipt(root),
      dataDir: join(root, "data"),
      configPath: join(root, "config", "index.yml"),
      indexName: "default",
      offline: false,
      disabled: true,
    });
    await Bun.write(
      path,
      JSON.stringify({
        ...skipped,
        status: "completed",
        counts: null,
      })
    );
    expect(await loadSetupSemanticReceipt(path)).toBeNull();
  });

  test("one-shot worker completes and propagates collection/offline options", async () => {
    const root = await tempRoot("worker-complete");
    const setupReceipt = completedSetupReceipt(root);
    await persistSetupReceipt(setupReceipt);
    const scheduled = await scheduleSetupSemantic({
      setupReceipt,
      dataDir: join(root, "data"),
      configPath: setupReceipt.paths.config,
      indexName: "default",
      offline: true,
      spawnWorker: async () => ({ pid: process.pid }),
      processIsAlive: () => true,
    });
    let received: Record<string, unknown> | null = null;

    const exitCode = await runSetupSemanticWorker(
      scheduled.receiptPath,
      scheduled.jobId,
      {
        embedFn: async (options) => {
          received = options as unknown as Record<string, unknown>;
          return {
            success: true,
            embedded: 7,
            errors: 0,
            duration: 2,
            model: "test-model",
            searchAvailable: true,
          };
        },
      }
    );

    expect(exitCode).toBe(0);
    expect(received).toMatchObject({
      collection: "docs",
      indexName: "default",
      offline: true,
      json: true,
    });
    const completed = await loadSetupSemanticReceipt(scheduled.receiptPath);
    expect(completed).toMatchObject({
      status: "completed",
      pid: null,
      counts: { embedded: 7, errors: 0 },
      error: null,
    });
  });

  test("one-shot worker records embed failure with foreground remediation", async () => {
    const root = await tempRoot("worker-failed");
    const setupReceipt = completedSetupReceipt(root);
    await persistSetupReceipt(setupReceipt);
    const scheduled = await scheduleSetupSemantic({
      setupReceipt,
      dataDir: join(root, "data"),
      configPath: setupReceipt.paths.config,
      indexName: "default",
      offline: false,
      spawnWorker: async () => ({ pid: process.pid }),
      processIsAlive: () => true,
    });

    const exitCode = await runSetupSemanticWorker(
      scheduled.receiptPath,
      scheduled.jobId,
      {
        embedFn: () =>
          Promise.resolve({ success: false, error: "model unavailable" }),
      }
    );

    expect(exitCode).toBe(2);
    const failed = await loadSetupSemanticReceipt(scheduled.receiptPath);
    expect(failed).toMatchObject({
      status: "failed",
      pid: null,
      counts: null,
      error: {
        message: "model unavailable",
      },
    });
    expect(failed?.error?.remediation).toContain(failed?.resumeCommand ?? "?");
  });

  test("one-shot worker treats partial and vector-sync errors as failed", async () => {
    const cases = [
      {
        label: "partial",
        errors: 2,
        syncError: undefined,
        expected: "2 failed chunks",
      },
      {
        label: "sync",
        errors: 0,
        syncError: "vec unavailable",
        expected: "Vector index sync failed",
      },
    ];
    for (const testCase of cases) {
      const root = await tempRoot(`worker-${testCase.label}`);
      const setupReceipt = completedSetupReceipt(root);
      await persistSetupReceipt(setupReceipt);
      const scheduled = await scheduleSetupSemantic({
        setupReceipt,
        dataDir: join(root, "data"),
        configPath: setupReceipt.paths.config,
        indexName: "default",
        offline: false,
        spawnWorker: async () => ({ pid: process.pid }),
        processIsAlive: () => true,
      });

      const exitCode = await runSetupSemanticWorker(
        scheduled.receiptPath,
        scheduled.jobId,
        {
          embedFn: () =>
            Promise.resolve({
              success: true,
              embedded: 5,
              errors: testCase.errors,
              duration: 1,
              model: "test-model",
              searchAvailable: true,
              syncError: testCase.syncError,
            }),
        }
      );
      expect(exitCode).toBe(2);
      const failed = await loadSetupSemanticReceipt(scheduled.receiptPath);
      expect(failed?.status).toBe("failed");
      expect(failed?.counts).toEqual({
        embedded: 5,
        errors: testCase.errors,
      });
      expect(failed?.error?.message).toContain(testCase.expected);
      expect(failed?.error?.remediation).toContain(
        failed?.resumeCommand ?? "?"
      );
    }
  });
});
