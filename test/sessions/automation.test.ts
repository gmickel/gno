/**
 * Opt-in session automation (fn-172): owner profiles, the Claude Code hook
 * entry, durable generation-safe admission, daemon ticks with a fake clock,
 * crash/restart recovery, and equivalence of manual, hook and scheduled
 * imports over the same synthetic fixtures.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises for temp fixtures (no Bun equivalent for cp/mkdir/readdir/rename)
import { chmod, cp, mkdir, readdir, rename } from "node:fs/promises";
// node:path has no Bun path utilities
import { join, relative } from "node:path";

import type { SessionTriggerKind } from "../../src/sessions/types";

import {
  formatAutomationPreview,
  runSessionsHook,
} from "../../src/cli/commands/sessions";
import { initStore } from "../../src/cli/commands/shared";
import { CliError } from "../../src/cli/errors";
import { loadConfig, saveConfigToPath } from "../../src/config";
import {
  acquireSqliteWriteLock,
  acquireWriteLock,
} from "../../src/core/file-lock";
import { defaultSyncService } from "../../src/ingestion";
import { searchBm25 } from "../../src/pipeline/search";
import { notifyAutomationImport } from "../../src/serve/session-automation";
import {
  admitHookTrigger,
  type AutomationContext,
  heartbeatAutomation,
  disableAutomation,
  enableAutomation,
  removeAutomationProfile,
  runAutomationProfile,
  setAutomationProfile,
  tickAutomation,
} from "../../src/sessions/automation";
import {
  admit,
  AUTOMATION_RUN_STALE_MS,
  beginRun,
  canStart,
  emptyAutomationState,
  emptyProfileRunState,
  finishRun,
  isPending,
  ownsRun,
  profileState,
  loadAutomationState,
  recoverInterrupted,
  scheduleTick,
} from "../../src/sessions/automation-state";
import {
  buildClaudeHookCommand,
  installClaudeHook,
} from "../../src/sessions/claude-hook";
import {
  formatAutomationRunText,
  formatStatusText,
} from "../../src/sessions/format";
import { SessionsService } from "../../src/sessions/service";
import {
  addSessionSource,
  initSessionArchive,
  removeSessionSource,
} from "../../src/sessions/setup";
import { importLockPath } from "../../src/sessions/state";
import { SessionsError } from "../../src/sessions/types";
import { safeRm } from "../helpers/cleanup";
import { FIXTURES, tempDir } from "./helpers";

const INDEX = "sessions";
const MINUTE = 60_000;
const T0 = Date.parse("2026-03-29T00:30:00.000Z");
const FOREIGN_HOOK = { type: "command", command: "echo foreign" };

let root: string;
let configPath: string;
let archiveRoot: string;
let settingsPath: string;
let clock: number;
const env = {
  config: process.env.GNO_CONFIG_DIR,
  data: process.env.GNO_DATA_DIR,
  cache: process.env.GNO_CACHE_DIR,
};

const ctx = (): AutomationContext => ({
  configPath,
  indexName: INDEX,
  now: () => new Date(clock),
});
const dead = (): boolean => false;
const live = (): boolean => true;

async function withStore<T>(
  run: (store: Awaited<ReturnType<typeof openStore>>) => Promise<T>
): Promise<T> {
  const store = await openStore();
  try {
    return await run(store);
  } finally {
    await store.close();
  }
}

async function openStore() {
  const opened = await initStore({
    configPath,
    indexName: INDEX,
    allowEmptyCollections: true,
  });
  if (!opened.ok) throw new Error(opened.error);
  return opened.store;
}

const runNow = (trigger: "manual" | null = "manual") =>
  withStore((store) =>
    runAutomationProfile({ ...ctx(), store, alive: dead }, "main", { trigger })
  );

const tick = (options: { pid?: number; startedAt?: number } = {}) =>
  withStore((store) =>
    tickAutomation({
      ...ctx(),
      store,
      pid: options.pid ?? 4242,
      alive: (pid) => pid === (options.pid ?? 4242),
      daemonStartedAt: new Date(options.startedAt ?? clock),
    })
  );

const hook = (payload: unknown = { hook_event_name: "SessionEnd" }) =>
  admitHookTrigger(ctx(), {
    harness: "claude-code",
    profileId: "main",
    payload,
  });

const profileRun = async () =>
  (await loadAutomationState(archiveRoot)).state.profiles.main;

async function archiveConfig() {
  const loaded = await loadConfig(configPath);
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value;
}

async function status() {
  return new SessionsService({
    config: await archiveConfig(),
    configPath,
    indexName: INDEX,
    now: () => new Date(clock),
  }).status();
}

/** Relative path -> content of every archive file under a collection root. */
async function archiveTree(base: string): Promise<Record<string, string>> {
  const dir = join(base, "work");
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const tree: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    tree[relative(dir, path)] = await Bun.file(path).text();
  }
  return tree;
}

