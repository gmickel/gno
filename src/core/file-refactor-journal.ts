/**
 * Content-free recovery journal types for reference-safe file refactors.
 *
 * Receipts never embed note bodies or replacement content — only IDs,
 * digests, paths, phases, fingerprints, and status.
 *
 * Bounded globally: oldest terminal receipts are pruned on create
 * (see FILE_REFACTOR_JOURNAL_MAX_RECEIPTS = 256). Uncertain/recovery-required
 * receipts are never pruned.
 *
 * @module src/core/file-refactor-journal
 */

import type { FileRefactorOperation } from "./file-refactor-contract";

import { tryValidateRefactorArtifactRelPath } from "./file-refactor-apply-safety";

/**
 * Ordered phases. Numeric ordinals make interruption state detectable:
 * prepared < staging < committing < committed < sync_pending < converged.
 * Rollback branch: committing → rolling_back → rolled_back | recovery_required.
 * Abort before commit: prepared|staging → aborted.
 */
export const FILE_REFACTOR_JOURNAL_PHASES = [
  "prepared",
  "staging",
  "committing",
  "committed",
  "sync_pending",
  "converged",
  "rolling_back",
  "rolled_back",
  "recovery_required",
  "aborted",
] as const;

export type FileRefactorJournalPhase =
  (typeof FILE_REFACTOR_JOURNAL_PHASES)[number];

export const FILE_REFACTOR_JOURNAL_PHASE_ORDINAL: Record<
  FileRefactorJournalPhase,
  number
> = {
  prepared: 10,
  staging: 20,
  committing: 30,
  committed: 40,
  sync_pending: 50,
  converged: 60,
  rolling_back: 35,
  rolled_back: 70,
  recovery_required: 80,
  aborted: 5,
};

/** Hard cap: prune oldest terminal receipts only during create. */
export const FILE_REFACTOR_JOURNAL_MAX_RECEIPTS = 256;

export type FileRefactorJournalFileRole = "source" | "target" | "affected";

export type FileRefactorJournalFileStatus =
  | "pending"
  | "staged"
  | "committed"
  | "restored"
  | "absent"
  | "failed";

/** Per-file metadata only — fingerprints/status/artifact paths, never bodies. */
export interface FileRefactorJournalFileEntry {
  role: FileRefactorJournalFileRole;
  relPath: string;
  /** Collection-relative stage artifact path (content-free locator). */
  stageRelPath?: string;
  /** Collection-relative backup artifact path (content-free locator). */
  backupRelPath?: string;
  originalFingerprint?: string;
  expectedFingerprint?: string;
  status: FileRefactorJournalFileStatus;
}

export type FileRefactorJournalFilesystemState =
  | "unchanged"
  | "committed"
  | "rolled_back"
  | "recovery_required";

export type FileRefactorJournalIndexState =
  | "not_attempted"
  | "pending"
  | "converged"
  | "skipped";

/** Durable, content-free recovery receipt. */
export interface FileRefactorRecoveryReceipt {
  journalId: string;
  planDigest: string;
  collection: string;
  operation: FileRefactorOperation;
  sourceRelPath: string;
  targetRelPath: string;
  phase: FileRefactorJournalPhase;
  phaseOrdinal: number;
  filesystemState: FileRefactorJournalFilesystemState;
  indexState: FileRefactorJournalIndexState;
  fileEntries: FileRefactorJournalFileEntry[];
  createdAtMs: number;
  updatedAtMs: number;
}

export interface FileRefactorRecoveryReceiptDraft {
  journalId: string;
  planDigest: string;
  collection: string;
  operation: FileRefactorOperation;
  sourceRelPath: string;
  targetRelPath: string;
  fileEntries: FileRefactorJournalFileEntry[];
  createdAtMs: number;
}

export interface FileRefactorJournalAdvance {
  phase: FileRefactorJournalPhase;
  filesystemState?: FileRefactorJournalFilesystemState;
  indexState?: FileRefactorJournalIndexState;
  fileEntries?: FileRefactorJournalFileEntry[];
  updatedAtMs: number;
}

/**
 * Small explicit port for durable recovery receipts.
 * Prefer injecting this over a full StorePort in the apply service.
 */
export interface FileRefactorJournalPort {
  createPreparedReceipt(
    draft: FileRefactorRecoveryReceiptDraft
  ): Promise<FileRefactorRecoveryReceipt>;
  advanceReceipt(
    journalId: string,
    update: FileRefactorJournalAdvance
  ): Promise<FileRefactorRecoveryReceipt>;
  getReceiptById(
    journalId: string
  ): Promise<FileRefactorRecoveryReceipt | null>;
  /**
   * Latest receipt for a plan digest (highest updatedAtMs, then journalId).
   * Stable deterministic lookup for idempotent retry.
   */
  getLatestReceiptByPlanDigest(
    planDigest: string
  ): Promise<FileRefactorRecoveryReceipt | null>;
}

/**
 * Allowed phase transitions (monotonic / documented rollback branch).
 * Same-phase advances persist per-file status during staging/commit/rollback.
 */
export const FILE_REFACTOR_JOURNAL_ALLOWED_TRANSITIONS: Record<
  FileRefactorJournalPhase,
  readonly FileRefactorJournalPhase[]
