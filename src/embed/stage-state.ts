/**
 * Persisted per-stage progress markers for staged indexing (fn-132 R4).
 *
 * `gno index` runs two separable stages - `lexical` (sync) and `embed` - and
 * records each stage's lifecycle in `schema_meta` under one key. A stage left
 * `running` by a process that died (SIGKILL, native crash, power loss) is
 * reported by the next run's resume preamble as `interrupted`; the stage data
 * itself (documents/chunks for lexical, per-batch vectors for embed) is already
 * committed, so the next run continues from it without rework.
 *
 * @module src/embed/stage-state
 */

import type { Database } from "bun:sqlite";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export const INDEX_STAGE_STATE_KEY = "index_stage_state";
export const INDEX_STAGE_STATE_VERSION = 1;

export type IndexStageName = "lexical" | "embed";

/** Terminal states a stage can report in a receipt. */
export type IndexStageState =
  | "completed"
  | "failed"
  | "skipped"
  | "interrupted";

/** Persisted lifecycle of one stage. */
export interface PersistedStageRecord {
  state: "running" | "completed" | "failed";
  /** Process that owned the stage (informational; the write lease guarantees exclusivity). */
  pid: number;
  startedAt: string;
  finishedAt?: string;
  /** Collection scope of the run that wrote the marker, when scoped. */
  collection?: string;
}

export interface PersistedStageState {
  version: number;
  lexical?: PersistedStageRecord;
  embed?: PersistedStageRecord;
}

/** Resume preamble payload: the stage a previous run left `running`. */
export interface InterruptedStage {
  stage: IndexStageName;
  state: "interrupted";
  startedAt: string;
  pid: number;
  collection?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────────

function isStageRecord(value: unknown): value is PersistedStageRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.state === "running" ||
      record.state === "completed" ||
      record.state === "failed") &&
    typeof record.pid === "number" &&
    typeof record.startedAt === "string"
  );
}

/**
 * Read the persisted stage state. A missing or malformed marker reads as
 * empty - the marker is advisory resume metadata, never a gate.
 */
export function readIndexStageState(db: Database): PersistedStageState {
  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key = ?")
    .get(INDEX_STAGE_STATE_KEY) as { value: string } | null;
  if (!row) {
    return { version: INDEX_STAGE_STATE_VERSION };
  }
  try {
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    return {
      version: INDEX_STAGE_STATE_VERSION,
      ...(isStageRecord(parsed.lexical) ? { lexical: parsed.lexical } : {}),
      ...(isStageRecord(parsed.embed) ? { embed: parsed.embed } : {}),
    };
  } catch {
    return { version: INDEX_STAGE_STATE_VERSION };
  }
}

function writeIndexStageState(db: Database, state: PersistedStageState): void {
  db.prepare(
    `INSERT INTO schema_meta (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(INDEX_STAGE_STATE_KEY, JSON.stringify(state));
}

/**
 * Mark a stage as running for this process. Overwrites any previous record
 * for that stage (the caller has already surfaced an interrupted one).
 */
export function markIndexStageRunning(
  db: Database,
  stage: IndexStageName,
  options: { collection?: string; now?: () => Date } = {}
): void {
  const state = readIndexStageState(db);
  state[stage] = {
    state: "running",
    pid: process.pid,
    startedAt: (options.now ?? (() => new Date()))().toISOString(),
    ...(options.collection ? { collection: options.collection } : {}),
  };
  writeIndexStageState(db, state);
}

/**
 * Mark a running stage finished. A stage that was never marked running is
 * recorded from scratch so the marker never claims a finish without a start.
 */
export function markIndexStageFinished(
  db: Database,
  stage: IndexStageName,
  outcome: "completed" | "failed",
  options: { now?: () => Date } = {}
): void {
  const state = readIndexStageState(db);
  const finishedAt = (options.now ?? (() => new Date()))().toISOString();
  const previous = state[stage];
  state[stage] = {
    state: outcome,
    pid: previous?.pid ?? process.pid,
    startedAt: previous?.startedAt ?? finishedAt,
    finishedAt,
    ...(previous?.collection ? { collection: previous.collection } : {}),
  };
  writeIndexStageState(db, state);
}

/**
 * Drop a stage's marker. Used when a run deliberately does not attempt a
 * stage (`gno index --no-embed`) after surfacing a stale `running` marker for
 * it, so later runs do not keep reporting an interruption that has already
 * been acknowledged. Stage data is untouched: embed progress is persisted
 * per batch and resumes from the data, not from this marker.
 */
export function clearIndexStage(db: Database, stage: IndexStageName): void {
  const state = readIndexStageState(db);
  if (!state[stage]) {
    return;
  }
  delete state[stage];
  writeIndexStageState(db, state);
}

/**
 * Detect the stage a previous run left `running`. Under the write lease only
 * one writer runs at a time, so a `running` marker at run start always
 * belongs to a process that died mid-stage. Later stages win when both are
 * `running` (a stale lexical marker cannot survive a completed embed start).
 */
export function findInterruptedStage(
  state: PersistedStageState
): InterruptedStage | null {
  for (const stage of ["embed", "lexical"] as const) {
    const record = state[stage];
    if (record?.state === "running") {
      return {
        stage,
        state: "interrupted",
        startedAt: record.startedAt,
        pid: record.pid,
        ...(record.collection ? { collection: record.collection } : {}),
      };
    }
  }
  return null;
}

/** Human line for the resume preamble (stderr, non-JSON mode). */
export function formatInterruptedStage(interrupted: InterruptedStage): string {
  const scope = interrupted.collection
    ? ` (collection ${interrupted.collection})`
    : "";
  const continuation =
    interrupted.stage === "embed"
      ? "lexical index intact; embedding resumes from persisted progress without re-embedding completed chunks."
      : "resuming lexical sync from persisted progress; unchanged files are skipped.";
  return `Resuming: previous run (pid ${interrupted.pid}, started ${interrupted.startedAt}) was interrupted during the ${interrupted.stage} stage${scope}; ${continuation}`;
}
