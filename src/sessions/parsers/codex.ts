/**
 * Codex rollout JSONL parser.
 *
 * Prompts of `codex exec` runs (`session_meta.source = "exec"`) come from a
 * program or script (often another agent) and are not archived as human
 * speech; interactive CLI and editor sessions are.
 *
 * Verified layouts (2026-09): every line is `{timestamp, ordinal?, type,
 * payload}` and the first line is `session_meta`.
 * - CLI >= 0.151: speech arrives as `event_msg` `item_completed` with
 *   `item.type` `UserMessage` / `AgentMessage`.
 * - CLI <= 0.150: speech arrives as `event_msg` `user_message` /
 *   `agent_message`.
 * `response_item` messages duplicate that speech and mix injected context
 * (environment, instructions, skills) into `role=user`, so they are never
 * used as a human signal. Reasoning and tool records are excluded.
 *
 * Forks and spawned subagents carry `forked_from_id` /
 * `subagent_history_start_ordinal`; records before that ordinal (including a
 * second `session_meta`) are copied parent history and are skipped. In a
 * spawned subagent thread the "user" message is the parent agent's task, not
 * human speech.
 *
 * @module src/sessions/parsers/codex
 */

import {
  emptyDiagnostics,
  normalizeTimestamp,
  noteUnknownKind,
  type ParsedThread,
  type ParsedTurn,
  type ParseUnitResult,
  type SessionThreadKind,
} from "../types";
import {
  flagMissingHumanTurns,
  isRecord,
  joinTextBlocks,
  pushTurn,
  readJsonlRecords,
  stringField,
} from "./shared";

export const CODEX_PARSER = "codex/1";

const SKIPPED_TOP_LEVEL = new Set([
  "response_item",
  "inter_agent_communication_metadata",
  "turn_context",
  "world_state",
  "token_usage_record",
  "compacted",
]);

const SKIPPED_EVENTS = new Set([
  "token_count",
  "task_started",
  "task_complete",
  "turn_started",
  "turn_complete",
  "turn_aborted",
  "agent_reasoning",
  "agent_reasoning_raw_content",
  "agent_reasoning_section_break",
  "thread_settings_applied",
  "exec_command_begin",
  "exec_command_end",
  "exec_command_output_delta",
  "patch_apply_begin",
  "patch_apply_end",
  "mcp_tool_call_begin",
  "mcp_tool_call_end",
  "web_search_begin",
  "web_search_end",
  "item_started",
  "item_updated",
  "context_compacted",
  "entered_review_mode",
  "exited_review_mode",
  "stream_error",
  "error",
  "warning",
  "background_event",
  "session_configured",
  "plan_update",
  "turn_diff",
  "get_history_entry_response",
  "view_image_tool_call",
]);

const SKIPPED_ITEMS = new Set([
  "CommandExecution",
  "Reasoning",
  "FileChange",
  "McpToolCall",
  "WebSearch",
  "TodoList",
  "ImageView",
  "CustomToolCall",
  "FunctionCall",
  "ContextCompaction",
  "Plan",
  "Extension",
  "SubAgentActivity",
  "CollabAgentToolCall",
]);

/** Text block types seen in completed items across CLI versions. */
const ITEM_TEXT_TYPES = ["text", "Text", "input_text", "output_text"];

interface Candidate extends ParsedTurn {
  shape: "item" | "legacy";
}

const itemText = (item: Record<string, unknown>): string | undefined =>
  joinTextBlocks(item.content, ITEM_TEXT_TYPES);

/** Report speech items whose content blocks no longer match (format drift). */
function noteUntextedItem(
  diagnostics: ReturnType<typeof emptyDiagnostics>,
  item: Record<string, unknown>
): void {
  const blocks = Array.isArray(item.content) ? item.content : [];
  const first = blocks.find(isRecord);
  noteUnknownKind(
    diagnostics,
    `${typeof item.type === "string" ? item.type : "unknown"}/content:${typeof first?.type === "string" ? first.type : "none"}`
  );
}

