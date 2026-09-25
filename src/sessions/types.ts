/**
 * Shared contracts for native agent-session ingestion.
 *
 * Data flow: native source -> harness parser -> sanitizer -> one durable
 * JSONL archive file per thread -> ordinary collection sync through the
 * JSONL record adapter. Every surface (CLI, MCP, REST, SDK, Web UI) consumes
 * the receipt and status shapes defined here.
 *
 * @module src/sessions/types
 */

export const SESSION_HARNESSES = [
  "codex",
  "claude-code",
  "openclaw",
  "hermes",
] as const;
export type SessionHarness = (typeof SESSION_HARNESSES)[number];

export const SESSION_HARNESS_LABELS: Record<SessionHarness, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  openclaw: "OpenClaw",
  hermes: "Hermes",
};

/** Speaker classes that reach the archive. Everything else is skipped. */
export type SessionRole = "human" | "assistant";

/** Largest `limit` accepted by one import call. */
export const MAX_IMPORT_LIMIT = 100_000;

/** Version of the archive line layout; bumps force a rewrite on import. */
export const SESSION_ARCHIVE_FORMAT_VERSION = 2;

/** Bounds applied while reading sources. */
export const SESSION_LIMITS = {
  /** Largest native file or database read in one unit. */
  maxSourceBytes: 512 * 1024 * 1024,
  /** Largest physical JSONL line parsed; larger lines are skipped and counted. */
  maxLineBytes: 32 * 1024 * 1024,
  /** Largest dialogue text kept for one turn; larger turns are skipped. */
  maxTurnChars: 256 * 1024,
  /** Largest number of archived turns for one thread. */
  maxTurnsPerThread: 20_000,
  /** Largest archive file written for one thread. */
  maxArchiveBytesPerThread: 64 * 1024 * 1024,
  /** Largest number of threads one database unit may yield. */
  maxThreadsPerUnit: 50_000,
  /** Units listed individually in a receipt. */
  maxReceiptUnits: 200,
  /** Distinct unknown record kinds reported per unit. */
  maxDiagnosticKinds: 32,
  /** Units enumerated below one source root. */
  maxUnitsPerSource: 100_000,
} as const;

/** One archived dialogue turn after structural classification. */
export interface ParsedTurn {
  /** Native logical turn ID (message/item ID or a stable ordinal locator). */
  turnId: string;
  role: SessionRole;
  text: string;
  /** Normalized ISO-8601 UTC timestamp; absent when unknown or unparseable. */
  timestamp?: string;
  /** Safe native locator inside the unit, e.g. `line:42` or `messages/17`. */
  locator: string;
  /** Working directory recorded for this turn, when the format carries one. */
  cwd?: string;
}

export type SessionThreadKind = "main" | "subagent" | "fork" | "continuation";

/** One conversation thread as recovered from a native unit. */
export interface ParsedThread {
  harness: SessionHarness;
  /** Native thread identity (distinct for forks and subagents). */
  threadId: string;
  /** Native root session identity shared by forks/subagents when known. */
  sessionId: string;
  parentThreadId?: string;
  kind: SessionThreadKind;
  /** Recorded working directory for the thread. */
  cwd?: string;
  turns: ParsedTurn[];
}

/** Bounded, content-free diagnostics for one unit. */
export interface UnitDiagnostics {
  /** Record kinds the parser does not recognise, with counts. */
  unknownKinds: Record<string, number>;
  malformedRecords: number;
  overLimitRecords: number;
  overLimitTurns: number;
  /** Records skipped because they are injected context, not speech. */
  injectedSkipped: number;
  /** Records copied from a parent thread (fork/continuation history). */
  copiedHistorySkipped: number;
  /** Final line was cut mid-write (a growing file). */
  truncatedTail: boolean;
  /**
   * Single-thread file units: assistant turns exist but no human turn was
   * recognised (possible format drift); the unit stays incomplete.
   */
  humanTurnsMissing: boolean;
  /**
   * Database units: main threads with assistant turns but no human turn.
   * Reported per thread, so one such thread cannot hold the unit back.
   */
  threadsWithoutHuman: number;
  /**
   * Database units: threads left unread because the unit reached
   * `maxThreadsPerUnit`; the unit stays incomplete so its checkpoint does
   * not advance past them.
   */
  threadsOverLimit: number;
  /** Format revision reported by the source, when recorded. */
  formatVersion?: string;
}

export const emptyDiagnostics = (): UnitDiagnostics => ({
  unknownKinds: {},
  malformedRecords: 0,
  overLimitRecords: 0,
  overLimitTurns: 0,
  injectedSkipped: 0,
  copiedHistorySkipped: 0,
  truncatedTail: false,
  humanTurnsMissing: false,
  threadsWithoutHuman: 0,
  threadsOverLimit: 0,
});

const SAFE_KIND = /[^A-Za-z0-9_.:/-]/g;

