/**
 * Scheduled findings pass: config resolution and persisted last-run state.
 *
 * The state file lives next to the index database (data dir, never inside a
 * collection) so `gno daemon --status` and `gno doctor` can read it without
 * contacting the daemon. Writes are atomic (temp + rename, mode 0600).
 *
 * @module src/core/findings-run-state
 */

// node:fs/promises: atomic rename/unlink and temp-dir creation have no Bun equivalent.
import { chmod, mkdtemp, rename, rmdir, unlink } from "node:fs/promises";
// node:path: dirname/join/basename have no Bun path utilities.
import { basename, dirname, join } from "node:path";

import type { Collection, Config } from "../config/types";

import { getIndexDbPath } from "../app/constants";
import { parseFindingsCadenceMs } from "../config/types";

export const FINDINGS_RUN_STATE_SCHEMA_VERSION = "1.0";

/** Outcome of the most recent attempt. `pending` = scheduled, never attempted. */
export type FindingsRunOutcome =
  | "pending"
  | "success"
  | "failed"
  | "skipped_lease";

/** Reader-facing state: the last outcome, or `overdue` when the next due time slipped. */
export type FindingsRunState = FindingsRunOutcome | "overdue";

export interface FindingsRunCounts {
  /** Findings the audit reported this run. */
  findings: number;
  /** New records written. */
  written: number;
  /** Previously resolved records reopened. */
  reopened: number;
  /** Open records marked resolved. */
  resolved: number;
  /** Records deleted by retention. */
  deleted: number;
  /** Open records after the run. */
  open: number;
}

export interface FindingsRunStateRecord {
  schemaVersion: typeof FINDINGS_RUN_STATE_SCHEMA_VERSION;
  collection: string;
  cadence: string;
  lastOutcome: FindingsRunOutcome;
  /** Start of the most recent attempt (any outcome), or null before the first. */
  lastRunAt: string | null;
  /** Completion of the most recent successful run, or null. */
  lastSuccessAt: string | null;
  /** When the next attempt is due. */
  nextDueAt: string;
  durationMs: number | null;
  counts: FindingsRunCounts | null;
  /** Failure message (or lease holder) for the last attempt, else null. */
  error: string | null;
}

/** Projection consumed by `gno daemon --status` and `gno doctor`. */
export interface FindingsRunStatus extends FindingsRunStateRecord {
  state: FindingsRunState;
}

export interface FindingsSchedule {
  collection: Collection;
  cadence: string;
  cadenceMs: number;
}

export type FindingsScheduleResolution =
  | { ok: true; enabled: false }
  | { ok: true; enabled: true; schedule: FindingsSchedule }
  | { ok: false; error: string };

export const EMPTY_FINDINGS_COUNTS: FindingsRunCounts = {
  findings: 0,
  written: 0,
  reopened: 0,
  resolved: 0,
  deleted: 0,
  open: 0,
};

/**
 * Validate the `findings` block against the loaded collections. Enabling
 * without an existing collection is a startup error, never a silent no-op.
 */
export function resolveFindingsSchedule(
  config: Config
): FindingsScheduleResolution {
  const findings = config.findings;
  if (!findings || !findings.enabled) return { ok: true, enabled: false };
  if (!findings.collection) {
    return {
      ok: false,
      error:
        "findings.enabled is true but findings.collection is not set. Name an existing collection that should receive findings records, or set findings.enabled to false.",
    };
  }
  const collection = config.collections.find(
    (candidate) => candidate.name === findings.collection
  );
  if (!collection) {
    return {
      ok: false,
      error: `findings.collection "${findings.collection}" is not a configured collection. Add it first (gno collection add <path> --name ${findings.collection}) or set findings.enabled to false; the daemon never creates collections.`,
    };
  }
  const cadenceMs = parseFindingsCadenceMs(findings.cadence);
  if (cadenceMs === null) {
    return {
      ok: false,
      error: `findings.cadence "${findings.cadence}" is invalid: use <n>s|m|h|d between 10s and 30d (e.g. 6h).`,
    };
  }
  return {
    ok: true,
    enabled: true,
    schedule: { collection, cadence: findings.cadence, cadenceMs },
  };
}

/** `<data>/<index-db-stem>.findings-run.json` */
export function findingsRunStatePath(dbPath: string): string {
  const stem = basename(dbPath).replace(/\.sqlite$/, "");
  return join(dirname(dbPath), `${stem}.findings-run.json`);
}