export async function parseCodexRollout(
  path: string
): Promise<ParseUnitResult> {
  const diagnostics = emptyDiagnostics();
  const candidates: Candidate[] = [];
  let meta: Record<string, unknown> | undefined;
  let historyStart: number | undefined;
  let cwd: string | undefined;
  let agentInstructionThread = false;
  let programmaticEntry = false;

  for await (const { lineNumber, record } of readJsonlRecords(
    path,
    diagnostics
  )) {
    const ordinal =
      typeof record.ordinal === "number" ? record.ordinal : lineNumber - 1;
    const type = record.type;
    const payload = isRecord(record.payload) ? record.payload : {};

    if (type === "session_meta") {
      if (!meta) {
        meta = payload;
        cwd = stringField(payload.cwd);
        const start = payload.subagent_history_start_ordinal;
        if (typeof start === "number" && start > 0) historyStart = start;
        const source = payload.source;
        const spawnParent =
          isRecord(source) &&
          isRecord(source.subagent) &&
          isRecord(source.subagent.thread_spawn)
            ? stringField(source.subagent.thread_spawn.parent_thread_id)
            : undefined;
        agentInstructionThread =
          payload.thread_source === "subagent" ||
          Boolean(stringField(payload.parent_thread_id) ?? spawnParent);
        // `codex exec` prompts are issued by a program or script, which may
        // be another agent; they are not attributed to a person.
        programmaticEntry = payload.source === "exec";
      } else {
        diagnostics.copiedHistorySkipped += 1;
      }
      continue;
    }

    if (historyStart !== undefined && ordinal < historyStart) {
      diagnostics.copiedHistorySkipped += 1;
      continue;
    }

    if (type === "turn_context") {
      cwd = stringField(payload.cwd) ?? cwd;
      continue;
    }
    if (typeof type === "string" && SKIPPED_TOP_LEVEL.has(type)) continue;
    if (type !== "event_msg") {
      noteUnknownKind(diagnostics, type);
      continue;
    }

    const eventType = payload.type;
    const timestamp = normalizeTimestamp(record.timestamp);
    const locator = `line:${lineNumber}`;
    if (eventType === "item_completed") {
      const item = isRecord(payload.item) ? payload.item : {};
      const itemType = item.type;
      if (itemType !== "UserMessage" && itemType !== "AgentMessage") {
        if (typeof itemType !== "string" || !SKIPPED_ITEMS.has(itemType)) {
          noteUnknownKind(diagnostics, `item_completed/${String(itemType)}`);
        }
        continue;
      }
      const text = itemText(item);
      if (text === undefined) {
        noteUntextedItem(diagnostics, item);
        continue;
      }
      candidates.push({
        shape: "item",
        turnId: stringField(item.id) ?? `ordinal:${ordinal}`,
        role: itemType === "UserMessage" ? "human" : "assistant",
        text,
        timestamp,
        locator,
        cwd,
      });
      continue;
    }
    if (eventType === "user_message" || eventType === "agent_message") {
      const text = stringField(payload.message);
      if (text === undefined) continue;
      candidates.push({
        shape: "legacy",
        turnId: `ordinal:${ordinal}`,
        role: eventType === "user_message" ? "human" : "assistant",
        text,
        timestamp,
        locator,
        cwd,
      });
      continue;
    }
    if (typeof eventType !== "string" || !SKIPPED_EVENTS.has(eventType)) {
      noteUnknownKind(diagnostics, `event_msg/${String(eventType)}`);
    }
  }

  if (!meta) {
    return {
      threads: [],
      diagnostics,
      complete: !diagnostics.truncatedTail,
      parser: CODEX_PARSER,
    };
  }

  // A file never mixes shapes in practice; if it did, the item shape wins so
  // the same speech is not archived twice.
  const hasItemShape = candidates.some((turn) => turn.shape === "item");
  const turns: ParsedTurn[] = [];
  for (const candidate of candidates) {
    if (hasItemShape && candidate.shape === "legacy") continue;
    const { shape: _shape, ...turn } = candidate;
    if (
      turn.role === "human" &&
      (agentInstructionThread || programmaticEntry)
    ) {
      diagnostics.injectedSkipped += 1;
      continue;
    }
    if (!pushTurn(turns, turn, diagnostics)) break;
  }

  const threadId = stringField(meta.id) ?? "unknown";
  const parentThreadId =
    stringField(meta.parent_thread_id) ?? stringField(meta.forked_from_id);
  let kind: SessionThreadKind = "main";
  if (agentInstructionThread) kind = "subagent";
  else if (stringField(meta.forked_from_id)) kind = "fork";
  if (kind === "main" && !programmaticEntry) {
    flagMissingHumanTurns(turns, diagnostics);
  }
  diagnostics.formatVersion = stringField(meta.cli_version);

  const thread: ParsedThread = {
    harness: "codex",
    threadId,
    sessionId: stringField(meta.session_id) ?? threadId,
    parentThreadId,
    kind,
    cwd: stringField(meta.cwd),
    turns,
  };
  return {
    threads: [thread],
    diagnostics,
    complete: !diagnostics.truncatedTail && !diagnostics.humanTurnsMissing,
    parser: CODEX_PARSER,
  };
}
