/**
 * Reader-facing automation status, shared by every surface. Path-free: it
 * reports profile and source IDs, collections, triggers, times, outcomes and
 * recovery actions, never host paths or session content.
 *
 * @module src/sessions/automation-status
 */

import type { SessionAutomationProfile, SessionsConfig } from "./config";
import type {
  SessionAutomationStatus,
  SessionProfileState,
  SessionProfileStatus,
} from "./types";

import { parseFindingsCadenceMs } from "../config/types";
import {
  AUTOMATION_HEARTBEAT_STALE_MS,
  type AutomationState,
  DEFAULT_AUTOMATION_LIMIT,
  DEFAULT_AUTOMATION_RETRIES,
  isPending,
  isProcessAlive,
  isRunLive,
  loadAutomationState,
  MIN_AUTOMATION_CADENCE_MS,
  ownProfile,
  type ProfileRunState,
} from "./automation-state";
import { inspectClaudeHook } from "./claude-hook";

/** Parse a profile cadence; null when malformed or below the minimum. */
export function automationCadenceMs(
  cadence: string | undefined
): number | null {
  if (!cadence) return null;
  const ms = parseFindingsCadenceMs(cadence);
  return ms !== null && ms >= MIN_AUTOMATION_CADENCE_MS ? ms : null;
}

/** Enabled with a valid cadence; a hand-edited invalid cadence never runs. */
export const scheduleRunnable = (profile: SessionAutomationProfile): boolean =>
  profile.schedule?.enabled === true &&
  automationCadenceMs(profile.schedule.cadence) !== null;

export const profileLimit = (profile: SessionAutomationProfile): number =>
  profile.limit ?? DEFAULT_AUTOMATION_LIMIT;

export const profileRetries = (profile: SessionAutomationProfile): number =>
  profile.retries ?? DEFAULT_AUTOMATION_RETRIES;

export function profileCollections(
  sessions: SessionsConfig,
  profile: SessionAutomationProfile
): string[] {
  const names = new Set<string>();
  for (const source of sessions.sources) {
    if (!profile.sources.includes(source.id)) continue;
    names.add(source.collection);
    for (const mapping of source.projects ?? []) names.add(mapping.collection);
  }
  return [...names].sort();
}

export function daemonState(
  daemon: AutomationState["daemon"],
  now: Date,
  alive: (pid: number) => boolean = isProcessAlive
): SessionAutomationStatus["daemon"]["state"] {
  if (!daemon || !alive(daemon.pid)) return "not_running";
  return now.getTime() - Date.parse(daemon.heartbeatAt) <=
    AUTOMATION_HEARTBEAT_STALE_MS
    ? "running"
    : "stale";
}

const RECOVERY: Record<string, string> = {
  source_revoked:
    "A selected source is no longer registered: register it again or update the profile's sources with `gno sessions automation set`.",
  source_unavailable:
    "A selected source or the archive destination is missing or unreadable: fix it, then run `gno sessions automation run <profile>`.",
  invalid_configuration:
    "The archive config no longer matches this profile (collection, binding or source settings): correct it, then run `gno sessions automation run <profile>`.",
  import_failed:
    "Every processed unit failed: check `gno sessions status` and the receipt of `gno sessions automation run <profile>`.",
};

function recoveryFor(
  profile: SessionAutomationProfile,
  run: ProfileRunState | undefined,
  state: SessionProfileState,
  installed: boolean | null,
  daemon: SessionAutomationStatus["daemon"]["state"]
): string | null {
  const id = profile.id;
  if (
    profile.schedule?.enabled &&
    automationCadenceMs(profile.schedule.cadence) === null
  ) {
    return `The schedule cadence "${profile.schedule.cadence}" is invalid, so the schedule does not run: fix it with \`gno sessions automation set ${id} --source … --cadence 30m\` (<n>s|m|h|d, 1m to 30d).`;
  }
  if (profile.hook?.enabled && installed === false) {
    return `The Claude Code hook entry is missing from its settings file: run \`gno sessions automation enable ${id} --hook claude-code\` to reinstall it.`;
  }
  if (profile.hook?.enabled && installed === null) {
    return `The Claude Code settings file could not be read: fix it, then run \`gno sessions automation enable ${id} --hook claude-code\`.`;
  }
  if (state === "failed" || state === "retrying") {
    const reason = run?.lastRun?.reason ?? "";
    const known = RECOVERY[reason];
    if (known) return known.replace("<profile>", id);
    if (state === "failed") {
      return `Automatic retries are exhausted: check \`gno sessions status\`, then run \`gno sessions automation run ${id}\`.`;
    }
  }
  // A live run needs no action; suggesting "run now" would only hit busy.
  if (state === "running") return null;
  const scheduled = scheduleRunnable(profile);
  if (
    daemon !== "running" &&
    (scheduled || state === "pending" || state === "retrying")
  ) {
    return `not running: no daemon. Schedules and admitted hook work run only while \`gno daemon\` runs on this archive's config and index; or run \`gno sessions automation run ${id}\` now.`;
  }
  if (state === "partial") {
    return "The last run left incomplete or deferred units; the next run retries them.";
  }
  return null;
}