> = {
  prepared: ["prepared", "staging", "aborted", "recovery_required"],
  staging: [
    "staging",
    "committing",
    "aborted",
    "rolling_back",
    "recovery_required",
  ],
  committing: ["committing", "committed", "rolling_back", "recovery_required"],
  committed: ["sync_pending", "converged"],
  sync_pending: ["converged", "sync_pending"],
  converged: [],
  rolling_back: ["rolling_back", "rolled_back", "recovery_required"],
  rolled_back: [],
  recovery_required: [],
  aborted: [],
};

export function assertAllowedJournalPhaseTransition(
  from: FileRefactorJournalPhase,
  to: FileRefactorJournalPhase
): void {
  const allowed = FILE_REFACTOR_JOURNAL_ALLOWED_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid journal phase transition ${from} -> ${to}`);
  }
}

export function isTerminalJournalPhase(
  phase: FileRefactorJournalPhase
): boolean {
  return (
    phase === "converged" ||
    phase === "rolled_back" ||
    phase === "recovery_required" ||
    phase === "aborted"
  );
}

/** Terminal phases safe to prune under the global retention cap. */
export function isPrunableJournalPhase(
  phase: FileRefactorJournalPhase
): boolean {
  return (
    phase === "converged" || phase === "rolled_back" || phase === "aborted"
  );
}

export function isUncertainJournalPhase(
  phase: FileRefactorJournalPhase
): boolean {
  return (
    phase === "prepared" ||
    phase === "staging" ||
    phase === "committing" ||
    phase === "rolling_back" ||
    phase === "recovery_required"
  );
}

export function isCommittedFilesystemPhase(
  phase: FileRefactorJournalPhase
): boolean {
  return (
    phase === "committed" || phase === "sync_pending" || phase === "converged"
  );
}

const FILE_ENTRY_ROLES = new Set(["source", "target", "affected"]);
const FILE_ENTRY_STATUSES = new Set([
  "pending",
  "staged",
  "committed",
  "restored",
  "absent",
  "failed",
]);

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function assertOptionalFingerprint(
  value: unknown,
  field: string
): asserts value is string | undefined {
  if (value === undefined) return;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Corrupt file_entries_json: invalid ${field}`);
  }
}

function assertOptionalArtifactRelPath(
  value: unknown,
  kind: "stage" | "backup"
): asserts value is string | undefined {
  if (value === undefined) return;
  if (typeof value !== "string") {
    throw new Error(`Corrupt file_entries_json: invalid ${kind}RelPath`);
  }
  if (!tryValidateRefactorArtifactRelPath(value, kind)) {
    throw new Error(`Corrupt file_entries_json: invalid ${kind}RelPath`);
  }
}

/** Defensive parse of file_entries_json — rejects corrupt shapes. */
export function parseFileRefactorJournalFileEntries(
  raw: unknown
): FileRefactorJournalFileEntry[] {
  if (typeof raw === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Corrupt file_entries_json: invalid JSON");
    }
    return parseFileRefactorJournalFileEntries(parsed);
  }
  if (!Array.isArray(raw)) {
    throw new Error("Corrupt file_entries_json: expected array");
  }
  const entries: FileRefactorJournalFileEntry[] = [];
  const seenRelPaths = new Set<string>();
  const seenRoles = new Set<string>();
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Corrupt file_entries_json: entry must be object");
    }
    const row = item as Record<string, unknown>;
    if (typeof row.role !== "string" || !FILE_ENTRY_ROLES.has(row.role)) {
      throw new Error("Corrupt file_entries_json: invalid role");
    }
    if (typeof row.relPath !== "string" || row.relPath.length === 0) {
      throw new Error("Corrupt file_entries_json: invalid relPath");
    }
    if (
      typeof row.status !== "string" ||
      !FILE_ENTRY_STATUSES.has(row.status)
    ) {
      throw new Error("Corrupt file_entries_json: invalid status");
    }
    if (
      !isOptionalString(row.stageRelPath) ||
      !isOptionalString(row.backupRelPath) ||
      !isOptionalString(row.originalFingerprint) ||
      !isOptionalString(row.expectedFingerprint)
    ) {
      throw new Error("Corrupt file_entries_json: invalid optional fields");
    }
    assertOptionalFingerprint(row.originalFingerprint, "originalFingerprint");
    assertOptionalFingerprint(row.expectedFingerprint, "expectedFingerprint");
    assertOptionalArtifactRelPath(row.stageRelPath, "stage");
    assertOptionalArtifactRelPath(row.backupRelPath, "backup");
    if (seenRelPaths.has(row.relPath)) {
      throw new Error("Corrupt file_entries_json: duplicate relPath");
    }
    seenRelPaths.add(row.relPath);
    const roleKey = `${row.role}:${row.relPath}`;
    if (seenRoles.has(roleKey)) {
      throw new Error("Corrupt file_entries_json: duplicate role/relPath");
    }
    seenRoles.add(roleKey);
    if (
      "content" in row ||
      "body" in row ||
      "replacement" in row ||
      "originalDestination" in row ||
      "finalContent" in row
    ) {
      throw new Error("File refactor journal must not store note content");
    }
    entries.push({
      role: row.role as FileRefactorJournalFileEntry["role"],
      relPath: row.relPath,
      stageRelPath: row.stageRelPath,
      backupRelPath: row.backupRelPath,
      originalFingerprint: row.originalFingerprint,
      expectedFingerprint: row.expectedFingerprint,
      status: row.status as FileRefactorJournalFileEntry["status"],
    });
  }
  return entries;
}

export const FILE_REFACTOR_SYNC_PENDING_INSTRUCTION =
  "Filesystem refactor committed; retry apply with the same plan digest to finish index convergence without repeating file mutations.";