export function findingsRunStatePathForIndex(indexName?: string): string {
  return findingsRunStatePath(getIndexDbPath(indexName));
}

export function createPendingFindingsRunState(
  schedule: FindingsSchedule,
  now: Date
): FindingsRunStateRecord {
  return {
    schemaVersion: FINDINGS_RUN_STATE_SCHEMA_VERSION,
    collection: schedule.collection.name,
    cadence: schedule.cadence,
    lastOutcome: "pending",
    lastRunAt: null,
    lastSuccessAt: null,
    nextDueAt: new Date(now.getTime() + schedule.cadenceMs).toISOString(),
    durationMs: null,
    counts: null,
    error: null,
  };
}

export async function writeFindingsRunState(
  path: string,
  record: FindingsRunStateRecord
): Promise<void> {
  const temporaryDirectory = await mkdtemp(
    join(dirname(path), `.${basename(path)}-`)
  );
  const temporaryPath = join(temporaryDirectory, "state");
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
      createPath: false,
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
    await rmdir(temporaryDirectory).catch(() => undefined);
  }
}

export async function deleteFindingsRunState(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

const isOutcome = (value: unknown): value is FindingsRunOutcome =>
  value === "pending" ||
  value === "success" ||
  value === "failed" ||
  value === "skipped_lease";

const COUNT_KEYS = Object.keys(EMPTY_FINDINGS_COUNTS) as Array<
  keyof FindingsRunCounts
>;

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Every count must be a finite non-negative number; anything else is corrupt. */
function asRunCounts(value: unknown): FindingsRunCounts | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const counts = { ...EMPTY_FINDINGS_COUNTS };
  for (const key of COUNT_KEYS) {
    const count = candidate[key];
    if (!isCount(count)) return null;
    counts[key] = count;
  }
  return counts;
}

function asRunStateRecord(value: unknown): FindingsRunStateRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== FINDINGS_RUN_STATE_SCHEMA_VERSION ||
    typeof candidate.collection !== "string" ||
    typeof candidate.cadence !== "string" ||
    !isOutcome(candidate.lastOutcome) ||
    typeof candidate.nextDueAt !== "string"
  ) {
    return null;
  }
  const hasCounts = candidate.counts !== null && candidate.counts !== undefined;
  const counts = hasCounts ? asRunCounts(candidate.counts) : null;
  if (hasCounts && counts === null) return null;
  return {
    schemaVersion: FINDINGS_RUN_STATE_SCHEMA_VERSION,
    collection: candidate.collection,
    cadence: candidate.cadence,
    lastOutcome: candidate.lastOutcome,
    lastRunAt:
      typeof candidate.lastRunAt === "string" ? candidate.lastRunAt : null,
    lastSuccessAt:
      typeof candidate.lastSuccessAt === "string"
        ? candidate.lastSuccessAt
        : null,
    nextDueAt: candidate.nextDueAt,
    durationMs:
      typeof candidate.durationMs === "number" ? candidate.durationMs : null,
    counts,
    error: typeof candidate.error === "string" ? candidate.error : null,
  };
}

/**
 * Derive the reader-facing state. A run is `overdue` once the due time has
 * slipped by a full cadence: the daemon is down, starved, or stuck.
 */
export function projectFindingsRunStatus(
  record: FindingsRunStateRecord,
  now: Date = new Date()
): FindingsRunStatus {
  const cadenceMs = parseFindingsCadenceMs(record.cadence) ?? 0;
  const dueAt = Date.parse(record.nextDueAt);
  const overdue = Number.isFinite(dueAt) && now.getTime() > dueAt + cadenceMs;
  return { ...record, state: overdue ? "overdue" : record.lastOutcome };
}

/** Read the persisted state; null when absent or unreadable. */
export async function readFindingsRunStatus(
  path: string,
  now: Date = new Date()
): Promise<FindingsRunStatus | null> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const record = asRunStateRecord(await file.json());
    return record ? projectFindingsRunStatus(record, now) : null;
  } catch {
    return null;
  }
}

export function formatFindingsRunStatusLine(status: FindingsRunStatus): string {
  const parts: string[] = [status.state];
  if (status.lastRunAt) parts.push(`last run ${status.lastRunAt}`);
  if (status.counts) {
    parts.push(
      `${status.counts.open} open, ${status.counts.written} new, ${status.counts.resolved} resolved`
    );
  }
  parts.push(`next due ${status.nextDueAt}`);
  if (status.error) parts.push(`error: ${status.error}`);
  return `${parts[0]} (${parts.slice(1).join("; ")})`;
}
