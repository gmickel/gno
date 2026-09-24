/**
 * Claude Code project JSONL parser.
 *
 * Verified layouts (2026-09, CLI 2.1.2xx): `projects/<encoded-cwd>/<sessionId>.jsonl`
 * for the main thread and `.../<sessionId>/subagents/agent-<agentId>.jsonl`
 * for spawned subagents. Records carry `uuid`, `sessionId`, `timestamp`,
 * `cwd`, `version`, `type`.
 *
 * Human speech is structural: `type=user` records whose `origin.kind` is
 * `human`. Files written before the `origin` field existed fall back to a
 * conservative shape test (plain text, not meta, not a compaction summary,
 * no tool result, no command/notification wrapper). Injected attachments,
 * system records, compaction summaries, slash-command wrappers, task
 * notifications and the parent task prompt inside a subagent file are never
 * human speech. A slash command a person typed (`origin.kind=human`) is
 * archived as `/name args`. Prompts of SDK / `claude -p` sessions
 * (`entrypoint=sdk-*`) come from a program and are not attributed to a
 * person. Assistant turns are the text blocks of `type=assistant` records;
 * thinking and tool calls are excluded.
 *
 * @module src/sessions/parsers/claude-code
 */

import {
  emptyDiagnostics,
  normalizeTimestamp,
  noteUnknownKind,
  type ParsedThread,
  type ParsedTurn,
  type ParseUnitResult,
} from "../types";
import {
  missingHumanTurns,
  isRecord,
  joinTextBlocks,
  pushTurn,
  readJsonlRecords,
  stringField,
} from "./shared";

export const CLAUDE_CODE_PARSER = "claude-code/1";

const SKIPPED_TYPES = new Set([
  "attachment",
  "system",
  "summary",
  "file-history-snapshot",
  "file-history-delta",
  "queue-operation",
  "last-prompt",
  "ai-title",
  "custom-title",
  "permission-mode",
  "mode",
  "bridge-session",
  "atis-latch",
  "frame-link",
  "pr-link",
  "cost-state",
  "tag",
  "agent-name",
  "continued-in",
  "artifact-autoreact-ledger",
  "artifact-comment-monitor",
  "progress",
  "fork-context-ref",
  "history-suppression",
]);

/** Wrappers the CLI writes around non-speech input. */
const WRAPPER_PREFIXES = [
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-",
  "<task-notification>",
  "<system-reminder>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "<user-memory-input>",
];

const COMMAND_NAME = /<command-name>([^<]{1,256})<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]{0,65536}?)<\/command-args>/;

/** A human-typed slash command becomes `/name args`; other wrappers stay out. */
function slashCommandText(text: string): string | undefined {
  const name = COMMAND_NAME.exec(text)?.[1]?.trim();
  if (!name) return undefined;
  const args = COMMAND_ARGS.exec(text)?.[1]?.trim() ?? "";
  const command = name.startsWith("/") ? name : `/${name}`;
  return args ? `${command} ${args}` : command;
}

interface UserCandidate {
  turn: ParsedTurn;
  originKind?: string;
  hasOrigin: boolean;
  plainShape: boolean;
}

const SUBAGENT_FILE = /(?:^|\/)agent-([A-Za-z0-9_-]{1,128})\.jsonl$/;

function userText(message: Record<string, unknown>): {
  text?: string;
  hasToolResult: boolean;
} {
  const content = message.content;
  if (typeof content === "string")
    return { text: content, hasToolResult: false };
  if (!Array.isArray(content)) return { hasToolResult: false };
  const hasToolResult = content.some(
    (block) => isRecord(block) && block.type === "tool_result"
  );
  return { text: joinTextBlocks(content, ["text"]), hasToolResult };
}

