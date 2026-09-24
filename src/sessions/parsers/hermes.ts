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
  flagMissingHumanTurns,
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
    const messageQuery = db.query<MessageRow, [string]>(
      `SELECT id, role, content, ${pickMessage("timestamp")}, ${pickMessage("active")}, ${pickMessage("compacted")} FROM messages WHERE session_id = ? ORDER BY ${messageColumns.has("timestamp") ? "timestamp," : ""} id`
    );
    const contentBySession = new Map<string, Set<string>>();
    const result: ParsedThread[] = [];
    for (const session of sessions.slice(0, SESSION_LIMITS.maxThreadsPerUnit)) {
      const kind = classifyChild(session);
      const rows = messageQuery.all(session.id);
      const archivedCopies = new Set<string>();
      for (const row of rows) {
        if (row.compacted === 1 && row.content) {
          archivedCopies.add(contentKey(row.role, row.content));
        }
      }
      const parentContent =
        kind === "continuation" && session.parent_session_id
          ? contentBySession.get(session.parent_session_id)
          : undefined;
      const own = new Set<string>();
      const turns: ParsedTurn[] = [];
      for (const row of rows) {
        if (row.role !== "user" && row.role !== "assistant") continue;
        const content = row.content ?? "";
        if (!content.trim()) continue;
        const key = contentKey(row.role, content);
        own.add(key);
        const archivedOriginal = row.compacted === 1;
        const rewound = row.active === 0 && row.compacted !== 1;
        if (rewound) continue;
        if (!archivedOriginal && archivedCopies.has(key)) {
          diagnostics.copiedHistorySkipped += 1;
          continue;
        }
        if (parentContent?.has(key)) {
          diagnostics.copiedHistorySkipped += 1;
          continue;
        }
        const trimmed = content.trimStart();
        if (SUMMARY_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
          diagnostics.injectedSkipped += 1;
          continue;
        }
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
      contentBySession.set(session.id, own);
      if (kind === "main") flagMissingHumanTurns(turns, diagnostics);
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
    complete: !diagnostics.humanTurnsMissing,
    parser: HERMES_PARSER,
  };
}
