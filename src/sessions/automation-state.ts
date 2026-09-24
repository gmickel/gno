/**
 * Machine-written automation run state: one coalesced pending marker per
 * profile plus the daemon heartbeat.
 *
 * Lives in `<archiveRoot>/.gno-sessions/automation.json` beside the import
 * checkpoint, never in the owner's config. Every change is serialized by
 * `automation.lock` and written atomically (private temp file, fsync,
 * rename, directory fsync), so an admission is acknowledged only once it is
 * durable. Transitions are pure functions over the loaded record so they can
 * be driven with a fake clock.
 *
 * Generation contract: a trigger increments `generation`; a run records the
 * generation it started with and a completed run consumes only that one, so a
 * trigger arriving mid-run stays pending. Nothing here imports or parses
 * sessions.
 *
 * @module src/sessions/automation-state
 */

// node:fs/promises: fsync (FileHandle.sync), rename, chmod and stat have no Bun equivalents.
import { chmod, open, rename, stat, unlink } from "node:fs/promises";
// node:path: no Bun path utilities.
import { dirname, join } from "node:path";

import type {
  SessionRunRecord,
  SessionTriggerKind,
  SessionsErrorCode,
} from "./types";

import { acquireSqliteWriteLock } from "../core/file-lock";
import { SESSION_STATE_DIRNAME } from "./archive";
import { SessionsError } from "./types";

export const AUTOMATION_STATE_VERSION = "1";
/** Daemon wake-up: heartbeat, schedule check and pending drain. */
export const AUTOMATION_TICK_MS = 30_000;
/** A heartbeat older than this means the daemon is gone or stuck. */
export const AUTOMATION_HEARTBEAT_STALE_MS = 3 * AUTOMATION_TICK_MS;
/** Longest a hook waits for the marker lock before reporting a failure. */
export const HOOK_ADMISSION_DEADLINE_MS = 1_000;
/** Default changed units per source per run. */
export const DEFAULT_AUTOMATION_LIMIT = 200;
/** Default automatic retries after a failed run. */
export const DEFAULT_AUTOMATION_RETRIES = 3;
/** Shortest schedule cadence; imports enumerate every unit of a source. */
export const MIN_AUTOMATION_CADENCE_MS = 60_000;
/** A recorded run older than this is treated as interrupted (pid reuse). */
export const AUTOMATION_RUN_STALE_MS = 2 * 60 * 60_000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;

export interface ProfileRunState {
  /** Latest admitted trigger generation. */
  generation: number;
  /** Generation consumed by the last completed run. */
  consumed: number;
  pendingSince: string | null;
  pendingTriggers: SessionTriggerKind[];
  lastTrigger: { kind: SessionTriggerKind; at: string } | null;
  running: {
    generation: number;
    triggers: SessionTriggerKind[];
    startedAt: string;
    pid: number;
  } | null;
  lastRun: SessionRunRecord | null;
  lastSuccessAt: string | null;
  /** Consecutive failed attempts since the last success or owner action. */
  attempts: number;
  /** A failure that needs owner correction; automatic triggers cannot clear it. */
  blocked?: boolean;
  retryAt: string | null;
  nextDueAt: string | null;
}

export interface AutomationState {
  schemaVersion: typeof AUTOMATION_STATE_VERSION;
  daemon: { pid: number; startedAt: string; heartbeatAt: string } | null;
  profiles: Record<string, ProfileRunState>;
}

export const emptyAutomationState = (): AutomationState => ({
  schemaVersion: AUTOMATION_STATE_VERSION,
  daemon: null,
  profiles: {},
});

export const emptyProfileRunState = (): ProfileRunState => ({
  generation: 0,
  consumed: 0,
  pendingSince: null,
  pendingTriggers: [],
  lastTrigger: null,
  running: null,
  lastRun: null,
  lastSuccessAt: null,
  attempts: 0,
  retryAt: null,
  nextDueAt: null,
});

const stateDir = (archiveRoot: string): string =>
  join(archiveRoot, SESSION_STATE_DIRNAME);

export const automationStatePath = (archiveRoot: string): string =>
  join(stateDir(archiveRoot), "automation.json");

const automationLockPath = (archiveRoot: string): string =>
  join(stateDir(archiveRoot), "automation.lock");

/** Read the state; a missing file is empty, a corrupt one is reported. */
export async function loadAutomationState(
  archiveRoot: string
): Promise<{ state: AutomationState; corrupt: boolean }> {
  const file = Bun.file(automationStatePath(archiveRoot));
  if (!(await file.exists())) {
    return { state: emptyAutomationState(), corrupt: false };
  }
  try {
    const parsed = (await file.json()) as AutomationState;
    if (
      parsed?.schemaVersion === AUTOMATION_STATE_VERSION &&
      typeof parsed.profiles === "object" &&
      parsed.profiles !== null
    ) {
      return { state: parsed, corrupt: false };
    }
  } catch {
    // Reported below; the next durable write replaces the file.
  }
  return { state: emptyAutomationState(), corrupt: true };
}