export async function parseClaudeCodeSession(
  path: string
): Promise<ParseUnitResult> {
  const diagnostics = emptyDiagnostics();
  const subagentMatch = SUBAGENT_FILE.exec(path.replaceAll("\\", "/"));
  const isSubagentFile = Boolean(subagentMatch);
  const ordered: Array<ParsedTurn | UserCandidate> = [];
  let sessionId: string | undefined;
  let agentId: string | undefined = subagentMatch?.[1];
  let firstCwd: string | undefined;
  let fileHasOrigin = false;
  let programmaticEntry = false;

  for await (const { lineNumber, record } of readJsonlRecords(
    path,
    diagnostics
  )) {
    const type = record.type;
    sessionId ??= stringField(record.sessionId);
    agentId ??= isSubagentFile ? stringField(record.agentId) : undefined;
    const cwd = stringField(record.cwd);
    firstCwd ??= cwd;
    if (diagnostics.formatVersion === undefined) {
      diagnostics.formatVersion = stringField(record.version);
    }
    if (type === "user" && "origin" in record) fileHasOrigin = true;
    // SDK / `claude -p` sessions receive prompts from a program, which may be
    // another agent; they are not attributed to a person.
    const entrypoint = stringField(record.entrypoint);
    if (entrypoint?.startsWith("sdk")) programmaticEntry = true;

    if (type !== "user" && type !== "assistant") {
      if (typeof type !== "string" || !SKIPPED_TYPES.has(type)) {
        noteUnknownKind(diagnostics, type);
      }
      continue;
    }
    const message = isRecord(record.message) ? record.message : {};
    const base = {
      turnId: stringField(record.uuid) ?? `line:${lineNumber}`,
      timestamp: normalizeTimestamp(record.timestamp),
      locator: `line:${lineNumber}`,
      cwd,
    };

    // Sidechain records inside a main file are agent-to-agent traffic.
    if (!isSubagentFile && record.isSidechain === true) {
      diagnostics.injectedSkipped += 1;
      continue;
    }

    if (type === "assistant") {
      const text = joinTextBlocks(message.content, ["text"]);
      if (text !== undefined) {
        ordered.push({ ...base, role: "assistant", text });
      }
      continue;
    }

    const { text, hasToolResult } = userText(message);
    if (hasToolResult || text === undefined) continue;
    const trimmed = text.trimStart();
    const wrapped = WRAPPER_PREFIXES.some((prefix) =>
      trimmed.startsWith(prefix)
    );
    const plainShape =
      record.isMeta !== true &&
      record.isCompactSummary !== true &&
      record.isVisibleInTranscriptOnly !== true &&
      !wrapped;
    const origin = isRecord(record.origin) ? record.origin : undefined;
    const originKind = stringField(origin?.kind);
    const command =
      originKind === "human" && wrapped && record.isMeta !== true
        ? slashCommandText(trimmed)
        : undefined;
    ordered.push({
      turn: { ...base, role: "human", text: command ?? text },
      originKind,
      hasOrigin: "origin" in record,
      plainShape: plainShape || command !== undefined,
    });
  }

  const turns: ParsedTurn[] = [];
  for (const entry of ordered) {
    let turn: ParsedTurn;
    if ("turn" in entry) {
      // In a subagent file the "user" message is the parent agent's task.
      const human =
        !isSubagentFile &&
        !programmaticEntry &&
        entry.plainShape &&
        (fileHasOrigin ? entry.originKind === "human" : true);
      if (!human) {
        diagnostics.injectedSkipped += 1;
        continue;
      }
      turn = entry.turn;
    } else {
      turn = entry;
    }
    if (!pushTurn(turns, turn, diagnostics)) break;
  }

  if (!sessionId) {
    return {
      threads: [],
      diagnostics,
      complete: !diagnostics.truncatedTail,
      parser: CLAUDE_CODE_PARSER,
    };
  }
  if (!(isSubagentFile || programmaticEntry)) {
    diagnostics.humanTurnsMissing = missingHumanTurns(turns);
  }
  const thread: ParsedThread = isSubagentFile
    ? {
        harness: "claude-code",
        threadId: `${sessionId}/agent-${agentId ?? "unknown"}`,
        sessionId,
        parentThreadId: sessionId,
        kind: "subagent",
        cwd: firstCwd,
        turns,
      }
    : {
        harness: "claude-code",
        threadId: sessionId,
        sessionId,
        kind: "main",
        cwd: firstCwd,
        turns,
      };
  return {
    threads: [thread],
    diagnostics,
    complete: !diagnostics.truncatedTail && !diagnostics.humanTurnsMissing,
    parser: CLAUDE_CODE_PARSER,
  };
}
