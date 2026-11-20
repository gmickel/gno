/**
 * Resume position for bounded embed runs (`--max-chunks`, `--max-seconds`).
 *
 * A bounded run that stops saves the position of its last attempted batch in
 * `schema_meta`. The next bounded run for the same scope starts after it,
 * reaches the end of the backlog and then wraps to the start, so chunks that
 * keep failing stay pending without blocking every later chunk. A pass that
 * completes clears the position. Advisory only: a missing or malformed value
 * reads as "start from the beginning".
 *
 * @module src/embed/resume-cursor
 */

import type { Database } from "bun:sqlite";

const PREFIX = "embed_resume_cursor:";

export function resumeCursorKey(
  scope: string,
  collection: string | undefined
): string {
  return `${PREFIX}${scope}:${collection ?? ""}`;
}

export function readResumeCursor<T extends object>(
  db: Database,
  key: string,
  isCursor: (value: unknown) => value is T
): T | undefined {
  try {
    const row = db
      .query<{ value: string }, [string]>(
        "SELECT value FROM schema_meta WHERE key = ?"
      )
      .get(key);
    if (!row) return undefined;
    const value: unknown = JSON.parse(row.value);
    return isCursor(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Saves the cursor, or removes it when `value` is undefined. */
export function writeResumeCursor(
  db: Database,
  key: string,
  value: object | undefined
): void {
  if (value === undefined) {
    db.run("DELETE FROM schema_meta WHERE key = ?", [key]);
    return;
  }
  db.run(
    `INSERT INTO schema_meta (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value)]
  );
}

export interface OwnerCursor {
  documentId: number;
  seq: number;
}

export function isOwnerCursor(value: unknown): value is OwnerCursor {
  const v = value as Partial<OwnerCursor> | null;
  return (
    !!v &&
    typeof v === "object" &&
    Number.isSafeInteger(v.documentId) &&
    Number.isSafeInteger(v.seq)
  );
}

/** Orders owners as pages do: by document id, then chunk seq. */
export function compareOwnerCursor(a: OwnerCursor, b: OwnerCursor): number {
  return a.documentId === b.documentId
    ? a.seq - b.seq
    : a.documentId - b.documentId;
}

export interface ChunkCursor {
  mirrorHash: string;
  seq: number;
}

export function isChunkCursor(value: unknown): value is ChunkCursor {
  const v = value as Partial<ChunkCursor> | null;
  return (
    !!v &&
    typeof v === "object" &&
    typeof v.mirrorHash === "string" &&
    Number.isSafeInteger(v.seq)
  );
}

/** Orders chunks as the legacy backlog does: by mirror hash, then seq. */
export function compareChunkCursor(a: ChunkCursor, b: ChunkCursor): number {
  if (a.mirrorHash !== b.mirrorHash)
    return a.mirrorHash < b.mirrorHash ? -1 : 1;
  return a.seq - b.seq;
}