async function expectCode(
  promise: Promise<unknown>,
  code: SessionsError["code"]
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SessionsError);
    expect((error as SessionsError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

async function setupArchive(base: string): Promise<void> {
  configPath = join(base, "archive.yml");
  archiveRoot = join(base, "archive");
  const claudeRoot = join(base, "sources", "claude");
  await mkdir(claudeRoot, { recursive: true });
  await cp(join(FIXTURES, "claude-code", "projects"), claudeRoot, {
    recursive: true,
  });
  await initSessionArchive({
    configPath,
    indexName: INDEX,
    archiveRoot,
    collection: "work",
  });
  await addSessionSource({
    configPath,
    id: "claude",
    harness: "claude-code",
    path: claudeRoot,
    collection: "work",
  });
}

beforeEach(async () => {
  root = await tempDir("gno-sessions-automation-");
  process.env.GNO_CONFIG_DIR = join(root, "gno-config");
  process.env.GNO_DATA_DIR = join(root, "gno-data");
  process.env.GNO_CACHE_DIR = join(root, "gno-cache");
  clock = T0;
  settingsPath = join(root, "claude", "settings.json");
  await mkdir(join(root, "claude"), { recursive: true });
  await Bun.write(
    settingsPath,
    `${JSON.stringify({ model: "x", hooks: { SessionEnd: [{ hooks: [FOREIGN_HOOK] }] } })}\n`
  );
  await setupArchive(root);
  await setAutomationProfile(ctx(), { id: "main", sources: ["claude"] });
});

afterEach(async () => {
  process.env.GNO_CONFIG_DIR = env.config;
  process.env.GNO_DATA_DIR = env.data;
  process.env.GNO_CACHE_DIR = env.cache;
  await safeRm(root);
});

describe("manual by default (R1)", () => {
  test("a new profile enables nothing: hooks skip, ticks run nothing", async () => {
    const before = await status();
    expect(before.automation.profiles[0]).toMatchObject({
      id: "main",
      state: "off",
      hook: null,
      schedule: null,
      pending: null,
    });
    expect(await hook()).toMatchObject({
      outcome: "skipped",
      reason: "hook_disabled",
    });
    clock += 365 * 24 * 60 * MINUTE;
    expect(await tick()).toEqual([]);
    expect(await archiveTree(archiveRoot)).toEqual({});
    expect(await Bun.file(settingsPath).json()).toEqual({
      model: "x",
      hooks: { SessionEnd: [{ hooks: [FOREIGN_HOOK] }] },
    });
  });

  test.each([
    [
      "unknown source",
      () => setAutomationProfile(ctx(), { id: "x", sources: ["nope"] }),
      "SESSIONS_UNKNOWN_SOURCE",
    ],
    [
      "cadence below the minimum",
      () => enableAutomation(ctx(), "main", { schedule: { cadence: "30s" } }),
      "SESSIONS_INVALID_INPUT",
    ],
    [
      "schedule without a cadence",
      () => enableAutomation(ctx(), "main", { schedule: {} }),
      "SESSIONS_INVALID_INPUT",
    ],
    [
      "unsupported hook integration",
      () => enableAutomation(ctx(), "main", { hook: { harness: "codex" } }),
      "SESSIONS_UNSUPPORTED_INTEGRATION",
    ],
    [
      "unknown profile",
      () => enableAutomation(ctx(), "ghost", { schedule: { cadence: "1h" } }),
      "SESSIONS_UNKNOWN_PROFILE",
    ],
  ] as const)(
    "%s fails without enabling anything",
    async (_name, attempt, code) => {
      await expectCode(attempt(), code);
      const current = await status();
      expect(current.automation.profiles.map((p) => p.state)).toEqual(["off"]);
      expect(await Bun.file(settingsPath).json()).toMatchObject({
        hooks: { SessionEnd: [{ hooks: [FOREIGN_HOOK] }] },
      });
    }
  );

  test("unparsable host settings are left untouched and nothing is enabled", async () => {
    await Bun.write(settingsPath, "{ not json");
    await expectCode(
      enableAutomation(ctx(), "main", {
        hook: { harness: "claude-code", settings: settingsPath },
      }),
      "SESSIONS_INVALID_INPUT"
    );
    expect(await Bun.file(settingsPath).text()).toBe("{ not json");
    expect((await status()).automation.profiles[0]?.hook).toBeNull();
  });
});

describe("Claude Code hook entry ownership (R5)", () => {
  test("install keeps foreign hooks, is idempotent, and removal takes only the owned entry", async () => {
    const other = { configPath, indexName: INDEX, profileId: "other" };
    await installClaudeHook(settingsPath, other);
    await enableAutomation(ctx(), "main", {
      hook: { harness: "claude-code", settings: settingsPath },
    });
    const again = await enableAutomation(ctx(), "main", {
      hook: { harness: "claude-code", settings: settingsPath },
    });
    expect(again.hook).toMatchObject({ enabled: true, installed: true });
    const installed = (await Bun.file(settingsPath).json()) as {
      model: string;
      hooks: { SessionEnd: Array<{ hooks: Array<{ command: string }> }> };
    };
    const commands = installed.hooks.SessionEnd.flatMap((group) =>
      group.hooks.map((item) => item.command)
    );
    const mine = buildClaudeHookCommand({ ...other, profileId: "main" });
    expect(commands.filter((command) => command === mine)).toHaveLength(1);
    expect(commands).toContain(FOREIGN_HOOK.command);
    expect(installed.model).toBe("x");

    const removed = await removeAutomationProfile(ctx(), "main");
    expect(removed.hook?.entriesRemoved).toBe(1);
    const after = (await Bun.file(settingsPath).json()) as typeof installed;
    const left = after.hooks.SessionEnd.flatMap((group) =>
      group.hooks.map((item) => item.command)
    );
    expect(left).toEqual([FOREIGN_HOOK.command, buildClaudeHookCommand(other)]);
    expect(await Bun.file(`${settingsPath}.bak`).exists()).toBe(true);
  });
});

describe("hook admission (R2, R4)", () => {
  beforeEach(async () => {
    await enableAutomation(ctx(), "main", {
      hook: { harness: "claude-code", settings: settingsPath },
    });
  });

  test("an accepted hook is durable pending work, not an archival claim; duplicates coalesce", async () => {
    expect(await hook()).toEqual({
      outcome: "accepted",
      profileId: "main",
      daemon: "not_running",
    });
    await hook();
    expect(await archiveTree(archiveRoot)).toEqual({});
    const pending = (await status()).automation.profiles[0];
    expect(pending?.state).toBe("pending");
    expect(pending?.pending?.triggers).toEqual(["hook"]);
    expect(pending?.recovery).toContain("not running: no daemon");

    const results = await tick();
    expect(results.map((result) => result.outcome)).toEqual(["complete"]);
    expect(Object.keys(await archiveTree(archiveRoot))).toHaveLength(3);
    expect(await tick()).toEqual([]);
  });

  test.each([
    [
      "marker lock held past the deadline",
      async () => {
        const lock = await acquireSqliteWriteLock(
          join(archiveRoot, ".gno-sessions", "automation.lock"),
          1000
        );
        try {
          await admitHookTrigger(ctx(), {
            harness: "claude-code",
            profileId: "main",
            payload: null,
            lockWaitMs: 50,
          });
        } finally {
          await lock?.release();
        }
      },
      "SESSIONS_BUSY",
    ],
    [
      "disk full while writing the marker",
      () =>
        admitHookTrigger(ctx(), {
          harness: "claude-code",
          profileId: "main",
          payload: null,
          writeState: () => Promise.reject(new Error("ENOSPC")),
        }),
      null,
    ],
    [
      "archive destination removed",
      async () => {
        await rename(archiveRoot, `${archiveRoot}-moved`);
        await hook();
      },
      "SESSIONS_SOURCE_UNAVAILABLE",
    ],
  ] as const)("%s is never accepted", async (_name, attempt, code) => {
    let failed: unknown;
    try {
      await attempt();
    } catch (error) {
      failed = error;
    }
    expect(failed).toBeDefined();
    if (code) expect((failed as SessionsError).code).toBe(code);
    if (await Bun.file(join(archiveRoot, ".gno-sessions")).exists()) {
      const run = await profileRun();
      expect(run === undefined || !isPending(run)).toBe(true);
    }
  });

  test("the CLI hook entrypoint honours the kill switch and never claims archival", async () => {
    const cli = { configPath, indexName: INDEX };
    process.env.GNO_SESSIONS_HOOKS = "off";
    try {
      expect(
        await runSessionsHook(cli, "claude-code", { profile: "main" })
      ).toContain("skipped");
    } finally {
      delete process.env.GNO_SESSIONS_HOOKS;
    }
    expect(await profileRun()).toBeUndefined();
    expect(
      await runSessionsHook(cli, "claude-code", { profile: "main" })
    ).toContain("pending, not yet archived");
    await rename(archiveRoot, `${archiveRoot}-moved`);
    try {
      await runSessionsHook(cli, "claude-code", { profile: "main" });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toContain("not accepted");
    }
  });

  test("an unexpected event is skipped, not admitted", async () => {
    expect(await hook({ hook_event_name: "PreCompact" })).toMatchObject({
      outcome: "skipped",
      reason: "unexpected_event",
    });
    expect(await profileRun()).toBeUndefined();
  });
});

describe("generation safety, retries and recovery (R4, fake clock)", () => {
  const at = (ms: number) => new Date(T0 + ms);
  const run = (outcome: "complete" | "failed", deferred = 0) => ({
    triggers: ["hook"] as SessionTriggerKind[],
    startedAt: at(0).toISOString(),
    finishedAt: at(0).toISOString(),
    outcome,
    reason: outcome === "failed" ? "busy" : null,
    threads: { imported: 0, updated: 0, unchanged: 0 },
    units: { incomplete: 0, failed: 0, deferred },
  });

  test("a trigger arriving during a run stays pending after it settles", () => {
    const state = emptyProfileRunState();
    admit(state, "hook", at(0), 3);
    const started = beginRun(state, at(0), 1);
    admit(state, "hook", at(1000), 3);
    finishRun(state, started, run("complete"), { retries: 3, now: at(2000) });
    expect(isPending(state)).toBe(true);
    const second = beginRun(state, at(3000), 1);
    finishRun(state, second, run("complete"), { retries: 3, now: at(4000) });
    expect(isPending(state)).toBe(false);
  });

  test("contention backs off and retries; exhaustion waits for the next trigger", () => {
    const state = emptyProfileRunState();
    admit(state, "schedule", at(0), 3);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const started = beginRun(state, at(0), 1);
      finishRun(state, started, run("failed"), {
        retries: 3,
        failure: "contention",
        now: at(0),
      });
    }
    expect(isPending(state)).toBe(true);
    expect(state.retryAt).toBeNull();
    expect(canStart(state, 3, at(10 * 60 * MINUTE), dead)).toBe(false);
    admit(state, "hook", at(11 * 60 * MINUTE), 3);
    expect(canStart(state, 3, at(11 * 60 * MINUTE), dead)).toBe(true);
  });

  test("a permanent failure does not retry automatically", () => {
    const state = emptyProfileRunState();
    admit(state, "hook", at(0), 3);
    const started = beginRun(state, at(0), 1);
    finishRun(state, started, run("failed"), {
      retries: 3,
      failure: "permanent",
      now: at(0),
    });
    expect(state.retryAt).toBeNull();
    expect(canStart(state, 3, at(60 * MINUTE), dead)).toBe(false);
  });

  test("deferred work stays pending; interrupted and implausibly old runs are recovered", () => {
    const state = emptyProfileRunState();
    admit(state, "hook", at(0), 3);
    const started = beginRun(state, at(0), 1);
    finishRun(state, started, run("complete", 5), {
      retries: 3,
      now: at(0),
    });
    expect(isPending(state)).toBe(true);

    beginRun(state, at(0), 99);
    expect(recoverInterrupted(state, at(1000), live)).toBe(false);
    expect(
      recoverInterrupted(state, at(AUTOMATION_RUN_STALE_MS + 1000), live)
    ).toBe(true);
    expect(state.lastRun?.reason).toBe("interrupted");
    expect(isPending(state)).toBe(true);
  });
});

describe("daemon schedule (R3, fake clock)", () => {
  test("elapsed cadence, one coalesced run after sleep, and a clock moved backwards", () => {
    const state = emptyProfileRunState();
    const cadence = 60 * MINUTE;
    expect(scheduleTick(state, cadence, new Date(T0), 3)).toBe(false);
    expect(state.nextDueAt).toBe(new Date(T0 + cadence).toISOString());
    // Laptop asleep across a DST change for 10 cadences: one admission.
    expect(scheduleTick(state, cadence, new Date(T0 + 10 * cadence), 3)).toBe(
      true
    );
    expect(state.generation).toBe(1);
    expect(
      scheduleTick(state, cadence, new Date(T0 + 10 * cadence + 1), 3)
    ).toBe(false);
    // Clock set back by a day: next run is at most one cadence away.
    const back = T0 - 24 * cadence;
    scheduleTick(state, cadence, new Date(back), 3);
    expect(Date.parse(state.nextDueAt!)).toBe(back + cadence);
  });

  test("status shows no schedule without a daemon, then next due from a live heartbeat", async () => {
    await enableAutomation(ctx(), "main", { schedule: { cadence: "1h" } });
    const idle = (await status()).automation;
    expect(idle.daemon.state).toBe("not_running");
    expect(idle.profiles[0]?.schedule).toEqual({
      enabled: true,
      cadence: "1h",
      nextDueAt: null,
    });
    expect(idle.profiles[0]?.recovery).toContain("not running: no daemon");

    await tick({ pid: process.pid });
    const ticking = (await status()).automation;
    expect(ticking.daemon.state).toBe("running");
    expect(ticking.profiles[0]?.schedule?.nextDueAt).toBe(
      new Date(T0 + 60 * MINUTE).toISOString()
    );

    clock += 10 * MINUTE;
    expect((await status()).automation.daemon.state).toBe("stale");
  });

  test("a due schedule imports once and pause stops further runs", async () => {
    await enableAutomation(ctx(), "main", { schedule: { cadence: "1m" } });
    clock += 5 * MINUTE;
    expect((await tick()).map((result) => result.outcome)).toEqual([
      "complete",
    ]);
    clock += 1;
    expect(await tick()).toEqual([]);
    await disableAutomation(ctx(), "main", { schedule: true });
    clock += 60 * MINUTE;
    expect(await tick()).toEqual([]);
    expect((await profileRun())?.nextDueAt).toBeNull();
  });
});

describe("runs (R4, R5, R7)", () => {
  test("a busy importer backs off with pending work kept, then completes", async () => {
    await mkdir(join(archiveRoot, ".gno-sessions"), { recursive: true });
    const held = await acquireWriteLock(importLockPath(archiveRoot), 1000);
    let busy;
    try {
      busy = await runNow();
    } finally {
      await held?.release();
    }
    expect(busy).toMatchObject({
      ran: true,
      outcome: "failed",
      reason: "busy",
    });
    expect(busy.pending).toBe(true);
    const retrying = (await status()).automation.profiles[0];
    expect(retrying?.state).toBe("retrying");
    expect(retrying?.retryAt).not.toBeNull();

    clock += 2 * MINUTE;
    const retried = await runNow(null);
    expect(retried).toMatchObject({ outcome: "complete", pending: false });
    expect((await status()).automation.profiles[0]?.lastSuccessAt).not.toBe(
      null
    );
  });

  test("a revoked source blocks the run until the owner corrects it", async () => {
    await removeSessionSource({ configPath, id: "claude" });
    const result = await runNow();
    expect(result).toMatchObject({
      outcome: "failed",
      reason: "source_revoked",
      pending: true,
    });
    const blocked = (await status()).automation.profiles[0];
    expect(blocked?.state).toBe("failed");
    expect(blocked?.recovery).toContain("no longer registered");
    clock += 60 * MINUTE;
    expect(await runNow(null)).toMatchObject({
      ran: false,
      reason: "retries_exhausted",
    });
  });

  test("pausing clears admitted hook work, and a trigger switched off by hand is dropped at drain", async () => {
    await enableAutomation(ctx(), "main", {
      hook: { harness: "claude-code", settings: settingsPath },
    });
    await hook();
    const paused = await disableAutomation(ctx(), "main");
    expect(paused).toMatchObject({ pendingCleared: true, removed: false });
    expect((await status()).automation.profiles[0]?.state).toBe("off");

    await enableAutomation(ctx(), "main", {
      hook: { harness: "claude-code", settings: settingsPath },
    });
    await hook();
    const config = await archiveConfig();
    config.sessions!.automation![0]!.hook!.enabled = false;
    await saveConfigToPath(config, configPath);
    expect(await runNow(null)).toMatchObject({
      ran: false,
      reason: "trigger_disabled",
      pending: false,
    });
    expect(await archiveTree(archiveRoot)).toEqual({});
  });

  test("the work budget defers the rest to later ticks without duplicates; a rerun is a verified no-op", async () => {
    await setAutomationProfile(ctx(), {
      id: "main",
      sources: ["claude"],
      limit: 1,
    });
    const first = await runNow();
    expect(first).toMatchObject({
      outcome: "partial",
      reason: "deferred",
      pending: true,
    });
    const outcomes: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const results = await tick();
      if (results.length === 0) break;
      outcomes.push(results[0]!.outcome);
    }
    expect(outcomes.at(-1)).toBe("complete");
    expect(Object.keys(await archiveTree(archiveRoot))).toHaveLength(3);
    expect(await runNow()).toMatchObject({ outcome: "up_to_date" });
  });

  test("a run interrupted by process death is redone after a daemon restart", async () => {
    await enableAutomation(ctx(), "main", {
      hook: { harness: "claude-code", settings: settingsPath },
    });
    await hook();
    const { mutateAutomationState } =
      await import("../../src/sessions/automation-state");
    // A daemon took the work and died before settling it.
    await mutateAutomationState(archiveRoot, (state) => {
      beginRun(state.profiles.main!, new Date(clock), 999_999);
    });
    // Restarted daemon reusing the dead daemon's pid: still recovered.
    clock += MINUTE;
    const results = await tick({ pid: 999_999, startedAt: clock });
    expect(results.map((result) => result.outcome)).toEqual(["complete"]);
    const run = await profileRun();
    expect(isPending(run!)).toBe(false);
    expect(Object.keys(await archiveTree(archiveRoot))).toHaveLength(3);
  });

  test("status is path-free and shows the recovery action", async () => {
    await enableAutomation(ctx(), "main", {
      hook: { harness: "claude-code", settings: settingsPath },
    });
    await Bun.write(
      settingsPath,
      `${JSON.stringify({ hooks: { SessionEnd: [{ hooks: [FOREIGN_HOOK] }] } })}\n`
    );
    const current = await status();
    const profile = current.automation.profiles[0];
    expect(profile?.hook).toEqual({
      harness: "claude-code",
      enabled: true,
      installed: false,
    });
    expect(profile?.recovery).toContain("--hook claude-code");
    expect(JSON.stringify(current.automation)).not.toContain(root);
  });
});

