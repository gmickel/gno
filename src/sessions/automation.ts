/**
 * Opt-in session automation: owner profile management, host-hook admission,
 * and the one run path shared by daemon drains and explicit run-now.
 *
 * Hooks and schedule ticks only mark a profile pending (see
 * automation-state); the import itself is always the manual importer
 * (SessionsService.import) over the profile's registered sources, so
 * parsing, redaction, routing and checkpoints have one implementation.
 * Nothing here enables itself: every trigger is switched on by an explicit
 * owner call, and every run rechecks the owner config first.
 *
 * @module src/sessions/automation
 */

// node:fs/promises mkdir/stat: directory structure ops without Bun equivalents.
import { mkdir, stat } from "node:fs/promises";
// node:path: no Bun path utilities.
import { isAbsolute, join, resolve } from "node:path";

import type { Config } from "../config/types";
import type { SqliteAdapter } from "../store/sqlite/adapter";
import type { SessionAutomationProfile, SessionsConfig } from "./config";
import type { SessionsServiceDeps } from "./service";

import { getIndexDbPath } from "../app/constants";
import { loadConfig } from "../config";
import { applyConfigFileChange } from "../core/config-mutation";
import { SESSION_STATE_DIRNAME } from "./archive";
import {
  admit,
  type AutomationState,
  beginRun,
  canStart,
  classifyRunError,
  clearPending,
  finishRun,
  HOOK_ADMISSION_DEADLINE_MS,
  isPending,
  isProcessAlive,
  isRunLive,
  loadAutomationState,
  mutateAutomationState,
  ownProfile,
  ownsRun,
  profileState,
  recoverInterrupted,
  type RunFailureClass,
  scheduleTick,
  type StartedRun,
  type StateWriter,
  unblock,
} from "./automation-state";
import {
  automationCadenceMs,
  daemonState,
  profileCollections,
  profileLimit,
  profileRetries,
  scheduleRunnable,
} from "./automation-status";
import { canonicalConfigPath, assertSessionBinding } from "./binding";
import {
  buildClaudeHookCommand,
  defaultClaudeSettingsPath,
  type HookIdentity,
  inspectClaudeHook,
  installClaudeHook,
  removeClaudeHook,
} from "./claude-hook";
import {
  SESSION_HOOK_HARNESSES,
  SessionAutomationProfileSchema,
  type SessionHookHarness,
} from "./config";
import { SessionsService } from "./service";
import { canonicalPath } from "./sources";
import {
  type SessionAutomationRunResult,
  type SessionImportReceipt,
  type SessionRunRecord,
  SessionsError,
  type SessionTriggerKind,
} from "./types";

