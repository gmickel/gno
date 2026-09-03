import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { AuditRunResult } from "../../src/core/audit";
import type { FindingsPassDeps } from "../../src/serve/findings-pass";

import { materializeAuditFinding } from "../../src/core/audit-report";
import {
  createPendingFindingsRunState,
  readFindingsRunStatus,
} from "../../src/core/findings-run-state";
import {
  FindingsScheduler,
  runFindingsPass,
} from "../../src/serve/findings-pass";
import { safeRm } from "../helpers/cleanup";

const RULE = "links.broken-target";
const finding = materializeAuditFinding(RULE, "links", {
  severity: "error",
  subject: "gno://notes/a.md",
  location: null,
  message: "Link target does not resolve",
  evidence: [],
  guidance: [],
});

const auditResult = (
  findings: (typeof finding)[],
  status: "complete" | "partial" = "complete"
): AuditRunResult =>
  ({
    ok: true,
    exit: "ok",
    report: {
      status,
      findings,
      rules: [
        {
          ruleId: RULE,
          category: "links",
          status: findings.length > 0 ? "fail" : "pass",
        },
      ],
      counts: {
        findings: {
          total: findings.length,
          returned: findings.length,
          truncated: false,
        },
      },
    },
  }) as never;

let dir: string;
let deps: FindingsPassDeps;
let config: Config;
let auditCalls: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gno-findings-pass-"));
  await mkdir(join(dir, "findings"));
  auditCalls = 0;
  config = {
    version: "1.0",
    ftsTokenizer: "unicode61",
    collections: [
      {
        name: "notes",
        path: join(dir, "notes"),
        pattern: "**/*",
        include: [],
        exclude: [],
      },
      {
        name: "findings",
        path: join(dir, "findings"),
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ],
    contexts: [],
  };
  deps = {
    store: {} as never,
    getConfig: () => config,
    schedule: {
      collection: config.collections[1]!,
      cadence: "1h",
      cadenceMs: 3_600_000,
    },
    dbPath: join(dir, "index-default.sqlite"),
    indexName: "default",
    statePath: join(dir, "index-default.findings-run.json"),
    acquireLease: async () => ({ ok: true, release: async () => undefined }),
    runAudit: async (options) => {
      auditCalls += 1;
      expect(options.collectionFilters).toEqual(["notes"]);
      return auditResult([finding]);
    },
  };
});

afterEach(async () => {
  await safeRm(dir);
});

const pending = () => createPendingFindingsRunState(deps.schedule, new Date());

describe("runFindingsPass", () => {
  test("audits every collection except the findings one and persists success with counts", async () => {
    const result = await runFindingsPass(deps, pending());
    expect(result.outcome).toBe("success");
    expect(result.counts).toMatchObject({ findings: 1, written: 1, open: 1 });
    expect(await readdir(join(dir, "findings"))).toHaveLength(1);
    const persisted = await readFindingsRunStatus(deps.statePath);
    expect(persisted).toMatchObject({
      state: "success",
      lastOutcome: "success",
      counts: { written: 1, open: 1 },
      error: null,
    });
    expect(persisted?.lastRunAt).not.toBeNull();
    expect(persisted?.lastSuccessAt).not.toBeNull();

    const again = await runFindingsPass(deps, result.record);
    expect(again.counts).toMatchObject({ written: 0, open: 1 });
    expect(await readdir(join(dir, "findings"))).toHaveLength(1);
  });

  test("a busy lease at write time lands as skipped_lease after the audit, writing nothing", async () => {
    deps.acquireLease = async () => ({
      ok: false,
      holder: "gno index (pid 7)",
    });
    const result = await runFindingsPass(deps, pending());
    expect(result.outcome).toBe("skipped_lease");
    expect(result.error).toBe("lease held by gno index (pid 7)");
    expect(auditCalls).toBe(1);
    expect(await readdir(join(dir, "findings"))).toEqual([]);
    expect((await readFindingsRunStatus(deps.statePath))?.state).toBe(
      "skipped_lease"
    );
  });

  test("the audit runs without the write lease; the lease is taken only for the record write", async () => {
    const events: string[] = [];
    let finishAudit!: () => void;
    const auditGate = new Promise<void>((resolve) => {
      finishAudit = resolve;
    });
    deps.acquireLease = async () => {
      events.push("lease");
      return {
        ok: true,
        release: async () => {
          events.push("release");
        },
      };
    };
    deps.runAudit = async () => {
      events.push("audit:start");
      await auditGate;
      events.push("audit:end");
      return auditResult([finding]);
    };
    const run = runFindingsPass(deps, pending());
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A writer (capture, gno index) is free while the audit is in flight.
    expect(events).toEqual(["audit:start"]);
    finishAudit();
    const result = await run;
    expect(result.outcome).toBe("success");
    expect(events).toEqual(["audit:start", "audit:end", "lease", "release"]);
  });

  test("a throwing audit lands as failed state, keeps prior counts, never takes the lease", async () => {
    let leaseCalls = 0;
    deps.acquireLease = async () => {
      leaseCalls += 1;
      return { ok: true, release: async () => undefined };
    };
    const previous = {
      ...pending(),
      counts: {
        findings: 3,
        written: 3,
        reopened: 0,
        resolved: 0,
        deleted: 0,
        open: 3,
      },
    };
    deps.runAudit = async () => {
      throw new Error("boom");
    };
    const result = await runFindingsPass(deps, previous);
    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("boom");
    expect(leaseCalls).toBe(0);
    const persisted = await readFindingsRunStatus(deps.statePath);
    expect(persisted).toMatchObject({
      state: "failed",
      error: "boom",
      counts: { open: 3 },
    });
    expect(persisted?.lastSuccessAt).toBeNull();
  });

  test("a failing record write lands as failed state and releases the lease", async () => {
    let released = false;
    deps.acquireLease = async () => ({
      ok: true,
      release: async () => {
        released = true;
      },
    });
    // Make the findings root a file so the record write cannot succeed.
    await safeRm(join(dir, "findings"));
    await Bun.write(join(dir, "findings"), "not a directory");
    const result = await runFindingsPass(deps, pending());
    expect(result.outcome).toBe("failed");
    expect(result.error).not.toBeNull();
    expect(released).toBe(true);
  });

  test("an unwritable state file surfaces as failed with the write error, keeping the run's counts", async () => {
    deps.writeState = async () => {
      throw new Error("EACCES: permission denied");
    };
    const result = await runFindingsPass(deps, pending());
    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("state write failed: EACCES: permission denied");
    expect(result.record.lastOutcome).toBe("failed");
    expect(result.record.error).toBe(result.error);
    // The records were written; the counts stay truthful in memory.
    expect(result.counts).toMatchObject({ findings: 1, written: 1, open: 1 });
    expect(await readdir(join(dir, "findings"))).toHaveLength(1);
    expect(await readFindingsRunStatus(deps.statePath)).toBeNull();
  });

  test("a state write failure after a failed run keeps both errors", async () => {
    deps.runAudit = async () => {
      throw new Error("boom");
    };
    deps.writeState = async () => {
      throw new Error("ENOSPC");
    };
    const result = await runFindingsPass(deps, pending());
    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("state write failed: ENOSPC (after: boom)");
  });

  test("a clean run writes nothing", async () => {
    deps.runAudit = async () => auditResult([]);
    const result = await runFindingsPass(deps, pending());
    expect(result.outcome).toBe("success");
    expect(result.counts).toMatchObject({ findings: 0, written: 0, open: 0 });
    expect(await readdir(join(dir, "findings"))).toEqual([]);
  });

  test("only the findings collection configured: success with no audit", async () => {
    config = { ...config, collections: [config.collections[1]!] };
    const result = await runFindingsPass(deps, pending());
    expect(result.outcome).toBe("success");
    expect(auditCalls).toBe(0);
  });
});

