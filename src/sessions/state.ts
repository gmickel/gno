/**
 * Import checkpoint state stored beside the archive.
 *
 * State lives in `<archiveRoot>/.gno-sessions/state.json`, outside every
 * archive collection root, and never records host paths: units are keyed by
 * a hash of their canonical path and described by their safe locator. A unit
 * advances to `complete` only after a clean, fully read run; partial reads
 * stay `incomplete` and are retried. The archive files themselves are the
 * source of truth for idempotency: a changed unit is re-rendered and
 * compared with the archived bytes.
 *
 * @module src/sessions/state
 */

// node:fs/promises mkdir/stat: filesystem structure ops without Bun equivalents.
import { mkdir, stat } from "node:fs/promises";
// node:path: no Bun path utilities.
import { join } from "node:path";

import type { SessionUnit } from "./sources";
import type { SessionHarness } from "./types";

import { hashRecordValue } from "../converters/adapters/shared/record-utils";
import { atomicWrite } from "../core/file-ops";
import { SESSION_STATE_DIRNAME } from "./archive";

export type UnitStatus = "complete" | "incomplete" | "failed" | "unsupported";

export interface UnitState {
  locator: string;
  /** Harness detected for the unit (path imports may differ per unit). */
  harness?: SessionHarness;
  fingerprint: string;
  status: UnitStatus;
  parser: string | null;
  /** Redaction policy stamp the archive was produced with. */
  redaction: string;
  format: number;
  threads: Array<{ collection: string; relPath: string }>;
  updatedAt: string;
}

export interface SourceState {
  lastImportAt: string | null;
  units: Record<string, UnitState>;
}

export interface SessionsState {
  version: 1;
  sources: Record<string, SourceState>;
}

export const stateDir = (archiveRoot: string): string =>
  join(archiveRoot, SESSION_STATE_DIRNAME);

const statePath = (archiveRoot: string): string =>
  join(stateDir(archiveRoot), "state.json");

export const importLockPath = (archiveRoot: string): string =>
  join(stateDir(archiveRoot), "import.lock");

export const unitKey = (path: string): string =>
  hashRecordValue("gno-session-unit-v1", path).slice(0, 32);

export async function loadState(archiveRoot: string): Promise<SessionsState> {
  const file = Bun.file(statePath(archiveRoot));
  if (!(await file.exists())) return { version: 1, sources: {} };
  try {
    const parsed = (await file.json()) as SessionsState;
    if (parsed?.version === 1 && parsed.sources) return parsed;
  } catch {
    // A corrupt state file only costs a full re-render; archives stay intact.
  }
  return { version: 1, sources: {} };
}

export async function saveState(
  archiveRoot: string,
  state: SessionsState
): Promise<void> {
  await mkdir(stateDir(archiveRoot), { recursive: true });
  await atomicWrite(statePath(archiveRoot), `${JSON.stringify(state)}\n`);
}

/**
 * Cheap change detector. SQLite sources include their WAL, where a live
 * writer appends without touching the main file.
 */
export async function unitFingerprint(unit: SessionUnit): Promise<string> {
  const main = await stat(unit.path);
  let fingerprint = `${main.size}:${Math.trunc(main.mtimeMs)}`;
  if (unit.storage === "sqlite") {
    try {
      const wal = await stat(`${unit.path}-wal`);
      fingerprint += `:${wal.size}:${Math.trunc(wal.mtimeMs)}`;
    } catch {
      fingerprint += ":-";
    }
  }
  return fingerprint;
}
