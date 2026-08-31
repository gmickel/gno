/**
 * CLI write-lease wrapper around the shared `.mcp-write.lock` namespace.
 *
 * @module src/core/write-lease
 */

// node:fs/promises unlink — filesystem structure op, no Bun equivalent.
import { unlink } from "node:fs/promises";
// node:path for dirname/join (no Bun path utils)
import { dirname, join } from "node:path";

import { getIndexDbPath } from "../app/constants";
import { acquireWriteLock } from "./file-lock";

export const DEFAULT_LOCK_WAIT_MS = 120_000;
export const WRITE_LEASE_BUSY_MESSAGE =
  "index is busy -- another write is in progress";

const LOCK_FILE_NAME = ".mcp-write.lock";
const HOLDER_SIDECAR_SUFFIX = ".holder.json";
const LOCK_SLICE_MS = 5_000;
const WAIT_PROGRESS_INTERVAL_MS = 15_000;
const LOCK_WAIT_PATTERN = /^(?<value>\d+)(?<unit>s|m)?$/;
/** Ceiling on any lease wait: a longer value is a misconfiguration, not a queue. */
export const MAX_LOCK_WAIT_MS = 86_400_000;

export type WriteLeaseResult =
  | { ok: true; release: () => Promise<void> }
  | { ok: false; timedOut: true; waitedMs: number; holder: string | null };

export interface WriteLeaseContention {
  outcome: "lock_timeout";
  waitedMs: number;
  holder: string | null;
}

export interface WriteLeaseBusyFailure {
  success: false;
  error: string;
  contention: WriteLeaseContention;
}

export interface AcquireCliWriteLeaseOptions {
  dbPath: string;
  waitMs: number;
  noWait?: boolean;
  /** Override the sidecar command string. Defaults to `gno ` + argv subcommand. */
  command?: string;
  onWaitProgress?: (info: { waitedMs: number; holder: string | null }) => void;
}

export interface CliWriteLeaseOptions {
  indexName?: string;
  lockWaitMs?: number;
  noWait?: boolean;
  skipWriteLease?: boolean;
}

interface HolderSidecar {
  pid: number;
  command: string;
  startedAtIso: string;
}

/**
 * Lock file path used by MCP tools and JobManager: `<dbDir>/.mcp-write.lock`.
 */
export function writeLeasePath(dbPath: string): string {
  return join(dirname(dbPath), LOCK_FILE_NAME);
}

export function holderSidecarPath(lockPath: string): string {
  return `${lockPath}${HOLDER_SIDECAR_SUFFIX}`;
}

/**
 * Parse `--lock-wait` into milliseconds.
 * Accepts plain seconds ("120"), "120s", or "2m". Returns null when invalid.
 */