/** Record an unknown kind without retaining source content. */
export function noteUnknownKind(
  diagnostics: UnitDiagnostics,
  kind: unknown
): void {
  const label =
    typeof kind === "string" && kind.length > 0
      ? kind.slice(0, 64).replace(SAFE_KIND, "_")
      : "(none)";
  const known = diagnostics.unknownKinds[label];
  if (
    known === undefined &&
    Object.keys(diagnostics.unknownKinds).length >=
      SESSION_LIMITS.maxDiagnosticKinds
  ) {
    return;
  }
  diagnostics.unknownKinds[label] = (known ?? 0) + 1;
}

export interface ParseUnitResult {
  threads: ParsedThread[];
  diagnostics: UnitDiagnostics;
  /** True when every byte of the unit was read and understood or skipped by policy. */
  complete: boolean;
  /** Parser identity recorded in archive provenance. */
  parser: string;
}

/** Normalize a native timestamp to ISO-8601 UTC or drop it. */
export function normalizeTimestamp(value: unknown): string | undefined {
  let date: Date | undefined;
  if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    // Numeric strings are epoch seconds or milliseconds.
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      return normalizeTimestamp(Number(trimmed));
    }
    date = new Date(trimmed);
  } else if (typeof value === "number" && Number.isFinite(value)) {
    // Heuristic boundary between epoch seconds and epoch milliseconds.
    date = new Date(value < 1e11 ? value * 1000 : value);
  }
  if (!date || Number.isNaN(date.getTime())) return undefined;
  const year = date.getUTCFullYear();
  if (year < 1990 || year > 2200) return undefined;
  return date.toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Receipts and status (shared across every surface)
// ─────────────────────────────────────────────────────────────────────────────

export const SESSION_UNIT_OUTCOMES = [
  "imported",
  "updated",
  "unchanged",
  "skipped_policy",
  "unsupported",
  "incomplete",
  "failed",
] as const;
export type SessionUnitOutcome = (typeof SESSION_UNIT_OUTCOMES)[number];

export interface SessionImportCounts {
  /** Threads written to the archive for the first time. */
  imported: number;
  /** Threads whose archive file changed. */
  updated: number;
  /** Threads whose archive file was already current. */
  unchanged: number;
  /** Threads withheld by policy (mixed-domain, over-limit). */
  skippedPolicy: number;
  /** Units whose format was not recognised. */
  unsupported: number;
  /** Units read only partially; their checkpoint did not advance. */
  incomplete: number;
  /** Units that could not be read. */
  failed: number;
}

export interface SessionTurnCounts {
  human: number;
  assistant: number;
  redactions: number;
  injectedSkipped: number;
  copiedHistorySkipped: number;
  overLimit: number;
}

export interface SessionUnitReceipt {
  sourceId: string;
  harness: SessionHarness | null;
  /** Safe locator (basename or database table path); never a host path. */
  locator: string;
  outcome: SessionUnitOutcome;
  reason?: string;
  threads: number;
  turns: number;
  /** Destination collections for archived threads of this unit. */
  collections: string[];
  unknownKinds?: Record<string, number>;
  warnings?: string[];
}

export interface SessionImportReceipt {
  schemaVersion: "1";
  dryRun: boolean;
  index: string;
  sourceIds: string[];
  status: "complete" | "partial" | "failed" | "nothing_to_do";
  counts: SessionImportCounts;
  turns: SessionTurnCounts;
  units: SessionUnitReceipt[];
  unitsTruncated: boolean;
  /** Pending units left for a later run because `limit` was reached. */
  deferredUnits: number;
  lexical: {
    status: "ready" | "failed" | "skipped";
    collections: string[];
    error?: string;
  };
  embedding: { backlog: number | null };
  warnings: string[];
}

export interface SessionSourceStatus {
  id: string;
  harness: SessionHarness;
  collection: string;
  available: boolean;
  units: {
    total: number;
    complete: number;
    incomplete: number;
    failed: number;
    pending: number;
  };
  archivedThreads: number;
  staleParser: number;
  sourceUnavailable: number;
  lastImportAt: string | null;
}