describe("FindingsScheduler", () => {
  test("a failing state write reaches onResult as failed and the loop keeps running", async () => {
    let writes = 0;
    deps.writeState = async () => {
      writes += 1;
      if (writes > 1) throw new Error("EACCES: permission denied");
    };
    const results: Array<{ outcome: string; error: string | null }> = [];
    const scheduler = new FindingsScheduler({
      deps,
      startBackgroundWork: () => true,
      onResult: (result) =>
        results.push({ outcome: result.outcome, error: result.error }),
    });
    await scheduler.start();
    const first = await scheduler.triggerNow();
    expect(first.outcome).toBe("failed");
    expect(scheduler.state.lastOutcome).toBe("failed");
    expect(scheduler.state.error).toBe(
      "state write failed: EACCES: permission denied"
    );
    expect(results).toEqual([
      {
        outcome: "failed",
        error: "state write failed: EACCES: permission denied",
      },
    ]);
    // The loop survives: the next trigger still audits and reports.
    const second = await scheduler.triggerNow();
    expect(second.outcome).toBe("failed");
    expect(auditCalls).toBe(2);
    expect(results).toHaveLength(2);
    scheduler.dispose();
  });

  test("an unwritable state file at start does not stop the loop", async () => {
    deps.schedule = { ...deps.schedule, cadence: "10s", cadenceMs: 25 };
    deps.writeState = async () => {
      throw new Error("EACCES: permission denied");
    };
    const results: string[] = [];
    const scheduler = new FindingsScheduler({
      deps,
      startBackgroundWork: (operation) => {
        void operation(new AbortController().signal);
        return true;
      },
      onResult: (result) => results.push(result.outcome),
    });
    await scheduler.start();
    expect(scheduler.state.error).toContain("state write failed: EACCES");
    const deadline = Date.now() + 5_000;
    while (results.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(results.length).toBeGreaterThanOrEqual(1);
    scheduler.dispose();
  });

  test("persists pending state on start, fires on cadence, coalesces triggers, stops on dispose", async () => {
    deps.schedule = { ...deps.schedule, cadence: "10s", cadenceMs: 25 };
    const results: string[] = [];
    const scheduler = new FindingsScheduler({
      deps,
      startBackgroundWork: (operation) => {
        void operation(new AbortController().signal);
        return true;
      },
      onResult: (result) => results.push(result.outcome),
    });
    await scheduler.start();
    expect((await readFindingsRunStatus(deps.statePath))?.state).toBe(
      "pending"
    );
    // Bounded poll instead of a fixed sleep: a 25ms cadence on a slow CI
    // runner (macOS) can miss an 80ms window without anything being wrong.
    const deadline = Date.now() + 5_000;
    while (results.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]).toBe("success");
    expect(scheduler.state.lastOutcome).toBe("success");

    const first = scheduler.triggerNow();
    const second = scheduler.triggerNow();
    expect(second).toBe(first);
    await first;

    scheduler.dispose();
    const countAtDispose = auditCalls;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(auditCalls).toBe(countAtDispose);
  });
});
