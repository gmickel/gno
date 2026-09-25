/**
 * Hermes `state.db` parser.
 *
 * Built from the Hermes v0.19 schema (`SCHEMA_VERSION = 22`); no populated
 * store was available locally, so fixtures are synthetic.
 *
 * - `sessions(id, source, parent_session_id, started_at, cwd, model_config,
 *   end_reason, ...)` and `messages(id, session_id, role, content,
 *   timestamp, active, compacted, ...)`.
 * - Every session is one thread. `parent_session_id` is overloaded: a
 *   delegated subagent (`model_config.$._delegate_from`, or a child that is
 *   neither a branch nor a compression continuation) receives the parent's
 *   task as its `role=user` message, so its user messages are not human.
 * - In-place compaction soft-archives the original rows (`active=0,
 *   compacted=1`) and inserts a summary plus copied tail rows. Original rows
 *   are archived; inserted copies of an archived row are skipped, and
 *   compaction summaries are recognised by their fixed prefix. Rewound rows
 *   (`active=0, compacted=0`) were retracted and are skipped. Continuation
 *   sessions skip rows copied from the parent the same way.
 * - Tool, system and reasoning content are excluded.
 *
 * @module src/sessions/parsers/hermes
 */

import type { Database } from "bun:sqlite";

import {
  emptyDiagnostics,
  normalizeTimestamp,
  type ParsedThread,
  type ParsedTurn,
  type ParseUnitResult,
  SESSION_LIMITS,
  type SessionThreadKind,
} from "../types";
import {
  copiedPrefixLength,
  missingHumanTurns,
  hasTables,
  pushTurn,
  tableColumns,
  withReadOnlySnapshot,
} from "./shared";

export const HERMES_PARSER = "hermes/1";

const SUMMARY_PREFIXES = ["[CONTEXT COMPACTION", "[CONTEXT SUMMARY]:"];

interface SessionRow {
  id: string;
  parent_session_id: string | null;
  started_at: number | null;
  cwd: string | null;
  model_config: string | null;
  end_reason: string | null;
  parent_end_reason: string | null;
  parent_ended_at: number | null;
}

interface MessageRow {
  id: number;
  role: string;
  content: string | null;
  timestamp: number | null;
  active: number | null;
  compacted: number | null;
}

export function isHermesDatabase(db: Database): boolean {
  return (
    hasTables(db, ["sessions", "messages"]) &&
    tableColumns(db, "messages").has("session_id")
  );
}

function configFlag(raw: string | null, key: string): boolean {
  if (!raw) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Boolean(
      parsed &&
      typeof parsed === "object" &&
      (parsed as Record<string, unknown>)[key]
    );
  } catch {
    return false;
  }
}

function classifyChild(row: SessionRow): SessionThreadKind {
  if (!row.parent_session_id) return "main";
  if (configFlag(row.model_config, "_delegate_from")) return "subagent";
  if (configFlag(row.model_config, "_branched_from")) return "fork";
  if (row.parent_end_reason === "compression") return "continuation";
  if (
    row.parent_end_reason === "branched" &&
    (row.started_at ?? 0) >= (row.parent_ended_at ?? 0)
  ) {
    return "fork";
  }
  return "subagent";
}

const contentKey = (role: string, content: string): string =>
  `${role}\0${content}`;

const isSummary = (content: string): boolean => {
  const trimmed = content.trimStart();
  return SUMMARY_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
};

/**
 * Rows a harness copied from earlier history: the contiguous block right
 * after each in-place compaction point that repeats the tail of the
 * compacted originals, and the block at a continuation's start that repeats
 * the tail of its parent. A later genuine repeat ("yes") is kept.
 */
function copiedRowIds(
  rows: readonly MessageRow[],
  parentSpeech: readonly string[]
): Set<number> {
  const copied = new Set<number>();
  const skipBlock = (startIndex: number, source: readonly string[]): void => {
    // Rewound rows and summaries are dropped anyway; they do not break a block.
    const candidates: MessageRow[] = [];
    for (let cursor = startIndex; cursor < rows.length; cursor += 1) {
      const row = rows[cursor]!;
      if (row.compacted === 1) break;
      if (row.active === 0 || isSummary(row.content ?? "")) continue;
      candidates.push(row);
    }
    const length = copiedPrefixLength(
      candidates.map((row) => contentKey(row.role, row.content ?? "")),
      source
    );
    for (const row of candidates.slice(0, length)) copied.add(row.id);
  };
  if (parentSpeech.length > 0) skipBlock(0, parentSpeech);
  const originals: string[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.compacted === 1) {
      originals.push(contentKey(row.role, row.content ?? ""));
      const next = rows[index + 1];
      if (next && next.compacted !== 1) skipBlock(index + 1, originals);
    }
  }
  return copied;
}