export interface SessionsStatus {
  schemaVersion: "1";
  configured: boolean;
  index: string;
  collections: Array<{ name: string; threads: number }>;
  sources: SessionSourceStatus[];
  /** Opt-in automation; `profiles` is empty when nothing is configured. */
  automation: SessionAutomationStatus;
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Automation (opt-in hooks and daemon schedules)
// ─────────────────────────────────────────────────────────────────────────────

/** What admitted a run: a host hook, a daemon schedule tick, or an explicit run. */
export type SessionTriggerKind = "hook" | "schedule" | "manual";

/** Outcome of one automation run. `up_to_date` is a verified no-op. */
export type SessionRunOutcome =
  | "complete"
  | "up_to_date"
  | "partial"
  | "failed";

/**
 * Reader-facing profile state: `off` (no trigger enabled, nothing pending),
 * `idle`, `pending`, `running`, `retrying` (a failed run waits for its
 * backoff), `partial` or `failed` (the last run; see `recovery`).
 */
export type SessionProfileState =
  | "off"
  | "idle"
  | "pending"
  | "running"
  | "retrying"
  | "partial"
  | "failed";

export interface SessionRunRecord {
  triggers: SessionTriggerKind[];
  startedAt: string;
  finishedAt: string;
  outcome: SessionRunOutcome;
  /** Stable reason code for partial/failed runs (no content, no paths). */
  reason: string | null;
  threads: { imported: number; updated: number; unchanged: number };
  units: { incomplete: number; failed: number; deferred: number };
}

export interface SessionProfileStatus {
  id: string;
  sources: string[];
  /** Destination archive collections of the selected sources. */
  collections: string[];
  state: SessionProfileState;
  hook: {
    harness: string;
    enabled: boolean;
    /** Owned entry present in the host settings; null when unreadable. */
    installed: boolean | null;
  } | null;
  schedule: {
    enabled: boolean;
    cadence: string;
    nextDueAt: string | null;
  } | null;
  limit: number;
  retries: number;
  pending: {
    since: string;
    triggers: SessionTriggerKind[];
  } | null;
  running: { startedAt: string; triggers: SessionTriggerKind[] } | null;
  lastTrigger: { kind: SessionTriggerKind; at: string } | null;
  lastRun: SessionRunRecord | null;
  lastSuccessAt: string | null;
  retryAt: string | null;
  /** Next action for the owner when the profile needs attention. */
  recovery: string | null;
}

export interface SessionAutomationStatus {
  daemon: {
    /** `running` only with a fresh heartbeat from a live daemon process. */
    state: "running" | "not_running" | "stale";
    heartbeatAt: string | null;
  };
  /** IANA timezone used for human-readable times; stored instants are UTC. */
  timezone: string;
  profiles: SessionProfileStatus[];
}

/** Result of one explicit or daemon-drained automation run. */
export interface SessionAutomationRunResult {
  schemaVersion: "1";
  profileId: string;
  /** False when the run could not start (busy, disabled, nothing pending). */
  ran: boolean;
  outcome: SessionRunOutcome | "not_started";
  reason: string | null;
  /** True when admitted work is still waiting (deferred units, failure, busy). */
  pending: boolean;
  receipts: SessionImportReceipt[];
}

export interface SessionDiscoveryCandidate {
  harness: SessionHarness;
  /** Absolute host path; only local owner surfaces receive it. */
  path: string;
  units: number;
  bytes: number;
  truncated: boolean;
  formatVersions: string[];
  registeredAs: string | null;
}

export interface SessionsDiscovery {
  schemaVersion: "1";
  candidates: SessionDiscoveryCandidate[];
  warnings: string[];
}

export type SessionsErrorCode =
  | "SESSIONS_NOT_CONFIGURED"
  | "SESSIONS_BINDING_MISMATCH"
  | "SESSIONS_SELECTION_REQUIRED"
  | "SESSIONS_DESTINATION_REQUIRED"
  | "SESSIONS_UNKNOWN_SOURCE"
  | "SESSIONS_UNKNOWN_COLLECTION"
  | "SESSIONS_UNSAFE_PATH"
  | "SESSIONS_SOURCE_UNAVAILABLE"
  | "SESSIONS_UNSUPPORTED_FORMAT"
  | "SESSIONS_INVALID_INPUT"
  | "SESSIONS_BUSY"
  | "SESSIONS_RUNTIME_FAILURE"
  | "SESSIONS_UNKNOWN_PROFILE"
  | "SESSIONS_UNSUPPORTED_INTEGRATION";

/** Typed error shared by every sessions surface. */
export class SessionsError extends Error {
  readonly code: SessionsErrorCode;

  constructor(code: SessionsErrorCode, message: string) {
    super(message);
    this.name = "SessionsError";
    this.code = code;
  }
}

/** Errors that describe the caller's input rather than runtime state. */
export const SESSIONS_VALIDATION_CODES: ReadonlySet<SessionsErrorCode> =
  new Set([
    "SESSIONS_NOT_CONFIGURED",
    "SESSIONS_BINDING_MISMATCH",
    "SESSIONS_SELECTION_REQUIRED",
    "SESSIONS_DESTINATION_REQUIRED",
    "SESSIONS_UNKNOWN_SOURCE",
    "SESSIONS_UNKNOWN_COLLECTION",
    "SESSIONS_UNSAFE_PATH",
    "SESSIONS_UNSUPPORTED_FORMAT",
    "SESSIONS_INVALID_INPUT",
    "SESSIONS_UNKNOWN_PROFILE",
    "SESSIONS_UNSUPPORTED_INTEGRATION",
  ]);

/**
 * Typed, path-free error for remote surfaces (REST, MCP). Filesystem and
 * store failures carry host paths in their messages; those stay in the
 * server log.
 */
export function remoteSafeSessionsError(error: unknown): SessionsError {
  if (error instanceof SessionsError) return error;
  return new SessionsError(
    "SESSIONS_RUNTIME_FAILURE",
    "The session operation failed on the server (filesystem or index error); retry, or run the command locally for details."
  );
}
