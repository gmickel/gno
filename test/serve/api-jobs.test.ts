import { afterEach, describe, expect, test } from "bun:test";

import type { Config } from "../../src/config/types";
import type { ContextHolder } from "../../src/serve/routes/api";

import { clearAllJobs, startJob } from "../../src/serve/jobs";
import { handleActiveJob, handleSync } from "../../src/serve/routes/api";

function createMockContextHolder(config?: Partial<Config>): ContextHolder {
  const fullConfig: Config = {
    version: "1.0",
    ftsTokenizer: "unicode61",
    collections: [
      {
        name: "notes",
        path: "/tmp/notes",
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ],
    contexts: [],
    ...config,
  };

  return {
    current: { config: fullConfig } as ContextHolder["current"],
    config: fullConfig,
    scheduler: null,
    eventBus: null,
    watchService: null,
  };
}

describe("job API routes", () => {
  afterEach(() => {
    clearAllJobs();
  });

  test("GET /api/jobs/active returns null when idle", async () => {
    const res = handleActiveJob();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activeJob: null };
    expect(body.activeJob).toBeNull();
  });

  test("GET /api/jobs/active returns the running job", async () => {
    let resolveJob: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => {
      resolveJob = resolve;
    });

    const started = startJob("sync", async () => {
      await blocker;
      return {
        collections: [],
        totalDurationMs: 0,
        totalFilesProcessed: 0,
        totalFilesAdded: 0,
        totalFilesUpdated: 0,
        totalFilesErrored: 0,
        totalFilesSkipped: 0,
      };
    });

    expect(started.ok).toBe(true);

    const res = handleActiveJob();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      activeJob: { id: string; type: string; status: string };
    };
    expect(body.activeJob.id).toBe(started.ok ? started.jobId : "");
    expect(body.activeJob.type).toBe("sync");
    expect(body.activeJob.status).toBe("running");

    resolveJob?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  test("POST /api/sync includes activeJobId details on conflict", async () => {
    let resolveJob: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => {
      resolveJob = resolve;
    });

    const started = startJob("sync", async () => {
      await blocker;
      return {
        collections: [],
        totalDurationMs: 0,
        totalFilesProcessed: 0,
        totalFilesAdded: 0,
        totalFilesUpdated: 0,
        totalFilesErrored: 0,
        totalFilesSkipped: 0,
      };
    });

    expect(started.ok).toBe(true);

    const res = await handleSync(
      createMockContextHolder(),
      {} as never,
      new Request("http://localhost/api/sync", {
        method: "POST",
        body: JSON.stringify({}),
      })
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: {
        code: string;
        details?: { activeJobId?: string };
      };
    };
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.details?.activeJobId).toBe(
      started.ok ? started.jobId : undefined
    );

    resolveJob?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