export function parseLockWaitMs(raw: unknown): number | null {
  if (typeof raw !== "string" && typeof raw !== "number") {
    return null;
  }
  const text = String(raw).trim();
  const match = LOCK_WAIT_PATTERN.exec(text);
  const valueText = match?.groups?.value;
  if (!valueText) {
    return null;
  }
  const value = Number(valueText);
  if (!Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  const unit = match.groups?.unit ?? "s";
  const ms = unit === "m" ? value * 60_000 : value * 1_000;
  if (!Number.isSafeInteger(ms) || ms > MAX_LOCK_WAIT_MS) {
    return null;
  }
  return ms;
}

export function formatWriteLeaseBusyMessage(contention: {
  waitedMs: number;
  holder: string | null;
}): string {
  const holder = contention.holder ?? "unknown (no holder metadata)";
  const waitedS = Math.max(0, Math.floor(contention.waitedMs / 1000));
  return [
    `gno: ${WRITE_LEASE_BUSY_MESSAGE}`,
    `  held by: ${holder}`,
    `  waited:  ${waitedS}s (--lock-wait)`,
    "  This is contention, not corruption. Reads are unaffected. Retry when it finishes,",
    "  or raise the wait with --lock-wait.",
  ].join("\n");
}

export function formatWriteLeaseBusyJson(contention: {
  waitedMs: number;
  holder: string | null;
}): WriteLeaseBusyFailure {
  return {
    success: false,
    error: WRITE_LEASE_BUSY_MESSAGE,
    contention: {
      outcome: "lock_timeout",
      waitedMs: contention.waitedMs,
      holder: contention.holder,
    },
  };
}

export function isWriteLeaseBusyResult(result: {
  success: boolean;
  contention?: unknown;
}): result is WriteLeaseBusyFailure {
  if (result.success !== false) {
    return false;
  }
  if (result.contention === null || typeof result.contention !== "object") {
    return false;
  }
  return (
    "outcome" in result.contention &&
    result.contention.outcome === "lock_timeout"
  );
}

export async function acquireCliWriteLease(
  options: AcquireCliWriteLeaseOptions
): Promise<WriteLeaseResult> {
  const lockPath = writeLeasePath(options.dbPath);
  // A non-finite or out-of-range wait must never loop unbounded (fn-127 review).
  const requestedWaitMs = Number.isFinite(options.waitMs)
    ? Math.min(Math.max(0, options.waitMs), MAX_LOCK_WAIT_MS)
    : DEFAULT_LOCK_WAIT_MS;
  const waitMs = options.noWait ? 0 : requestedWaitMs;
  const startedAt = Date.now();
  let lastProgressAt = -WAIT_PROGRESS_INTERVAL_MS;

  while (true) {
    const elapsed = Date.now() - startedAt;
    const remaining = Math.max(0, waitMs - elapsed);
    const sliceMs = options.noWait ? 0 : Math.min(LOCK_SLICE_MS, remaining);
    const handle = await acquireWriteLock(lockPath, sliceMs);
    if (handle) {
      await writeHolderSidecar(lockPath, options.command);
      return {
        ok: true,
        release: async () => {
          await deleteHolderSidecar(lockPath);
          await handle.release();
        },
      };
    }

    const waitedMs = Date.now() - startedAt;
    const holder = await readHolderDescription(lockPath);
    if (options.noWait || waitedMs >= waitMs) {
      return { ok: false, timedOut: true, waitedMs, holder };
    }

    if (waitedMs - lastProgressAt >= WAIT_PROGRESS_INTERVAL_MS) {
      options.onWaitProgress?.({ waitedMs, holder });
      lastProgressAt = waitedMs;
    }
  }
}

/**
 * Acquire the shared write lease, run `fn`, and release on every path.
 * Nested callers pass `skipWriteLease` to avoid self-deadlock (index → embed).
 */
export async function withCliWriteLease<T>(
  options: CliWriteLeaseOptions,
  fn: () => Promise<T>
): Promise<T | WriteLeaseBusyFailure> {
  if (options.skipWriteLease) {
    return await fn();
  }

  const result = await acquireCliWriteLease({
    dbPath: getIndexDbPath(options.indexName),
    waitMs: options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS,
    noWait: options.noWait,
    onWaitProgress: writeWaitProgress,
  });
  if (!result.ok) {
    return formatWriteLeaseBusyJson(result);
  }

  try {
    return await fn();
  } finally {
    try {
      await result.release();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      process.stderr.write(`gno: failed to release write lease: ${message}\n`);
    }
  }
}

function writeWaitProgress(info: {
  waitedMs: number;
  holder: string | null;
}): void {
  const holder = info.holder ?? "unknown";
  const waitedS = Math.max(0, Math.floor(info.waitedMs / 1000));
  process.stderr.write(
    `gno: waiting for index write lease (held by ${holder}, waited ${waitedS}s)\n`
  );
}

function resolveHolderCommand(explicit?: string): string {
  if (explicit && explicit.trim().length > 0) {
    return explicit.trim();
  }
  const tokens: string[] = [];
  for (const token of process.argv.slice(2)) {
    if (token.startsWith("-")) {
      continue;
    }
    if (token.includes("/") || token.includes("\\")) {
      continue;
    }
    tokens.push(token);
  }
  return tokens.length > 0 ? `gno ${tokens.join(" ")}` : "gno";
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

function asHolderSidecar(value: unknown): HolderSidecar | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  if (
    !("pid" in value) ||
    !("command" in value) ||
    !("startedAtIso" in value)
  ) {
    return null;
  }
  if (typeof value.pid !== "number" || !Number.isInteger(value.pid)) {
    return null;
  }
  if (typeof value.command !== "string" || value.command.length === 0) {
    return null;
  }
  if (typeof value.startedAtIso !== "string") {
    return null;
  }
  return {
    pid: value.pid,
    command: value.command,
    startedAtIso: value.startedAtIso,
  };
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

function formatHolder(sidecar: HolderSidecar): string {
  const startedAt = Date.parse(sidecar.startedAtIso);
  const elapsedMs = Number.isFinite(startedAt)
    ? Math.max(0, Date.now() - startedAt)
    : 0;
  return `${sidecar.command} (pid ${sidecar.pid}), running ${formatElapsed(elapsedMs)}`;
}

async function writeHolderSidecar(
  lockPath: string,
  command?: string
): Promise<void> {
  try {
    const payload: HolderSidecar = {
      pid: process.pid,
      command: resolveHolderCommand(command),
      startedAtIso: new Date().toISOString(),
    };
    await Bun.write(
      holderSidecarPath(lockPath),
      `${JSON.stringify(payload)}\n`
    );
  } catch {
    // Identification is best-effort and must never fail acquisition.
  }
}

async function deleteHolderSidecar(lockPath: string): Promise<void> {
  try {
    await unlink(holderSidecarPath(lockPath));
  } catch {
    // Sidecar cleanup must never fail release.
  }
}

async function readHolderDescription(lockPath: string): Promise<string | null> {
  try {
    const sidecarFile = Bun.file(holderSidecarPath(lockPath));
    if (!(await sidecarFile.exists())) {
      return null;
    }
    const sidecar = asHolderSidecar(await sidecarFile.json());
    if (!sidecar || !isPidAlive(sidecar.pid)) {
      return null;
    }
    return formatHolder(sidecar);
  } catch {
    return null;
  }
}
