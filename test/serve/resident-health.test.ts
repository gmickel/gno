import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises only supplies temporary-directory structure operations.
import { mkdtemp, rm } from "node:fs/promises";
// node:os/node:path have no Bun path utility equivalents.
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BackgroundIssue } from "../../src/serve/status-model";

import { VERSION } from "../../src/app/constants";
import { residentIssues, statusProcess } from "../../src/cli/detach";
import {
  buildResidentStatusSnapshot,
  createStandaloneResidentStatus,
} from "../../src/serve/resident-status";
import { handleResidentStatus } from "../../src/serve/routes/api";
import { assertValid, loadSchema } from "../spec/schemas/validator";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

function residentSnapshot(backgroundIssues?: BackgroundIssue[]) {
  return buildResidentStatusSnapshot({
    mode: "serve",
    startedAt: 1_000,
    now: 11_000,
    listenerPort: 3210,
    admission: { state: "accepting", activeRequests: 2 },
    shutdown: { state: "none" },
    transport: {
      activeRequests: 2,
      activeSessions: 2,
      queuedRequests: 1,
      maxConcurrentRequests: 8,
      maxQueuedRequests: 4,
      maxSessions: 16,
    },
    readers: { active: 1, queued: 1, limit: 8, maxQueued: 64 },
    models: {
      activeLeases: 1,
      leaseAcquisitions: 4,
      leaseReleases: 3,
      loadedModels: 2,
      loadAttempts: 2,
      loadSuccesses: 2,
      loadFailures: 0,
      inflightLoads: 0,
    },
    jobs: { active: 1, recent: 2, failed: 1 },
    generations: { content: 7, index: 5 },
    backgroundIssues,
  });
}

describe("resident health truth surface", () => {
  test("is schema-valid and contains counters without sensitive state", async () => {
    const sensitiveFixture = {
      path: "/Users/private",
      token: "secret-token",
      query: "private query",
      document: "document body",
      callerId: "caller-123",
    };
    const snapshot = residentSnapshot();
    const schema = await loadSchema("resident-status");
    expect(assertValid(snapshot, schema)).toBe(true);

    const serialized = JSON.stringify(snapshot);
    for (const forbidden of Object.values(sensitiveFixture)) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(() =>
      assertValid({ ...snapshot, token: sensitiveFixture.token }, schema)
    ).toThrow();
    expect(Object.keys(snapshot).sort()).toEqual([
      "admission",
      "generations",
      "jobs",
      "listenerPort",
      "mode",
      "models",
      "readers",
      "resident",
      "schemaVersion",
      "shutdown",
      "transport",
      "uptimeSeconds",
    ]);
  });

  test("REST and detached process status return the same live snapshot", async () => {
    const snapshot = residentSnapshot();
    const response = handleResidentStatus(() => snapshot);
    expect(await response.json()).toEqual(snapshot);

    const directory = await mkdtemp(join(tmpdir(), "gno-resident-health-"));
    temporaryDirectories.push(directory);
    const pidFile = join(directory, "serve.pid");
    const logFile = join(directory, "serve.log");
    await Bun.write(
      pidFile,
      JSON.stringify({
        pid: process.pid,
        cmd: "serve",
        version: VERSION,
        started_at: new Date(Date.now() - 10_000).toISOString(),
        port: 3210,
      })
    );

    const processStatus = await statusProcess({
      kind: "serve",
      pidFile,
      logFile,
      fetchResidentStatus: async () => snapshot,
    });
    expect(processStatus.running).toBe(true);
    expect(processStatus.port).toBe(3210);
    expect(processStatus.resident).toEqual(snapshot);
  });

  test("background issues appear only while a job is in trouble and stay schema-valid", async () => {
    const issue = {
      job: "embed" as const,
      state: "parked" as const,
      consecutiveFailures: 5,
      runningSeconds: null,
    };
    const snapshot = residentSnapshot([issue]);
    expect(snapshot.backgroundIssues).toEqual([issue]);
    expect(assertValid(snapshot, await loadSchema("resident-status"))).toBe(
      true
    );
    expect(residentSnapshot([])).not.toHaveProperty("backgroundIssues");

    const running = {
      running: true,
      pid: 1,
      port: 3210,
      cmd: "serve" as const,
      version: VERSION,
      started_at: null,
      uptime_seconds: 1,
      pid_file: "serve.pid",
      log_file: "serve.log",
      log_size_bytes: 0,
    };
    expect(residentIssues({ ...running, resident: snapshot })).toEqual([issue]);
    expect(residentIssues({ ...running, resident: null })).toEqual([
      {
        job: "resident",
        state: "unresponsive",
        consecutiveFailures: 0,
        runningSeconds: null,
      },
    ]);
    expect(
      residentIssues({ ...running, running: false, resident: null })
    ).toEqual([]);
  });

  test("stdio and direct CLI report explicit standalone lifecycles", () => {
    expect(createStandaloneResidentStatus("stdio")).toMatchObject({
      mode: "stdio",
      resident: false,
      uptimeSeconds: null,
      listenerPort: null,
    });
    expect(createStandaloneResidentStatus("direct-cli")).toMatchObject({
      mode: "direct-cli",
      resident: false,
      uptimeSeconds: null,
      listenerPort: null,
    });
  });
});
