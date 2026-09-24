/**
 * OpenClaw session parser (SQLite agent store and legacy JSONL).
 *
 * Built from the upstream v2026.9.6 schema; no live OpenClaw store was
 * available when this parser was written, so fixtures are synthetic.
 *
 * - SQLite (`agents/<agentId>/agent/openclaw-agent.sqlite`): each
 *   `transcript_events` row stores one legacy JSONL entry in `event_json`
 *   (or a single zstd frame of that JSON in `event_zstd`).
 *   `transcript_events.session_id` names one transcript generation
 *   (`session_windows`); generations of one logical session share
 *   `session_windows.session_key`. A logical session is one thread; entries
 *   copied between generations or into a fork keep their entry `id` and are
 *   archived once.
 * - Legacy JSONL (`agents/<agentId>/sessions/<sessionId>.jsonl`): a
 *   `{type:"session"}` header followed by entries.
 *
 * Human speech is a `message` entry with `role=user` and text content,
 * unless its provenance marks inter-session or internal-system input, it is
 * wrapped as internal runtime context, or the thread is a spawned subagent
 * (whose first user message is the parent's task). `custom` runtime-context
 * messages, compaction and branch summaries, tool results and thinking are
 * never speech.
 *
 * @module src/sessions/parsers/openclaw
 */

import type { Database } from "bun:sqlite";

import {
  emptyDiagnostics,
  normalizeTimestamp,
  noteUnknownKind,
  type ParsedThread,
  type ParsedTurn,
  type ParseUnitResult,
  SESSION_LIMITS,
  type SessionThreadKind,
  type UnitDiagnostics,
} from "../types";
import {
  flagMissingHumanTurns,
  hasTables,
  isRecord,
  joinTextBlocks,
  type JsonRecord,
  pushTurn,
  readJsonlRecords,
  stringField,
  tableColumns,
  withReadOnlySnapshot,
} from "./shared";

export const OPENCLAW_PARSER = "openclaw/1";

const SKIPPED_ENTRY_TYPES = new Set([
  "session",
  "compaction",
  "branch_summary",
  "model_change",
  "thinking_level_change",
  "reset",
  "custom",
  "custom_message",
  "label",
  "session_info",
  "leaf",
]);

const SKIPPED_ROLES = new Set([
  "toolResult",
  "custom",
  "bashExecution",
  "branchSummary",
  "compactionSummary",
]);

const INTERNAL_CONTEXT_MARKER = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
const RUNTIME_CONTINUATION = "Continue the OpenClaw runtime event.";
const NON_HUMAN_PROVENANCE = new Set(["inter_session", "internal_system"]);

interface EntryContext {
  agentInstruction: boolean;
  seen: Set<string>;
  diagnostics: UnitDiagnostics;
  turns: ParsedTurn[];
  cwd?: string;
}