export interface AutomationContext {
  /** Archive config path (the config the hook and daemon are bound to). */
  configPath: string;
  indexName: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface SessionAutomationPreview {
  schemaVersion: "1";
  profileId: string;
  configPath: string;
  index: string;
  archiveRoot: string;
  sources: Array<{
    id: string;
    harness: string | null;
    path: string | null;
    available: boolean;
    collection: string | null;
    projects: Array<{ prefix: string; collection: string }>;
  }>;
  collections: string[];
  hook: {
    harness: SessionHookHarness;
    enabled: boolean;
    settings: string;
    command: string;
    installed: boolean | null;
  };
  schedule: { enabled: boolean; cadence: string | null; minimum: "1m" };
  limit: number;
  retries: number;
  daemon: { state: "running" | "not_running" | "stale"; command: string };
  notes: string[];
}

export interface SessionAutomationChange {
  schemaVersion: "1";
  profileId: string;
  hook: { enabled: boolean; entriesRemoved: number } | null;
  schedule: { enabled: boolean } | null;
  /** Admitted work that was cleared because its trigger was switched off. */
  pendingCleared: boolean;
  /** A run already in progress finishes (bounded by the limit); nothing new starts. */
  running: { startedAt: string } | null;
  removed: boolean;
  warnings: string[];
}

const nowOf = (ctx: AutomationContext): Date => ctx.now?.() ?? new Date();

async function loadArchive(
  ctx: AutomationContext
): Promise<{ config: Config; sessions: SessionsConfig }> {
  const loaded = await loadConfig(ctx.configPath);
  if (!loaded.ok) {
    throw new SessionsError(
      "SESSIONS_NOT_CONFIGURED",
      "The session archive config could not be loaded."
    );
  }
  if (!loaded.value.sessions) {
    throw new SessionsError(
      "SESSIONS_NOT_CONFIGURED",
      "No session archive is configured for this config."
    );
  }
  await assertSessionBinding({
    config: loaded.value,
    configPath: ctx.configPath,
    indexName: ctx.indexName,
    dbPath: getIndexDbPath(ctx.indexName),
  });
  return { config: loaded.value, sessions: loaded.value.sessions };
}

const unknownProfile = (id: string): SessionsError =>
  new SessionsError(
    "SESSIONS_UNKNOWN_PROFILE",
    `Unknown automation profile "${id}".`
  );

function findProfile(
  sessions: SessionsConfig,
  id: string
): SessionAutomationProfile {
  const profile = sessions.automation?.find((item) => item.id === id);
  if (!profile) {
    throw new SessionsError(
      "SESSIONS_UNKNOWN_PROFILE",
      `Unknown automation profile "${id}". Configured: ${(sessions.automation ?? []).map((item) => item.id).join(", ") || "(none)"}.`
    );
  }
  return profile;
}

async function hookIdentity(
  ctx: AutomationContext,
  profileId: string
): Promise<HookIdentity> {
  return {
    configPath: await canonicalConfigPath(ctx.configPath),
    indexName: ctx.indexName,
    profileId,
  };
}

function validCadence(cadence: string): string {
  if (automationCadenceMs(cadence) === null) {
    throw new SessionsError(
      "SESSIONS_INVALID_INPUT",
      `Cadence "${cadence}" is invalid: use <n>s|m|h|d between 1m and 30d (elapsed time, e.g. 30m or 6h).`
    );
  }
  return cadence;
}

/** Create the state directory under an existing archive root. */
async function ensureStateDir(archiveRoot: string): Promise<void> {
  const root = await stat(archiveRoot).catch(() => null);
  if (!root?.isDirectory()) {
    throw new SessionsError(
      "SESSIONS_SOURCE_UNAVAILABLE",
      "The session archive destination is missing; recreate it with gno sessions init."
    );
  }
  await mkdir(join(archiveRoot, SESSION_STATE_DIRNAME), { recursive: true });
}

async function stateDirExists(archiveRoot: string): Promise<boolean> {
  const dir = await stat(join(archiveRoot, SESSION_STATE_DIRNAME)).catch(
    () => null
  );
  return dir?.isDirectory() === true;
}

type ProfileEdit = (
  profile: SessionAutomationProfile | undefined,
  sessions: SessionsConfig
) => SessionAutomationProfile | null;

/** Apply one profile change to the owner config under the config lock. */
async function editProfile(
  ctx: AutomationContext,
  id: string,
  edit: ProfileEdit
): Promise<SessionsConfig> {
  const result = await applyConfigFileChange(
    { configPath: ctx.configPath },
    (config) => {
      const sessions = config.sessions;
      if (!sessions) {
        return {
          ok: false,
          code: "SESSIONS_NOT_CONFIGURED",
          error: "No session archive is configured for this config.",
        };
      }
      const profiles = sessions.automation ?? [];
      let next: SessionAutomationProfile | null;
      try {
        next = edit(
          profiles.find((item) => item.id === id),
          sessions
        );
      } catch (error) {
        if (!(error instanceof SessionsError)) throw error;
        return { ok: false, code: error.code, error: error.message };
      }
      const others = profiles.filter((item) => item.id !== id);
      const automation = next
        ? profiles.some((item) => item.id === id)
          ? profiles.map((item) => (item.id === id ? next : item))
          : [...profiles, next]
        : others;
      if (automation.length > 16) {
        return {
          ok: false,
          code: "SESSIONS_INVALID_INPUT",
          error: "At most 16 automation profiles per archive.",
        };
      }
      const { automation: _drop, ...rest } = sessions;
      return {
        ok: true,
        config: {
          ...config,
          sessions: automation.length > 0 ? { ...rest, automation } : rest,
        },
      };
    }
  );
  if (!result.ok) {
    const code = (
      result.code.startsWith("SESSIONS_")
        ? result.code
        : "SESSIONS_INVALID_INPUT"
    ) as SessionsError["code"];
    throw new SessionsError(code, result.error);
  }
  return result.config.sessions as SessionsConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// Owner management (local surfaces only)
// ─────────────────────────────────────────────────────────────────────────────

export interface SetProfileInput {
  id: string;
  sources: string[];
  cadence?: string;
  limit?: number;
  retries?: number;
}

/**
 * Create or reconfigure a profile. Triggers keep their current state; a new
 * profile starts with every trigger off.
 */
export async function setAutomationProfile(
  ctx: AutomationContext,
  input: SetProfileInput
): Promise<SessionAutomationPreview> {
  if (input.cadence !== undefined) validCadence(input.cadence);
  // Binding first: a mismatched pair must not change the archive config.
  const { sessions: current } = await loadArchive(ctx);
  await editProfile(ctx, input.id, (existing, sessions) => {
    for (const sourceId of input.sources) {
      if (!sessions.sources.some((source) => source.id === sourceId)) {
        throw new SessionsError(
          "SESSIONS_UNKNOWN_SOURCE",
          `Unknown session source "${sourceId}". Register it first with gno sessions source add.`
        );
      }
    }
    const candidate = {
      ...existing,
      id: input.id,
      sources: input.sources,
      ...(input.cadence !== undefined
        ? {
            schedule: {
              enabled: existing?.schedule?.enabled ?? false,
              cadence: input.cadence,
            },
          }
        : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.retries !== undefined ? { retries: input.retries } : {}),
    };
    const parsed = SessionAutomationProfileSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new SessionsError(
        "SESSIONS_INVALID_INPUT",
        `Invalid automation profile: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "profile"}: ${issue.message}`).join("; ")}`
      );
    }
    return parsed.data;
  });
  await settleState(ctx, current, input.id, unblock);
  return previewAutomationProfile(ctx, input.id);
}

/** What a profile would run: sources, destinations, triggers, prerequisites. */
export async function previewAutomationProfile(
  ctx: AutomationContext,
  id: string,
  options: { settings?: string } = {}
): Promise<SessionAutomationPreview> {
  const { sessions } = await loadArchive(ctx);
  const profile = findProfile(sessions, id);
  const identity = await hookIdentity(ctx, id);
  const settings =
    options.settings ??
    profile.hook?.settings ??
    defaultClaudeSettingsPath(ctx.env);
  const { state } = await loadAutomationState(sessions.archiveRoot);
  const daemon = daemonState(state.daemon, nowOf(ctx));
  const sources = await Promise.all(
    profile.sources.map(async (sourceId) => {
      const source = sessions.sources.find((item) => item.id === sourceId);
      return {
        id: sourceId,
        harness: source?.harness ?? null,
        path: source?.path ?? null,
        available: source ? (await canonicalPath(source.path)) !== null : false,
        collection: source?.collection ?? null,
        projects: source?.projects ?? [],
      };
    })
  );
  const configPath = identity.configPath;
  const daemonCommand = `gno --config ${configPath} --index ${ctx.indexName} daemon`;
  const notes: string[] = [];
  if (!profile.hook?.enabled && !profile.schedule?.enabled) {
    notes.push(
      `Nothing runs automatically until you enable a trigger: gno --config ${configPath} --index ${ctx.indexName} sessions automation enable ${id} --hook claude-code and/or --schedule --cadence <n>s|m|h|d.`
    );
  }
  notes.push(
    `Hooks only mark this profile pending; imports run in \`${daemonCommand}\` (currently ${daemon === "running" ? "running" : "not running: no daemon"}) or with \`sessions automation run ${id}\`. GNO never installs or starts a service.`,
    "Schedules use elapsed time and tick only while that daemon runs; `gno serve` never runs them.",
    "Imports use each source's registered collection and project mappings; hooks cannot add sources or change destinations."
  );
  if (sources.some((source) => source.harness === null)) {
    notes.push(
      "A selected source is no longer registered; runs fail until the profile is corrected."
    );
  }
  return {
    schemaVersion: "1",
    profileId: id,
    configPath,
    index: ctx.indexName,
    archiveRoot: sessions.archiveRoot,
    sources,
    collections: profileCollections(sessions, profile),
    hook: {
      harness: "claude-code",
      enabled: profile.hook?.enabled === true,
      settings,
      command: buildClaudeHookCommand(identity),
      installed: await inspectClaudeHook(settings, identity),
    },
    schedule: {
      enabled: profile.schedule?.enabled === true,
      cadence: profile.schedule?.cadence ?? null,
      minimum: "1m",
    },
    limit: profileLimit(profile),
    retries: profileRetries(profile),
    daemon: { state: daemon, command: daemonCommand },
    notes,
  };
}

export interface EnableInput {
  hook?: { harness: string; settings?: string };
  schedule?: { cadence?: string };
}

/** Explicitly switch on a hook and/or the daemon schedule for one profile. */
export async function enableAutomation(
  ctx: AutomationContext,
  id: string,
  input: EnableInput
): Promise<SessionAutomationPreview> {
  if (!input.hook && !input.schedule) {
    throw new SessionsError(
      "SESSIONS_INVALID_INPUT",
      "Choose what to enable: --hook claude-code and/or --schedule --cadence <n>s|m|h|d."
    );
  }
  const { sessions } = await loadArchive(ctx);
  const profile = findProfile(sessions, id);
  let settings: string | undefined;
  if (input.hook) {
    const harness = input.hook.harness;
    if (!(SESSION_HOOK_HARNESSES as readonly string[]).includes(harness)) {
      throw new SessionsError(
        "SESSIONS_UNSUPPORTED_INTEGRATION",
        `No verified hook for "${harness}". Supported: ${SESSION_HOOK_HARNESSES.join(", ")}. Other harnesses import manually or on a daemon schedule.`
      );
    }
    const harnesses = profile.sources.map(
      (sourceId) =>
        sessions.sources.find((source) => source.id === sourceId)?.harness
    );
    if (!harnesses.includes("claude-code")) {
      throw new SessionsError(
        "SESSIONS_INVALID_INPUT",
        "The Claude Code hook needs a registered claude-code source in the profile."
      );
    }
    settings =
      input.hook.settings ??
      profile.hook?.settings ??
      defaultClaudeSettingsPath(ctx.env);
    if (!isAbsolute(settings)) {
      throw new SessionsError(
        "SESSIONS_INVALID_INPUT",
        "The Claude Code settings path must be absolute."
      );
    }
    settings = resolve(settings);
    // Only the documented default location may be created; any other file
    // must already exist as a settings file the owner names explicitly.
    const isDefault = settings === resolve(defaultClaudeSettingsPath(ctx.env));
    if (input.hook.settings !== undefined && !isDefault) {
      const file = await stat(settings).catch(() => null);
      if (!file?.isFile()) {
        throw new SessionsError(
          "SESSIONS_INVALID_INPUT",
          "--settings must name an existing Claude Code settings file; only the default settings.json is created when missing."
        );
      }
    }
  }
  let cadence: string | undefined;
  if (input.schedule) {
    const requested = input.schedule.cadence ?? profile.schedule?.cadence;
    if (!requested) {
      throw new SessionsError(
        "SESSIONS_INVALID_INPUT",
        "Scheduling needs an explicit elapsed cadence: --cadence <n>s|m|h|d (at least 1m)."
      );
    }
    cadence = validCadence(requested);
  }
  await ensureStateDir(sessions.archiveRoot);
  if (settings) {
    const identity = await hookIdentity(ctx, id);
    const previous = profile.hook?.settings;
    if (previous && resolve(previous) !== settings) {
      // Moving to another settings file: remove the old owned entry first
      // (fails closed), so no untracked integration keeps firing.
      await removeClaudeHook(previous, identity);
    }
    // Install before recording: a settings file that cannot be edited
    // leaves the profile unchanged.
    await installClaudeHook(settings, identity);
  }
  await editProfile(ctx, id, (existing) => {
    if (!existing) throw unknownProfile(id);
    return {
      ...existing,
      ...(settings
        ? {
            hook: {
              harness: "claude-code" as const,
              enabled: true,
              settings,
            },
          }
        : {}),
      ...(cadence ? { schedule: { enabled: true, cadence } } : {}),
    };
  });
  const cadenceMs = cadence ? automationCadenceMs(cadence) : null;
  await mutateAutomationState(sessions.archiveRoot, (state) => {
    // Enabling is an owner action: it clears a block awaiting correction.
    const existing = ownProfile(state, id);
    if (existing) unblock(existing);
    // Like the findings pass: the first scheduled run is one cadence away.
    if (cadenceMs !== null) {
      const run = profileState(state, id);
      run.nextDueAt = new Date(nowOf(ctx).getTime() + cadenceMs).toISOString();
    }
  });
  return previewAutomationProfile(ctx, id);
}

/**
 * Drop admitted work of switched-off trigger kinds; manual run requests and
 * kinds still enabled stay pending.
 */
function dropTriggers(
  run: ReturnType<typeof profileState>,
  kinds: SessionTriggerKind[]
): boolean {
  if (!isPending(run)) return false;
  const remaining = run.pendingTriggers.filter((kind) => !kinds.includes(kind));
  if (remaining.length > 0) {
    run.pendingTriggers = remaining;
    return false;
  }
  clearPending(run);
  return true;
}

/** Pause: switch triggers off, uninstall the owned hook entry, clear pending. */
export async function disableAutomation(
  ctx: AutomationContext,
  id: string,
  which: { hook?: boolean; schedule?: boolean } = {}
): Promise<SessionAutomationChange> {
  const both = which.hook === undefined && which.schedule === undefined;
  const hook = both || which.hook === true;
  const schedule = both || which.schedule === true;
  const { sessions } = await loadArchive(ctx);
  const profile = findProfile(sessions, id);
  // Config first: a hook that fires from now on sees the trigger disabled.
  await editProfile(ctx, id, (existing) => {
    if (!existing) throw unknownProfile(id);
    return {
      ...existing,
      ...(hook && existing.hook
        ? { hook: { ...existing.hook, enabled: false } }
        : {}),
      ...(schedule && existing.schedule
        ? { schedule: { ...existing.schedule, enabled: false } }
        : {}),
    };
  });
  const warnings: string[] = [];
  let entriesRemoved = 0;
  if (hook && profile.hook) {
    try {
      entriesRemoved = (
        await removeClaudeHook(
          profile.hook.settings,
          await hookIdentity(ctx, id)
        )
      ).removed;
    } catch (error) {
      warnings.push(
        `The hook is disabled, but its entry could not be removed from the Claude Code settings: ${(error as Error).message}`
      );
    }
  }
  const settled = await settleState(ctx, sessions, id, (run) => {
    if (schedule) run.nextDueAt = null;
    const kinds: SessionTriggerKind[] = [
      ...(hook ? (["hook"] as const) : []),
      ...(schedule ? (["schedule"] as const) : []),
    ];
    return dropTriggers(run, kinds);
  });
  return {
    schemaVersion: "1",
    profileId: id,
    hook: hook && profile.hook ? { enabled: false, entriesRemoved } : null,
    schedule: schedule && profile.schedule ? { enabled: false } : null,
    pendingCleared: settled.value ?? false,
    running: settled.running,
    removed: false,
    warnings,
  };
}

async function settleState<T>(
  ctx: AutomationContext,
  sessions: SessionsConfig,
  id: string,
  change: (run: ReturnType<typeof profileState>) => T
): Promise<{ value: T | null; running: { startedAt: string } | null }> {
  if (!(await stateDirExists(sessions.archiveRoot))) {
    return { value: null, running: null };
  }
  return mutateAutomationState(sessions.archiveRoot, (state) => {
    const run = ownProfile(state, id);
    if (!run) return { value: null, running: null };
    const value = change(run);
    return {
      value,
      running: isRunLive(run.running, nowOf(ctx))
        ? { startedAt: run.running!.startedAt }
        : null,
    };
  });
}

/** Uninstall owned integrations and delete the profile. Archives stay. */
export async function removeAutomationProfile(
  ctx: AutomationContext,
  id: string
): Promise<SessionAutomationChange> {
  const { sessions } = await loadArchive(ctx);
  const profile = findProfile(sessions, id);
  const identity = await hookIdentity(ctx, id);
  // Runs start under the marker lock after rechecking the profile, so doing
  // the whole removal under that lock means a run either started first (and
  // removal refuses, keeping it visible) or never starts.
  const remove = async (
    state: AutomationState | null
  ): Promise<{ entriesRemoved: number; pendingCleared: boolean }> => {
    const run = state ? ownProfile(state, id) : undefined;
    if (isRunLive(run?.running ?? null, nowOf(ctx))) {
      throw new SessionsError(
        "SESSIONS_BUSY",
        `Automation profile "${id}" is running. Pause it with disable (nothing new starts), then remove it once status shows the run finished.`
      );
    }
    // Fails closed: an unreadable settings file keeps the profile, so the
    // owned entry never outlives the profile that can remove it.
    const entriesRemoved = profile.hook
      ? (await removeClaudeHook(profile.hook.settings, identity)).removed
      : 0;
    await editProfile(ctx, id, () => null);
    if (state) delete state.profiles[id];
    return { entriesRemoved, pendingCleared: run ? isPending(run) : false };
  };
  // With the archive gone no run can start (runs need its state directory),
  // so only then is the lock-free path safe.
  const archivePresent = await ensureStateDir(sessions.archiveRoot).then(
    () => true,
    () => false
  );
  const removed = archivePresent
    ? await mutateAutomationState(sessions.archiveRoot, remove)
    : await remove(null);
  return {
    schemaVersion: "1",
    profileId: id,
    hook: profile.hook
      ? { enabled: false, entriesRemoved: removed.entriesRemoved }
      : null,
    schedule: profile.schedule ? { enabled: false } : null,
    pendingCleared: removed.pendingCleared,
    running: null,
    removed: true,
    warnings: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook admission (foreground, tiny)
// ─────────────────────────────────────────────────────────────────────────────

export type HookAdmission =
  | {
      outcome: "accepted";
      profileId: string;
      daemon: "running" | "not_running" | "stale";
    }
  | { outcome: "skipped"; profileId: string; reason: string };

/**
 * Durably mark a profile pending for one host hook event. No parsing, no
 * import, no network: it validates the event, rechecks the owner config under
 * the marker lock, and returns once the marker is on disk. Errors mean the
 * event was not accepted.
 */
export async function admitHookTrigger(
  ctx: AutomationContext,
  input: {
    harness: SessionHookHarness;
    profileId: string;
    payload: unknown;
    lockWaitMs?: number;
    writeState?: StateWriter;
  }
): Promise<HookAdmission> {
  const payload = input.payload;
  if (
    payload !== null &&
    (typeof payload !== "object" ||
      Array.isArray(payload) ||
      ("hook_event_name" in payload &&
        (payload as { hook_event_name: unknown }).hook_event_name !==
          "SessionEnd"))
  ) {
    return {
      outcome: "skipped",
      profileId: input.profileId,
      reason: "unexpected_event",
    };
  }
  const { sessions } = await loadArchive(ctx);
  const configured = sessions.automation?.find(
    (item) => item.id === input.profileId
  );
  if (!configured) {
    return {
      outcome: "skipped",
      profileId: input.profileId,
      reason: "unknown_profile",
    };
  }
  const enabled = configured.hook;
  if (!enabled?.enabled || enabled.harness !== input.harness) {
    // Nothing to admit: the state file is not touched.
    return {
      outcome: "skipped",
      profileId: input.profileId,
      reason: "hook_disabled",
    };
  }
  return mutateAutomationState(
    sessions.archiveRoot,
    async (state): Promise<HookAdmission> => {
      // Reread under the lock so a concurrent disable is always honoured.
      const fresh = await loadArchive(ctx);
      const profile = fresh.sessions.automation?.find(
        (item) => item.id === input.profileId
      );
      if (!profile) {
        return {
          outcome: "skipped",
          profileId: input.profileId,
          reason: "unknown_profile",
        };
      }
      if (!profile.hook?.enabled || profile.hook.harness !== input.harness) {
        return {
          outcome: "skipped",
          profileId: input.profileId,
          reason: "hook_disabled",
        };
      }
      const now = nowOf(ctx);
      admit(
        profileState(state, profile.id),
        "hook",
        now,
        profileRetries(profile)
      );
      return {
        outcome: "accepted",
        profileId: profile.id,
        daemon: daemonState(state.daemon, now),
      };
    },
    {
      lockWaitMs: input.lockWaitMs ?? HOOK_ADMISSION_DEADLINE_MS,
      writeState: input.writeState,
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Runs (daemon drain and explicit run-now)
// ─────────────────────────────────────────────────────────────────────────────

export interface AutomationRunDeps extends AutomationContext {
  store: SqliteAdapter;
  syncService?: SessionsServiceDeps["syncService"];
  pid?: number;
  alive?: (pid: number) => boolean;
  /** Daemon drains take the shared write lease around the imports. */
  acquireLease?: () => Promise<
    { ok: true; release: () => Promise<void> } | { ok: false }
  >;
}

function summarizeRun(
  receipts: SessionImportReceipt[],
  triggers: SessionTriggerKind[],
  startedAt: Date,
  finishedAt: Date,
  failed: { reason: string } | null
): SessionRunRecord {
  const sum = (pick: (receipt: SessionImportReceipt) => number): number =>
    receipts.reduce((total, receipt) => total + pick(receipt), 0);
  const record: SessionRunRecord = {
    triggers,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    outcome: "complete",
    reason: null,
    threads: {
      imported: sum((r) => r.counts.imported),
      updated: sum((r) => r.counts.updated),
      unchanged: sum((r) => r.counts.unchanged),
    },
    units: {
      incomplete: sum((r) => r.counts.incomplete),
      failed: sum((r) => r.counts.failed + r.counts.unsupported),
      deferred: sum((r) => r.deferredUnits),
    },
  };
  if (failed) return { ...record, outcome: "failed", reason: failed.reason };
  if (receipts.some((receipt) => receipt.status === "failed")) {
    return { ...record, outcome: "failed", reason: "import_failed" };
  }
  if (receipts.some((receipt) => receipt.status === "partial")) {
    let reason = "unit_failures";
    if (receipts.some((receipt) => receipt.lexical.status === "failed")) {
      reason = "index_sync_failed";
    } else if (record.units.deferred > 0) reason = "deferred";
    else if (record.units.incomplete > 0) reason = "incomplete_units";
    return { ...record, outcome: "partial", reason };
  }
  if (receipts.every((receipt) => receipt.status === "nothing_to_do")) {
    return { ...record, outcome: "up_to_date" };
  }
  return record;
}

type Begun =
  | {
      started: StartedRun;
      profile: SessionAutomationProfile;
      config: Config;
    }
  | { started: null; reason: string; pending: boolean };

/**
 * Run one profile through the manual importer. `trigger: "manual"` admits an
 * explicit run request first; `null` drains work already pending. Returns
 * `ran: false` when nothing may start (busy, backoff, trigger switched off).
 */
export async function runAutomationProfile(
  deps: AutomationRunDeps,
  profileId: string,
  options: { trigger: "manual" | null }
): Promise<SessionAutomationRunResult> {
  const alive = deps.alive ?? isProcessAlive;
  const pid = deps.pid ?? process.pid;
  const { sessions } = await loadArchive(deps);
  findProfile(sessions, profileId);
  await ensureStateDir(sessions.archiveRoot);

  const begun = await mutateAutomationState(
    sessions.archiveRoot,
    async (state): Promise<Begun> => {
      // Authority is rechecked from the owner config under the marker lock.
      const fresh = await loadArchive(deps);
      const profile = fresh.sessions.automation?.find(
        (item) => item.id === profileId
      );
      if (!profile) {
        return { started: null, reason: "profile_removed", pending: false };
      }
      const now = nowOf(deps);
      const run = profileState(state, profileId);
      recoverInterrupted(run, now, alive);
      if (options.trigger) {
        admit(run, options.trigger, now, profileRetries(profile));
      }
      const allowed = run.pendingTriggers.filter(
        (kind) =>
          kind === "manual" ||
          (kind === "hook" && profile.hook?.enabled === true) ||
          (kind === "schedule" && scheduleRunnable(profile))
      );
      if (isPending(run) && allowed.length === 0) {
        clearPending(run);
        return { started: null, reason: "trigger_disabled", pending: false };
      }
      run.pendingTriggers = allowed;
      const retries = profileRetries(profile);
      if (!canStart(run, retries, now, alive)) {
        let reason = "nothing_pending";
        if (isRunLive(run.running, now, alive)) reason = "busy";
        else if (isPending(run)) {
          reason = run.attempts > retries ? "retries_exhausted" : "backoff";
        }
        return { started: null, reason, pending: isPending(run) };
      }
      return {
        started: beginRun(run, now, pid),
        profile,
        config: fresh.config,
      };
    }
  );
  if (begun.started === null) {
    return {
      schemaVersion: "1",
      profileId,
      ran: false,
      outcome: "not_started",
      reason: begun.reason,
      pending: begun.pending,
      receipts: [],
    };
  }

  const { profile, config, started } = begun;
  const startedAt = nowOf(deps);
  const receipts: SessionImportReceipt[] = [];
  let failure: { failure: RunFailureClass; reason: string } | null = null;
  const lease = deps.acquireLease ? await deps.acquireLease() : null;
  if (lease && !lease.ok) {
    failure = { failure: "contention", reason: "busy" };
  } else {
    try {
      // Archive collections added since the store opened must exist in it.
      const synced = await deps.store.syncCollections(config.collections);
      if (!synced.ok) {
        throw new SessionsError(
          "SESSIONS_RUNTIME_FAILURE",
          "Archive collections could not be synced into the index."
        );
      }
      const service = new SessionsService({
        config,
        configPath: deps.configPath,
        indexName: deps.indexName,
        store: deps.store,
        syncService: deps.syncService,
        now: deps.now,
      });
      for (const sourceId of profile.sources) {
        if (
          !config.sessions?.sources.some((source) => source.id === sourceId)
        ) {
          throw new SessionsError(
            "SESSIONS_UNKNOWN_SOURCE",
            "A profile source is no longer registered."
          );
        }
        receipts.push(
          await service.import(
            { sourceId, limit: profileLimit(profile) },
            { allowPaths: false }
          )
        );
      }
    } catch (error) {
      failure = classifyRunError(
        error instanceof SessionsError ? error.code : null
      );
    } finally {
      if (lease?.ok) await lease.release().catch(() => undefined);
    }
  }
  const record = summarizeRun(
    receipts,
    started.triggers,
    startedAt,
    nowOf(deps),
    failure
  );
  const failureClass: RunFailureClass | undefined =
    record.outcome === "failed" ? (failure?.failure ?? "permanent") : undefined;
  const pending = await mutateAutomationState(sessions.archiveRoot, (state) => {
    const run = ownProfile(state, profileId);
    // Removed (or removed and recreated) mid-run: this run no longer owns
    // the record, so it settles nothing and consumes nothing.
    if (!run || !ownsRun(run, started)) return false;
    finishRun(run, started, record, {
      retries: profileRetries(profile),
      failure: failureClass,
      now: nowOf(deps),
    });
    return isPending(run);
  });
  return {
    schemaVersion: "1",
    profileId,
    ran: true,
    outcome: record.outcome,
    reason: record.reason,
    pending,
    receipts,
  };
}

/**
 * One daemon tick: heartbeat, coalesced schedule admissions, recovery of
 * interrupted runs, then a drain of every profile that may start. Archives
 * without automation profiles are left untouched.
 */
/**
 * Daemon heartbeat, written on its own timer so a long import or the
 * daemon's initial sync never makes a live daemon look absent. Archives
 * without automation profiles are left untouched.
 */
export async function heartbeatAutomation(
  deps: AutomationContext & { pid?: number; daemonStartedAt: Date }
): Promise<void> {
  const { sessions } = await loadArchive(deps);
  if (
    (sessions.automation ?? []).length === 0 ||
    !(await stateDirExists(sessions.archiveRoot))
  ) {
    return;
  }
  await mutateAutomationState(
    sessions.archiveRoot,
    (state) => {
      state.daemon = {
        pid: deps.pid ?? process.pid,
        startedAt: deps.daemonStartedAt.toISOString(),
        heartbeatAt: nowOf(deps).toISOString(),
      };
    },
    { lockWaitMs: HOOK_ADMISSION_DEADLINE_MS }
  );
}

export async function tickAutomation(
  deps: AutomationRunDeps & { daemonStartedAt: Date }
): Promise<SessionAutomationRunResult[]> {
  const { sessions } = await loadArchive(deps);
  const profiles = sessions.automation ?? [];
  if (profiles.length === 0 || !(await stateDirExists(sessions.archiveRoot))) {
    return [];
  }
  const pid = deps.pid ?? process.pid;
  const alive = deps.alive ?? isProcessAlive;
  const daemonStart = deps.daemonStartedAt.getTime();
  const eligible = await mutateAutomationState(
    sessions.archiveRoot,
    (state) => {
      const now = nowOf(deps);
      state.daemon = {
        pid,
        startedAt: deps.daemonStartedAt.toISOString(),
        heartbeatAt: now.toISOString(),
      };
      const ids: string[] = [];
      for (const profile of profiles) {
        const cadenceMs = scheduleRunnable(profile)
          ? automationCadenceMs(profile.schedule?.cadence)
          : null;
        let run = ownProfile(state, profile.id);
        if (cadenceMs !== null) {
          run = profileState(state, profile.id);
          scheduleTick(run, cadenceMs, now, profileRetries(profile));
        } else if (run) run.nextDueAt = null;
        if (!run) continue;
        // A record from this daemon's own pid that predates it is a leftover
        // of an earlier process that happened to get the same pid.
        const ownLeftover =
          run.running?.pid === pid &&
          Date.parse(run.running.startedAt) < daemonStart;
        recoverInterrupted(run, now, (value) =>
          ownLeftover ? false : alive(value)
        );
        if (canStart(run, profileRetries(profile), now, alive)) {
          ids.push(profile.id);
        }
      }
      return ids;
    }
  );
  const results: SessionAutomationRunResult[] = [];
  for (const id of eligible) {
    results.push(await runAutomationProfile(deps, id, { trigger: null }));
  }
  return results;
}