describe("manual, hook and scheduled imports are identical (R6)", () => {
  test("same fixtures give the same archive files and search results", async () => {
    const outcomes: Array<{
      tree: Record<string, string>;
      hits: string[];
    }> = [];
    const snapshot = async () => {
      const tree = await archiveTree(archiveRoot);
      const store = await openStore();
      try {
        const result = await searchBm25(store, "widget cache", { limit: 20 });
        if (!result.ok) throw new Error(result.error.message);
        outcomes.push({
          tree,
          hits: result.value.results.map((item) => item.uri).sort(),
        });
      } finally {
        await store.close();
      }
    };

    // Manual: the fn-171 importer called directly.
    const config = await archiveConfig();
    await withStore((store) =>
      new SessionsService({
        config,
        configPath,
        indexName: INDEX,
        store,
      }).import({ sourceId: "claude" }, { allowPaths: false })
    );
    await snapshot();

    // Hook: admission, then a daemon drain.
    process.env.GNO_DATA_DIR = join(root, "hook", "gno-data");
    await setupArchive(join(root, "hook"));
    await setAutomationProfile(ctx(), { id: "main", sources: ["claude"] });
    await enableAutomation(ctx(), "main", {
      hook: { harness: "claude-code", settings: settingsPath },
    });
    await hook();
    await tick();
    await snapshot();

    // Schedule: a due daemon tick.
    process.env.GNO_DATA_DIR = join(root, "schedule", "gno-data");
    await setupArchive(join(root, "schedule"));
    await setAutomationProfile(ctx(), { id: "main", sources: ["claude"] });
    await enableAutomation(ctx(), "main", { schedule: { cadence: "1m" } });
    clock += 2 * MINUTE;
    await tick();
    await snapshot();

    expect(Object.keys(outcomes[0]!.tree).length).toBeGreaterThan(0);
    expect(outcomes[0]!.hits.length).toBeGreaterThan(0);
    expect(outcomes[1]).toEqual(outcomes[0]!);
    expect(outcomes[2]).toEqual(outcomes[0]!);
  });
});