export type StateWriter = (path: string, content: string) => Promise<void>;

/** Private (0600) atomic write that is on disk before it returns. */
async function writeDurable(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp.${process.pid}.${crypto.randomUUID()}`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  // Persist the rename itself. Directory fsync is unsupported on Windows.
  const directory = await open(dirname(path), "r").catch(() => null);
  await directory?.sync().catch(() => undefined);
  await directory?.close();
}

/**
 * Load, mutate and durably save the state under the marker lock. The
 * archive's state directory must already exist: a removed destination is
 * reported, never silently recreated.
 */
export async function mutateAutomationState<T>(
  archiveRoot: string,
  mutate: (state: AutomationState) => T | Promise<T>,
  options: { lockWaitMs?: number; writeState?: StateWriter } = {}
): Promise<T> {
  const directory = await stat(stateDir(archiveRoot)).catch(() => null);
  if (!directory?.isDirectory()) {
    throw new SessionsError(
      "SESSIONS_SOURCE_UNAVAILABLE",
      "The session archive destination is missing; recreate it with gno sessions init, then re-enable automation."
    );
  }
  const lock = await acquireSqliteWriteLock(
    automationLockPath(archiveRoot),
    options.lockWaitMs ?? 5_000
  );
  if (!lock) {
    throw new SessionsError(
      "SESSIONS_BUSY",
      "Automation state is locked by another process; retry shortly."
    );
  }
  try {
    const { state } = await loadAutomationState(archiveRoot);
    const result = await mutate(state);
    await (options.writeState ?? writeDurable)(
      automationStatePath(archiveRoot),
      `${JSON.stringify(state)}\n`
    );
    return result;
  } finally {
    await lock.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure transitions
// ─────────────────────────────────────────────────────────────────────────────

/** Own-property lookup: profile IDs such as `constructor` are valid. */
export function ownProfile(
  state: AutomationState,
  id: string
): ProfileRunState | undefined {
  return Object.hasOwn(state.profiles, id) ? state.profiles[id] : undefined;
}

export function profileState(
  state: AutomationState,
  id: string
): ProfileRunState {
  const existing = ownProfile(state, id);
  if (existing) return existing;
  const created = emptyProfileRunState();
  state.profiles[id] = created;
  return created;
}

export const isPending = (profile: ProfileRunState): boolean =>
  profile.generation > profile.consumed;

/** Owner action (run now, reconfigure, enable): a fresh attempt budget. */
export function unblock(profile: ProfileRunState): void {
  profile.attempts = 0;
  profile.retryAt = null;
  profile.blocked = false;
}

/**
 * Record one trigger. Duplicate triggers coalesce into the same pending run.
 * An explicit `manual` trigger resets the retry budget; automatic triggers
 * keep a pending backoff and a permanent block, and only re-arm a transient
 * failure whose retries are used up.
 */
export function admit(
  profile: ProfileRunState,
  kind: SessionTriggerKind,
  now: Date,
  retries: number
): number {
  profile.generation += 1;
  profile.pendingSince ??= now.toISOString();
  if (!profile.pendingTriggers.includes(kind)) {
    profile.pendingTriggers.push(kind);
  }
  profile.lastTrigger = { kind, at: now.toISOString() };
  if (kind === "manual") unblock(profile);
  else if (!profile.blocked && profile.attempts > retries) {
    profile.attempts = 0;
    profile.retryAt = null;
  }
  return profile.generation;
}

/** Disable/pause: drop admitted work that has not started. */
export function clearPending(profile: ProfileRunState): void {
  profile.consumed = profile.generation;
  profile.pendingSince = null;
  profile.pendingTriggers = [];
  profile.attempts = 0;
  profile.retryAt = null;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A run is live while its process exists and it is not implausibly old. */
export function isRunLive(
  running: ProfileRunState["running"],
  now: Date,
  alive: (pid: number) => boolean = isProcessAlive
): boolean {
  if (!running) return false;
  const age = now.getTime() - Date.parse(running.startedAt);
  return alive(running.pid) && !(age > AUTOMATION_RUN_STALE_MS);
}

/**
 * A run whose process is gone was interrupted: its generation was never
 * consumed, so the work stays pending and is retried.
 */
export function recoverInterrupted(
  profile: ProfileRunState,
  now: Date,
  alive: (pid: number) => boolean = isProcessAlive
): boolean {
  if (!profile.running || isRunLive(profile.running, now, alive)) return false;
  profile.lastRun = {
    triggers: profile.running.triggers,
    startedAt: profile.running.startedAt,
    finishedAt: now.toISOString(),
    outcome: "failed",
    reason: "interrupted",
    threads: { imported: 0, updated: 0, unchanged: 0 },
    units: { incomplete: 0, failed: 0, deferred: 0 },
  };
  profile.running = null;
  profile.retryAt = null;
  return true;
}

/** Whether pending work may start now (no live run, backoff elapsed, budget left). */
export function canStart(
  profile: ProfileRunState,
  retries: number,
  now: Date,
  alive: (pid: number) => boolean = isProcessAlive
): boolean {
  if (!isPending(profile)) return false;
  if (isRunLive(profile.running, now, alive)) return false;
  if (profile.attempts > retries) return false;
  return (
    profile.retryAt === null || Date.parse(profile.retryAt) <= now.getTime()
  );
}

export type StartedRun = NonNullable<ProfileRunState["running"]>;

export function beginRun(
  profile: ProfileRunState,
  now: Date,
  pid: number
): StartedRun {
  const started: StartedRun = {
    generation: profile.generation,
    triggers: [...profile.pendingTriggers],
    startedAt: now.toISOString(),
    pid,
  };
  profile.running = { ...started, triggers: [...started.triggers] };
  return started;
}

/** Whether `profile` still records exactly this run (not a removed/replaced one). */
export const ownsRun = (
  profile: ProfileRunState,
  started: StartedRun
): boolean =>
  profile.running?.pid === started.pid &&
  profile.running.startedAt === started.startedAt &&
  profile.running.generation === started.generation;

/** Failure classes: contention and transient errors back off; the rest wait for a fix. */
export type RunFailureClass = "contention" | "transient" | "permanent";

export function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), RETRY_MAX_MS);
}

/**
 * Settle a run. Success consumes the started generation (a trigger that
 * arrived meanwhile stays pending); deferred work keeps it pending for the
 * next tick; a failure keeps it pending with backoff or, when permanent or
 * out of retries, until the next trigger.
 */
export function finishRun(
  profile: ProfileRunState,
  started: { generation: number },
  run: SessionRunRecord,
  options: { retries: number; failure?: RunFailureClass; now: Date }
): void {
  profile.running = null;
  profile.lastRun = run;
  if (run.outcome === "failed") {
    if (options.failure === "permanent") profile.blocked = true;
    profile.attempts =
      options.failure === "permanent"
        ? options.retries + 1
        : profile.attempts + 1;
    profile.retryAt =
      profile.attempts <= options.retries
        ? new Date(
            options.now.getTime() + retryDelayMs(profile.attempts)
          ).toISOString()
        : null;
    return;
  }
  // A partial run settles its generation but is not a successful completion.
  if (run.outcome !== "partial") profile.lastSuccessAt = run.finishedAt;
  unblock(profile);
  if (run.units.deferred > 0) return;
  profile.consumed = Math.max(profile.consumed, started.generation);
  if (!isPending(profile)) {
    profile.pendingSince = null;
    profile.pendingTriggers = [];
  }
}

/**
 * Elapsed-cadence schedule. Missed intervals (sleep, restart, a stopped
 * daemon) coalesce into one admission; a clock moved backwards cannot push
 * the next run further than one cadence away.
 */
export function scheduleTick(
  profile: ProfileRunState,
  cadenceMs: number,
  now: Date,
  retries: number
): boolean {
  const nowMs = now.getTime();
  const due = profile.nextDueAt ? Date.parse(profile.nextDueAt) : Number.NaN;
  if (!Number.isFinite(due) || due - nowMs > cadenceMs) {
    profile.nextDueAt = new Date(nowMs + cadenceMs).toISOString();
    return false;
  }
  if (due > nowMs) return false;
  admit(profile, "schedule", now, retries);
  profile.nextDueAt = new Date(nowMs + cadenceMs).toISOString();
  return true;
}

/** Stable, content-free classification of a failed run's error. */
export function classifyRunError(code: SessionsErrorCode | null): {
  failure: RunFailureClass;
  reason: string;
} {
  switch (code) {
    case "SESSIONS_BUSY":
      return { failure: "contention", reason: "busy" };
    case "SESSIONS_UNKNOWN_SOURCE":
    case "SESSIONS_UNKNOWN_PROFILE":
      return { failure: "permanent", reason: "source_revoked" };
    case "SESSIONS_SOURCE_UNAVAILABLE":
      return { failure: "permanent", reason: "source_unavailable" };
    case "SESSIONS_UNKNOWN_COLLECTION":
    case "SESSIONS_NOT_CONFIGURED":
    case "SESSIONS_BINDING_MISMATCH":
    case "SESSIONS_INVALID_INPUT":
    case "SESSIONS_UNSAFE_PATH":
      return { failure: "permanent", reason: "invalid_configuration" };
    default:
      return { failure: "transient", reason: "runtime_error" };
  }
}