function deriveState(
  profile: SessionAutomationProfile,
  run: ProfileRunState | undefined,
  now: Date,
  alive: (pid: number) => boolean
): SessionProfileState {
  const retries = profile.retries ?? DEFAULT_AUTOMATION_RETRIES;
  if (run && isRunLive(run.running, now, alive)) return "running";
  if (run && isPending(run)) {
    if (run.attempts > retries) return "failed";
    return run.retryAt ? "retrying" : "pending";
  }
  const enabled = profile.hook?.enabled || scheduleRunnable(profile);
  if (!enabled) return "off";
  if (run?.lastRun?.outcome === "failed") return "failed";
  if (run?.lastRun?.outcome === "partial") return "partial";
  return "idle";
}

/** Automation status for one archive; `warnings` joins the sessions status. */
export async function readAutomationStatus(input: {
  sessions: SessionsConfig;
  configPath: string;
  indexName: string;
  now?: Date;
  alive?: (pid: number) => boolean;
}): Promise<{ status: SessionAutomationStatus; warnings: string[] }> {
  const now = input.now ?? new Date();
  const alive = input.alive ?? isProcessAlive;
  const profiles = input.sessions.automation ?? [];
  const { state, corrupt } = await loadAutomationState(
    input.sessions.archiveRoot
  );
  const warnings = corrupt
    ? [
        "automation run state was unreadable; pending admissions recorded in it are lost and the next trigger starts fresh",
      ]
    : [];
  const daemon = daemonState(state.daemon, now, alive);
  const result: SessionProfileStatus[] = [];
  for (const profile of profiles) {
    const run = ownProfile(state, profile.id);
    const installed = profile.hook
      ? await inspectClaudeHook(profile.hook.settings, {
          configPath: input.configPath,
          indexName: input.indexName,
          profileId: profile.id,
        })
      : null;
    const profileState = deriveState(profile, run, now, alive);
    const cadenceValid = automationCadenceMs(profile.schedule?.cadence);
    if (profile.schedule && cadenceValid === null) {
      warnings.push(
        `automation profile ${profile.id}: cadence "${profile.schedule.cadence}" is invalid (use <n>s|m|h|d, 1m to 30d); the schedule is reported off and does not run`
      );
    }
    const pending = run && isPending(run) && run.pendingSince;
    result.push({
      id: profile.id,
      sources: [...profile.sources],
      collections: profileCollections(input.sessions, profile),
      state: profileState,
      hook: profile.hook
        ? {
            harness: profile.hook.harness,
            enabled: profile.hook.enabled,
            installed,
          }
        : null,
      schedule: profile.schedule
        ? {
            // Effective state: an invalid cadence (warned above) never runs.
            enabled: scheduleRunnable(profile),
            cadence: profile.schedule.cadence,
            // A due time is only real while a daemon is ticking.
            nextDueAt:
              scheduleRunnable(profile) && daemon === "running"
                ? (run?.nextDueAt ?? null)
                : null,
          }
        : null,
      limit: profileLimit(profile),
      retries: profileRetries(profile),
      pending: pending
        ? { since: pending, triggers: [...(run?.pendingTriggers ?? [])] }
        : null,
      running:
        run?.running && isRunLive(run.running, now, alive)
          ? {
              startedAt: run.running.startedAt,
              triggers: [...run.running.triggers],
            }
          : null,
      lastTrigger: run?.lastTrigger ?? null,
      lastRun: run?.lastRun ?? null,
      lastSuccessAt: run?.lastSuccessAt ?? null,
      retryAt: run?.retryAt ?? null,
      recovery: recoveryFor(profile, run, profileState, installed, daemon),
    });
  }
  return {
    status: {
      daemon: { state: daemon, heartbeatAt: state.daemon?.heartbeatAt ?? null },
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      profiles: result,
    },
    warnings,
  };
}