export function parseHermesDatabase(path: string): ParseUnitResult {
  const diagnostics = emptyDiagnostics();
  const threads = withReadOnlySnapshot(path, (db) => {
    if (!isHermesDatabase(db)) return [];
    const sessionColumns = tableColumns(db, "sessions");
    const messageColumns = tableColumns(db, "messages");
    const col = (columns: Set<string>, name: string, alias = name) =>
      columns.has(name) ? `s.${name} AS ${alias}` : `NULL AS ${alias}`;
    const sessions = db
      .query<SessionRow, []>(
        `SELECT s.id AS id, ${col(sessionColumns, "parent_session_id")}, ${col(sessionColumns, "started_at")}, ${col(sessionColumns, "cwd")}, ${col(sessionColumns, "model_config")}, ${col(sessionColumns, "end_reason")},
           ${sessionColumns.has("parent_session_id") && sessionColumns.has("end_reason") ? "p.end_reason" : "NULL"} AS parent_end_reason,
           ${sessionColumns.has("parent_session_id") && sessionColumns.has("ended_at") ? "p.ended_at" : "NULL"} AS parent_ended_at
         FROM sessions s
         ${sessionColumns.has("parent_session_id") ? "LEFT JOIN sessions p ON p.id = s.parent_session_id" : ""}
         ORDER BY ${sessionColumns.has("started_at") ? "s.started_at," : ""} s.id`
      )
      .all();
    const pickMessage = (name: string) =>
      messageColumns.has(name) ? name : `NULL AS ${name}`;
    // Insertion order (id) keeps a copied block contiguous with its origin.
    const messageQuery = db.query<MessageRow, [string]>(
      `SELECT id, role, content, ${pickMessage("timestamp")}, ${pickMessage("active")}, ${pickMessage("compacted")} FROM messages WHERE session_id = ? ORDER BY id`
    );
    const speechBySession = new Map<string, string[]>();
    const result: ParsedThread[] = [];
    diagnostics.threadsOverLimit = Math.max(
      0,
      sessions.length - SESSION_LIMITS.maxThreadsPerUnit
    );
    for (const session of sessions.slice(0, SESSION_LIMITS.maxThreadsPerUnit)) {
      const kind = classifyChild(session);
      const rows = messageQuery
        .all(session.id)
        .filter(
          (row) =>
            (row.role === "user" || row.role === "assistant") &&
            (row.content ?? "").trim() !== ""
        );
      const copied = copiedRowIds(
        rows,
        kind === "continuation" && session.parent_session_id
          ? (speechBySession.get(session.parent_session_id) ?? [])
          : []
      );
      diagnostics.copiedHistorySkipped += copied.size;
      const speech: string[] = [];
      const turns: ParsedTurn[] = [];
      for (const row of rows) {
        const content = row.content ?? "";
        const rewound = row.active === 0 && row.compacted !== 1;
        if (rewound || copied.has(row.id)) continue;
        if (isSummary(content)) {
          diagnostics.injectedSkipped += 1;
          continue;
        }
        speech.push(contentKey(row.role, content));
        if (row.role === "user" && kind === "subagent") {
          diagnostics.injectedSkipped += 1;
          continue;
        }
        const pushed = pushTurn(
          turns,
          {
            turnId: `message:${row.id}`,
            role: row.role === "user" ? "human" : "assistant",
            text: content,
            timestamp: normalizeTimestamp(row.timestamp),
            locator: `messages/${row.id}`,
            cwd: session.cwd ?? undefined,
          },
          diagnostics
        );
        if (!pushed) break;
      }
      speechBySession.set(session.id, speech);
      if (kind === "main" && missingHumanTurns(turns)) {
        diagnostics.threadsWithoutHuman += 1;
      }
      result.push({
        harness: "hermes",
        threadId: session.id,
        sessionId: session.parent_session_id ?? session.id,
        parentThreadId: session.parent_session_id ?? undefined,
        kind,
        cwd: session.cwd ?? undefined,
        turns,
      });
    }
    return result;
  });
  return {
    threads,
    diagnostics,
    complete: diagnostics.threadsOverLimit === 0,
    parser: HERMES_PARSER,
  };
}