/** Classify one entry; returns false once the thread hit its turn limit. */
function acceptEntry(
  entry: JsonRecord,
  locator: string,
  context: EntryContext
): boolean {
  const type = entry.type;
  if (type !== "message") {
    if (typeof type === "string" && type === "session") {
      context.cwd ??= stringField(entry.cwd);
    }
    if (typeof type !== "string" || !SKIPPED_ENTRY_TYPES.has(type)) {
      noteUnknownKind(context.diagnostics, type);
    }
    return true;
  }
  const entryId = stringField(entry.id);
  if (entryId) {
    if (context.seen.has(entryId)) {
      context.diagnostics.copiedHistorySkipped += 1;
      return true;
    }
    context.seen.add(entryId);
  }
  const message = isRecord(entry.message) ? entry.message : {};
  const role = message.role;
  if (typeof role === "string" && SKIPPED_ROLES.has(role)) return true;
  if (role !== "user" && role !== "assistant") {
    noteUnknownKind(context.diagnostics, `role/${String(role)}`);
    return true;
  }
  const text = joinTextBlocks(message.content, ["text"]);
  if (text === undefined) return true;
  const timestamp =
    normalizeTimestamp(message.timestamp) ??
    normalizeTimestamp(entry.timestamp);
  const turn: ParsedTurn = {
    turnId: entryId ?? locator,
    role: role === "user" ? "human" : "assistant",
    text,
    timestamp,
    locator,
    cwd: context.cwd,
  };
  if (role === "user") {
    const provenance = isRecord(message.provenance)
      ? stringField(message.provenance.kind)
      : undefined;
    const injected =
      context.agentInstruction ||
      (provenance !== undefined && NON_HUMAN_PROVENANCE.has(provenance)) ||
      text.includes(INTERNAL_CONTEXT_MARKER) ||
      text.trim() === RUNTIME_CONTINUATION;
    if (injected) {
      context.diagnostics.injectedSkipped += 1;
      return true;
    }
  }
  return pushTurn(context.turns, turn, context.diagnostics);
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy JSONL
// ─────────────────────────────────────────────────────────────────────────────

export async function parseOpenClawJsonl(
  path: string
): Promise<ParseUnitResult> {
  const diagnostics = emptyDiagnostics();
  let header: JsonRecord | undefined;
  const context: EntryContext = {
    agentInstruction: false,
    seen: new Set(),
    diagnostics,
    turns: [],
  };
  let full = false;
  for await (const { lineNumber, record } of readJsonlRecords(
    path,
    diagnostics
  )) {
    if (!header && record.type === "session") {
      header = record;
      context.cwd = stringField(record.cwd);
      diagnostics.formatVersion =
        typeof record.version === "number" || typeof record.version === "string"
          ? String(record.version)
          : undefined;
      continue;
    }
    if (full) continue;
    full = !acceptEntry(record, `line:${lineNumber}`, context);
  }
  const threadId = stringField(header?.id);
  if (!header || !threadId) {
    return {
      threads: [],
      diagnostics,
      complete: !diagnostics.truncatedTail,
      parser: OPENCLAW_PARSER,
    };
  }
  const parent = stringField(header.parentSession);
  flagMissingHumanTurns(context.turns, diagnostics);
  return {
    threads: [
      {
        harness: "openclaw",
        threadId,
        sessionId: threadId,
        parentThreadId: parent,
        kind: parent ? "fork" : "main",
        cwd: context.cwd,
        turns: context.turns,
      },
    ],
    diagnostics,
    complete: !diagnostics.truncatedTail && !diagnostics.humanTurnsMissing,
    parser: OPENCLAW_PARSER,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SQLite agent store
// ─────────────────────────────────────────────────────────────────────────────

interface WindowRow {
  session_id: string;
  session_key: string;
  created_at: number | null;
}

interface NodeRow {
  session_key: string;
  parent_session_key: string | null;
  spawned_by: string | null;
  fork_source_session_key: string | null;
}

interface EventRow {
  seq: number;
  event_json: string | null;
  event_zstd: Uint8Array | null;
  event_utf8_bytes: number | null;
}

function decodeEvent(row: EventRow): JsonRecord | undefined {
  let text = row.event_json;
  if (text === null && row.event_zstd) {
    const expected = row.event_utf8_bytes ?? -1;
    if (expected < 1 || expected > 4 * 1024 * 1024) return undefined;
    const bytes = Bun.zstdDecompressSync(row.event_zstd);
    if (bytes.byteLength !== expected) return undefined;
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  if (text === null) return undefined;
  const parsed: unknown = JSON.parse(text);
  return isRecord(parsed) ? parsed : undefined;
}

/** Whether a database file carries the OpenClaw agent schema. */
export function isOpenClawDatabase(db: Database): boolean {
  return hasTables(db, ["transcript_events", "session_windows"]);
}

export function parseOpenClawDatabase(path: string): ParseUnitResult {
  const diagnostics = emptyDiagnostics();
  const threads: ParsedThread[] = withReadOnlySnapshot(path, (db) => {
    if (!isOpenClawDatabase(db)) return [];
    const nodeColumns = hasTables(db, ["session_nodes"])
      ? tableColumns(db, "session_nodes")
      : new Set<string>();
    const nodes = new Map<string, NodeRow>();
    if (nodeColumns.has("session_key")) {
      const pick = (column: string) =>
        nodeColumns.has(column) ? column : `NULL AS ${column}`;
      for (const row of db
        .query<NodeRow, []>(
          `SELECT session_key, ${pick("parent_session_key")}, ${pick("spawned_by")}, ${pick("fork_source_session_key")} FROM session_nodes`
        )
        .all()) {
        nodes.set(row.session_key, row);
      }
    }
    const meta = hasTables(db, ["schema_meta"])
      ? tableColumns(db, "schema_meta")
      : new Set<string>();
    if (meta.has("app_version")) {
      const row = db
        .query<{ app_version: string | null }, []>(
          "SELECT app_version FROM schema_meta LIMIT 1"
        )
        .get();
      if (row?.app_version) diagnostics.formatVersion = row.app_version;
    }
    const windowColumns = tableColumns(db, "session_windows");
    const windows = db
      .query<WindowRow, []>(
        `SELECT session_id, session_key, ${windowColumns.has("created_at") ? "created_at" : "NULL AS created_at"} FROM session_windows ORDER BY created_at, session_id`
      )
      .all();
    const byKey = new Map<string, string[]>();
    for (const window of windows) {
      const list = byKey.get(window.session_key) ?? [];
      list.push(window.session_id);
      byKey.set(window.session_key, list);
    }
    const eventColumns = tableColumns(db, "transcript_events");
    const zstd = eventColumns.has("event_zstd");
    const eventQuery = db.query<EventRow, [string]>(
      `SELECT seq, event_json, ${zstd ? "event_zstd, event_utf8_bytes" : "NULL AS event_zstd, NULL AS event_utf8_bytes"} FROM transcript_events WHERE session_id = ? ORDER BY seq`
    );

    const seenByKey = new Map<string, Set<string>>();
    const result: ParsedThread[] = [];
    // Parents before forks so copied entry IDs are known when a fork is read.
    const keys = [...byKey.keys()].sort((left, right) => {
      const leftFork = nodes.get(left)?.fork_source_session_key ? 1 : 0;
      const rightFork = nodes.get(right)?.fork_source_session_key ? 1 : 0;
      return leftFork - rightFork || left.localeCompare(right);
    });
    for (const key of keys.slice(0, SESSION_LIMITS.maxThreadsPerUnit)) {
      const node = nodes.get(key);
      const spawned = Boolean(node?.spawned_by) || key.includes(":subagent:");
      const forkSource = node?.fork_source_session_key ?? undefined;
      const seen = new Set<string>(
        forkSource ? (seenByKey.get(forkSource) ?? []) : []
      );
      const context: EntryContext = {
        agentInstruction: spawned,
        seen,
        diagnostics,
        turns: [],
      };
      let full = false;
      for (const sessionId of byKey.get(key) ?? []) {
        for (const row of eventQuery.all(sessionId)) {
          if (full) break;
          let entry: JsonRecord | undefined;
          try {
            entry = decodeEvent(row);
          } catch {
            entry = undefined;
          }
          if (!entry) {
            diagnostics.malformedRecords += 1;
            continue;
          }
          if (entry.type === "session") {
            context.cwd ??= stringField(entry.cwd);
            continue;
          }
          full = !acceptEntry(
            entry,
            `transcript_events/${sessionId}/${row.seq}`,
            context
          );
        }
      }
      seenByKey.set(key, seen);
      let kind: SessionThreadKind = "main";
      if (spawned) kind = "subagent";
      else if (forkSource) kind = "fork";
      if (kind === "main") flagMissingHumanTurns(context.turns, diagnostics);
      result.push({
        harness: "openclaw",
        threadId: key,
        sessionId: node?.parent_session_key ?? forkSource ?? key,
        parentThreadId:
          node?.parent_session_key ?? node?.spawned_by ?? forkSource,
        kind,
        cwd: context.cwd,
        turns: context.turns,
      });
    }
    return result;
  });
  return {
    threads,
    diagnostics,
    complete: !diagnostics.humanTurnsMissing,
    parser: OPENCLAW_PARSER,
  };
}