describe("review round 1 regressions", () => {
  const at = (ms: number) => new Date(T0 + ms);
  const failed = {
    triggers: ["hook"] as SessionTriggerKind[],
    startedAt: at(0).toISOString(),
    finishedAt: at(0).toISOString(),
    outcome: "failed" as const,
    reason: "source_revoked",
    threads: { imported: 0, updated: 0, unchanged: 0 },
    units: { incomplete: 0, failed: 0, deferred: 0 },
  };

  test("schedule ticks keep a pending backoff and a permanent block; only an owner action clears it", () => {
    const backoff = emptyProfileRunState();
    admit(backoff, "schedule", at(0), 3);
    finishRun(backoff, beginRun(backoff, at(0), 1), failed, {
      retries: 3,
      failure: "transient",
      now: at(0),
    });
    const retryAt = backoff.retryAt;
    expect(scheduleTick(backoff, MINUTE, at(30_000), 3)).toBe(false);
    backoff.nextDueAt = at(0).toISOString();
    expect(scheduleTick(backoff, MINUTE, at(30_000), 3)).toBe(true);
    expect(backoff.retryAt).toBe(retryAt);
    expect(canStart(backoff, 3, at(30_000), dead)).toBe(false);

    const blocked = emptyProfileRunState();
    admit(blocked, "hook", at(0), 3);
    finishRun(blocked, beginRun(blocked, at(0), 1), failed, {
      retries: 3,
      failure: "permanent",
      now: at(0),
    });
    blocked.nextDueAt = at(0).toISOString();
    expect(scheduleTick(blocked, MINUTE, at(60 * MINUTE), 3)).toBe(true);
    admit(blocked, "hook", at(60 * MINUTE), 3);
    expect(canStart(blocked, 3, at(60 * MINUTE), dead)).toBe(false);
    admit(blocked, "manual", at(61 * MINUTE), 3);
    expect(canStart(blocked, 3, at(61 * MINUTE), dead)).toBe(true);
  });

  test("a run whose profile was removed and recreated settles nothing", async () => {
    await enableAutomation(ctx(), "main", {
      hook: { harness: "claude-code", settings: settingsPath },
    });
    await hook();
    let replaced = false;
    const result = await withStore((store) =>
      runAutomationProfile(
        {
          ...ctx(),
          store,
          alive: dead,
          syncService: {
            syncCollection:
              defaultSyncService.syncCollection.bind(defaultSyncService),
            syncPaths: async (...args) => {
              if (!replaced) {
                replaced = true;
                // A removal that raced the run's start, then a recreated
                // profile with fresh admitted work.
                const { mutateAutomationState } =
                  await import("../../src/sessions/automation-state");
                await mutateAutomationState(archiveRoot, (state) => {
                  delete state.profiles.main;
                  admit(
                    profileState(state, "main"),
                    "hook",
                    new Date(clock),
                    3
                  );
                });
              }
              return defaultSyncService.syncPaths(...args);
            },
          },
        },
        "main",
        { trigger: null }
      )
    );
    expect(result).toMatchObject({ ran: true, outcome: "complete" });
    const run = await profileRun();
    expect(isPending(run!)).toBe(true);
    expect(run?.running).toBeNull();
    expect(run?.lastRun).toBeNull();

    const state = emptyAutomationState();
    const started = beginRun(profileState(state, "p"), at(0), 1);
    delete state.profiles.p;
    expect(ownsRun(profileState(state, "p"), started)).toBe(false);
  });

  test("a running profile is not removed, so its run stays visible", async () => {
    await enableAutomation(ctx(), "main", { schedule: { cadence: "1h" } });
    const { mutateAutomationState } =
      await import("../../src/sessions/automation-state");
    await mutateAutomationState(archiveRoot, (state) => {
      beginRun(profileState(state, "main"), new Date(clock), process.pid);
    });
    const before = await Bun.file(configPath).text();
    await expectCode(removeAutomationProfile(ctx(), "main"), "SESSIONS_BUSY");
    expect(await Bun.file(configPath).text()).toBe(before);
    expect((await status()).automation.profiles[0]?.state).toBe("running");
  });

  test("a run starting while removal is under way never starts", async () => {
    const { getConfigWriteLockPath } =
      await import("../../src/core/config-write-lock");
    // Park the removal inside the marker lock, waiting for the config lock.
    const configLock = await acquireWriteLock(
      await getConfigWriteLockPath(configPath),
      1000
    );
    const removal = removeAutomationProfile(ctx(), "main");
    await Bun.sleep(400);
    const run = runNow().catch((error: unknown) => error);
    await Bun.sleep(200);
    await configLock?.release();
    const [removed, ran] = await Promise.all([removal, run]);
    expect(removed.removed).toBe(true);
    expect(ran).toMatchObject({ ran: false, reason: "profile_removed" });
    expect(await archiveTree(archiveRoot)).toEqual({});
  });

  test("moving the hook to another settings file uninstalls the old entry", async () => {
    const other = join(root, "claude", "other.json");
    await Bun.write(other, "{}\n");
    await enableAutomation(ctx(), "main", {
      hook: { harness: "claude-code", settings: settingsPath },
    });
    await enableAutomation(ctx(), "main", {
      hook: { harness: "claude-code", settings: other },
    });
    const commands = async (path: string) => {
      const json = (await Bun.file(path).json()) as {
        hooks?: { SessionEnd?: Array<{ hooks: Array<{ command: string }> }> };
      };
      return (json.hooks?.SessionEnd ?? []).flatMap((group) =>
        group.hooks.map((item) => item.command)
      );
    };
    expect(await commands(settingsPath)).toEqual([FOREIGN_HOOK.command]);
    expect(await commands(other)).toHaveLength(1);
    await removeAutomationProfile(ctx(), "main");
    expect(await commands(other)).toEqual([]);
    expect(await commands(settingsPath)).toEqual([FOREIGN_HOOK.command]);
  });

  test("a mismatched index cannot change a profile", async () => {
    const before = await Bun.file(configPath).text();
    await expectCode(
      setAutomationProfile(
        { ...ctx(), indexName: "other" },
        { id: "main", sources: ["claude"], limit: 5 }
      ),
      "SESSIONS_BINDING_MISMATCH"
    );
    expect(await Bun.file(configPath).text()).toBe(before);
  });

  test("the profile ID constructor admits and drains like any other", async () => {
    await setAutomationProfile(ctx(), {
      id: "constructor",
      sources: ["claude"],
    });
    await enableAutomation(ctx(), "constructor", {
      hook: { harness: "claude-code", settings: settingsPath },
    });
    expect(
      await admitHookTrigger(ctx(), {
        harness: "claude-code",
        profileId: "constructor",
        payload: null,
      })
    ).toMatchObject({ outcome: "accepted" });
    expect((await tick()).map((result) => result.outcome)).toEqual([
      "complete",
    ]);
    const current = await status();
    expect(
      current.automation.profiles.find((p) => p.id === "constructor")?.state
    ).toBe("idle");
  });

  test("daemon imports queue embedding for the synced collections", async () => {
    const result = await runNow();
    const calls: string[][] = [];
    let marked = 0;
    notifyAutomationImport(result, {
      markMutation: () => {
        marked += 1;
      },
      notifySyncComplete: (collections) => calls.push(collections),
    });
    expect(calls).toEqual([["work"]]);
    expect(marked).toBe(1);
    notifyAutomationImport(await runNow(), {
      markMutation: () => {
        marked += 1;
      },
      notifySyncComplete: (collections) => calls.push(collections),
    });
    // An up-to-date rerun synced nothing, so nothing is queued.
    expect(marked).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

describe("live QA regressions", () => {
  test.each(["banana", "5s"])(
    "a hand-edited invalid cadence (%s) is reported off with a warning and never runs",
    async (cadence) => {
      const config = await archiveConfig();
      config.sessions!.automation![0]!.schedule = { enabled: true, cadence };
      await saveConfigToPath(config, configPath);
      await heartbeatAutomation({
        ...ctx(),
        pid: process.pid,
        daemonStartedAt: new Date(clock),
      }).catch(() => undefined);
      clock += 24 * 60 * MINUTE;
      expect(await tick()).toEqual([]);
      const current = await status();
      const profile = current.automation.profiles[0]!;
      expect(profile.schedule).toMatchObject({ enabled: false, cadence });
      expect(profile.state).toBe("off");
      expect(profile.recovery).toContain(`"${cadence}" is invalid`);
      expect(current.warnings.join(" ")).toContain(`"${cadence}" is invalid`);
    }
  );

  test("the heartbeat alone keeps a busy daemon reported as running", async () => {
    await enableAutomation(ctx(), "main", { schedule: { cadence: "1h" } });
    await tick({ pid: process.pid });
    clock += 20 * MINUTE;
    expect((await status()).automation.daemon.state).toBe("stale");
    await heartbeatAutomation({
      ...ctx(),
      pid: process.pid,
      daemonStartedAt: new Date(T0),
    });
    expect((await status()).automation.daemon.state).toBe("running");
  });

  test("a hook for an unknown profile says so", async () => {
    expect(
      await admitHookTrigger(ctx(), {
        harness: "claude-code",
        profileId: "ghost",
        payload: null,
      })
    ).toEqual({
      outcome: "skipped",
      profileId: "ghost",
      reason: "unknown_profile",
    });
  });

  test("--settings must name an existing file unless it is the default location", async () => {
    const missing = join(root, "claude", "nope.json");
    await expectCode(
      enableAutomation(ctx(), "main", {
        hook: { harness: "claude-code", settings: missing },
      }),
      "SESSIONS_INVALID_INPUT"
    );
    expect(await Bun.file(missing).exists()).toBe(false);
    const home = join(root, "claude-home");
    const created = await enableAutomation(
      { ...ctx(), env: { CLAUDE_CONFIG_DIR: home } },
      "main",
      { hook: { harness: "claude-code" } }
    );
    expect(created.hook.settings).toBe(join(home, "settings.json"));
    expect(await Bun.file(join(home, "settings.json")).exists()).toBe(true);
  });
});

// chmod cannot make a directory unreadable on Windows or for root.
const canRevokeRead = process.platform !== "win32" && process.getuid?.() !== 0;

describe("fn-171 unreadable source through automation", () => {
  test.each(
    canRevokeRead
      ? (["missing", "unreadable"] as const)
      : (["missing"] as const)
  )(
    "a %s source root fails the run as source_unavailable and keeps lastSuccessAt",
    async (kind) => {
      expect(await runNow()).toMatchObject({ outcome: "complete" });
      const success = (await profileRun())?.lastSuccessAt;
      expect(success).toBeTruthy();
      const claudeRoot = join(root, "sources", "claude");
      if (kind === "missing") await rename(claudeRoot, `${claudeRoot}-gone`);
      else await chmod(claudeRoot, 0o000);
      try {
        clock += MINUTE;
        const result = await runNow();
        expect(result).toMatchObject({
          ran: true,
          outcome: "failed",
          reason: "source_unavailable",
        });
        const profile = (await status()).automation.profiles[0]!;
        expect(profile.state).toBe("failed");
        expect(profile.lastRun?.outcome).toBe("failed");
        expect(profile.lastSuccessAt).toBe(success ?? "");
        expect(profile.recovery).toContain("missing or unreadable");
      } finally {
        if (kind === "unreadable") await chmod(claudeRoot, 0o755);
      }
    }
  );
});

describe("re-drive QA regressions", () => {
  test("preview reports an invalid hand-edited cadence as off with a warning", async () => {
    const config = await archiveConfig();
    config.sessions!.automation![0]!.schedule = {
      enabled: true,
      cadence: "banana",
    };
    await saveConfigToPath(config, configPath);
    const { previewAutomationProfile } =
      await import("../../src/sessions/automation");
    const preview = await previewAutomationProfile(ctx(), "main");
    expect(preview.schedule).toMatchObject({
      enabled: false,
      cadence: "banana",
    });
    const text = formatAutomationPreview(preview, false);
    expect(text).toContain("Schedule: off");
    expect(text).toContain('warning: cadence "banana" is invalid');
  });

  test("a source_unavailable failure reads as a failure with an action, not queued work", async () => {
    expect(await runNow()).toMatchObject({ outcome: "complete" });
    const claudeRoot = join(root, "sources", "claude");
    await rename(claudeRoot, `${claudeRoot}-gone`);
    const failed = await runNow();
    expect(failed).toMatchObject({ outcome: "failed", pending: true });
    const line = formatAutomationRunText(failed);
    expect(line).not.toContain("pending");
    expect(line).toContain("recovery action");
    expect(formatAutomationRunText({ ...failed, reason: "busy" })).toContain(
      "retried automatically"
    );
    const text = formatStatusText(await status());
    expect(text).not.toContain("pending since");
    expect(text).toContain(
      "action: A selected source or the archive destination is missing"
    );
  });
});
