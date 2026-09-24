/**
 * Shared helpers for harness parsers: bounded JSONL iteration, read-only
 * SQLite snapshots and text extraction.
 *
 * @module src/sessions/parsers/shared
 */

import { Database } from "bun:sqlite";

import { readBoundedUtf8Lines } from "../../converters/adapters/shared/utf8-lines";
import {
  type ParsedTurn,
  SESSION_LIMITS,
  type UnitDiagnostics,
} from "../types";

export type JsonRecord = Record<string, unknown>;

export interface JsonlLine {
  lineNumber: number;
  record: JsonRecord;
}

export const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const stringField = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Iterate the JSON object lines of a file without retaining whole lines
 * beyond the limit. Over-limit and malformed lines are counted; a final line
 * cut mid-write marks the unit incomplete through `truncatedTail`.
 */
export async function* readJsonlRecords(
  path: string,
  diagnostics: UnitDiagnostics
): AsyncGenerator<JsonlLine> {
  const lines = readBoundedUtf8Lines(
    Bun.file(path).stream() as unknown as AsyncIterable<Uint8Array>,
    SESSION_LIMITS.maxLineBytes
  );
  for await (const line of lines) {
    if (!line.ok) {
      if (!line.terminated) {
        diagnostics.truncatedTail = true;
      } else if (line.reason === "line_too_large") {
        diagnostics.overLimitRecords += 1;
      } else {
        diagnostics.malformedRecords += 1;
      }
      continue;
    }
    if (line.text.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.text);
    } catch {
      if (line.terminated) diagnostics.malformedRecords += 1;
      else diagnostics.truncatedTail = true;
      continue;
    }
    if (!isRecord(parsed)) {
      diagnostics.malformedRecords += 1;
      continue;
    }
    yield { lineNumber: line.lineNumber, record: parsed };
  }
}

/** Join the text blocks of a content value; non-text blocks are ignored. */
export function joinTextBlocks(
  content: unknown,
  textTypes: readonly string[] = ["text", "input_text", "output_text"]
): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = block.type;
    if (typeof type === "string" && textTypes.includes(type)) {
      const text = block.text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Accept a classified turn, enforcing per-turn and per-thread bounds.
 * Returns false when the thread reached its turn limit.
 */
export function pushTurn(
  turns: ParsedTurn[],
  turn: ParsedTurn,
  diagnostics: UnitDiagnostics
): boolean {
  const text = turn.text.trim();
  if (!text) return true;
  if (text.length > SESSION_LIMITS.maxTurnChars) {
    diagnostics.overLimitTurns += 1;
    return true;
  }
  if (turns.length >= SESSION_LIMITS.maxTurnsPerThread) {
    diagnostics.overLimitTurns += 1;
    return false;
  }
  turns.push({ ...turn, text });
  return true;
}

/**
 * Open a SQLite source read-only and run `read` inside one read transaction,
 * so a live WAL writer cannot tear the view. No raw copy is made.
 */
export function withReadOnlySnapshot<T>(
  path: string,
  read: (db: Database) => T
): T {
  const db = new Database(path, { readonly: true });
  try {
    db.exec("PRAGMA query_only = ON");
    db.exec("BEGIN");
    try {
      return read(db);
    } finally {
      db.exec("COMMIT");
    }
  } finally {
    db.close();
  }
}

export function tableColumns(db: Database, table: string): Set<string> {
  const rows = db
    .query<{ name: string }, []>(`PRAGMA table_info(${JSON.stringify(table)})`)
    .all();
  return new Set(rows.map((row) => row.name));
}

export function hasTables(db: Database, tables: readonly string[]): boolean {
  const rows = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    )
    .all();
  const names = new Set(rows.map((row) => row.name));
  return tables.every((table) => names.has(table));
}

/** Human turns absent while assistant turns exist signals format drift. */
export function flagMissingHumanTurns(
  turns: readonly ParsedTurn[],
  diagnostics: UnitDiagnostics
): void {
  const assistant = turns.some((turn) => turn.role === "assistant");
  const human = turns.some((turn) => turn.role === "human");
  if (assistant && !human) diagnostics.humanTurnsMissing = true;
}
