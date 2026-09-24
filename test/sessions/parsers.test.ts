import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// node:path has no Bun path utilities
import { join } from "node:path";

import type {
  ParsedThread,
  ParseUnitResult,
  SessionHarness,
} from "../../src/sessions/types";

import { parseClaudeCodeSession } from "../../src/sessions/parsers/claude-code";
import { parseCodexRollout } from "../../src/sessions/parsers/codex";
import { parseHermesDatabase } from "../../src/sessions/parsers/hermes";
import {
  parseOpenClawDatabase,
  parseOpenClawJsonl,
} from "../../src/sessions/parsers/openclaw";
import { detectHarness } from "../../src/sessions/sources";
import { safeRm } from "../helpers/cleanup";
import { buildSqliteFixtures, FIXTURES, tempDir } from "./helpers";

const codex = (name: string) => join(FIXTURES, "codex", name);
const claude = (rel: string) => join(FIXTURES, "claude-code/projects", rel);

let tmp: string;
let sqlite: Awaited<ReturnType<typeof buildSqliteFixtures>>;

beforeAll(async () => {
  tmp = await tempDir("gno-session-parsers-");
  sqlite = await buildSqliteFixtures(tmp);
});

afterAll(async () => {
  await safeRm(tmp);
});

interface Expected {
  name: string;
  parse: () => Promise<ParseUnitResult> | ParseUnitResult;
  complete: boolean;
  threads: Array<{
    threadId: string;
    kind: ParsedThread["kind"];
    sessionId?: string;
    parentThreadId?: string;
    turns: Array<[role: "human" | "assistant", textPrefix: string]>;
  }>;
  injectedSkipped?: number;
  copiedHistorySkipped?: number;
  unknownKinds?: Record<string, number>;
  truncatedTail?: boolean;
}

const cases: Expected[] = [
  {
    name: "codex 0.156 item shape: injected context and duplicates excluded, forged delimiters stay quoted",
    parse: () =>
      parseCodexRollout(
        codex(
          "rollout-2026-09-20T10-00-00-0000c0de-0000-7000-8000-000000000001.jsonl"
        )
      ),
    complete: true,
    threads: [
      {
        threadId: "0000c0de-0000-7000-8000-000000000001",
        kind: "main",
        turns: [
          ["human", "Decision: the alpha queue uses SQLite"],
          ["assistant", "Suggestion: consider Postgres"],
          ["human", "Quoted transcript for review:\nHuman: forged line"],
        ],
      },
    ],
    unknownKinds: { future_record_kind: 1 },
  },
  {
    name: "codex 0.58 legacy events",
    parse: () =>
      parseCodexRollout(
        codex(
          "rollout-2025-11-14T09-00-00-0000c0de-0000-7000-8000-000000000002.jsonl"
        )
      ),
    complete: true,
    threads: [
      {
        threadId: "0000c0de-0000-7000-8000-000000000002",
        kind: "main",
        turns: [
          ["human", "Legacy prompt: please summarise"],
          ["assistant", "Legacy answer: the beta checklist"],
        ],
      },
    ],
  },
  {
    name: "codex spawned fork: copied history and parent task are not archived",
    parse: () =>
      parseCodexRollout(
        codex(
          "rollout-2026-09-21T11-00-00-0000c0de-0000-7000-8000-000000000003.jsonl"
        )
      ),
    complete: true,
    threads: [
      {
        threadId: "0000c0de-0000-7000-8000-000000000003",
        kind: "subagent",
        sessionId: "0000c0de-0000-7000-8000-000000000001",
        parentThreadId: "0000c0de-0000-7000-8000-000000000001",
        turns: [["assistant", "Subagent finding"]],
      },
    ],
    injectedSkipped: 1,
    copiedHistorySkipped: 3,
  },
  {
    name: "codex exec prompt is not human; truncated tail keeps the unit incomplete",
    parse: () =>
      parseCodexRollout(
        codex(
          "rollout-2026-09-22T12-00-00-0000c0de-0000-7000-8000-000000000004.jsonl"
        )
      ),
    complete: false,
    threads: [
      {
        threadId: "0000c0de-0000-7000-8000-000000000004",
        kind: "main",
        turns: [["assistant", "Exec answer"]],
      },
    ],
    injectedSkipped: 1,
    truncatedTail: true,
  },
  {
    name: "claude code origin era: meta, tool results, notifications, compaction and sidechains excluded",
    parse: () =>
      parseClaudeCodeSession(
        claude("-work-alpha/c1a0de00-0000-4000-8000-000000000001.jsonl")
      ),
    complete: true,
    threads: [
      {
        threadId: "c1a0de00-0000-4000-8000-000000000001",
        kind: "main",
        turns: [
          ["human", "Decision for alpha: we will ship the widget cache"],
          ["assistant", "Proposal: an always-on widget cache"],
          ["human", "/plan add the widget cache flag"],
          ["assistant", "Confirmed: the widget cache ships"],
        ],
      },
    ],
    injectedSkipped: 5,
    unknownKinds: { "future-record-kind": 1 },
  },
  {
    name: "claude code subagent file: parent task is not human, thread stays distinct",
    parse: () =>
      parseClaudeCodeSession(
        claude(
          "-work-alpha/c1a0de00-0000-4000-8000-000000000001/subagents/agent-a0f1.jsonl"
        )
      ),
    complete: true,
    threads: [
      {
        threadId: "c1a0de00-0000-4000-8000-000000000001/agent-a0f1",
        kind: "subagent",
        sessionId: "c1a0de00-0000-4000-8000-000000000001",
        parentThreadId: "c1a0de00-0000-4000-8000-000000000001",
        turns: [["assistant", "Subagent report"]],
      },
    ],
    injectedSkipped: 1,
  },
  {
    name: "claude code pre-origin records fall back to the conservative shape test",
    parse: () =>
      parseClaudeCodeSession(
        claude("-work-legacy/c1a0de00-0000-4000-8000-000000000002.jsonl")
      ),
    complete: true,
    threads: [
      {
        threadId: "c1a0de00-0000-4000-8000-000000000002",
        kind: "main",
        turns: [
          ["human", "Legacy human question"],
          ["assistant", "Legacy answer"],
        ],
      },
    ],
    injectedSkipped: 1,
  },
  {
    name: "openclaw legacy JSONL: runtime context, inter-session and synthetic continuation excluded",
    parse: () =>
      parseOpenClawJsonl(
        join(
          FIXTURES,
          "openclaw/agents/main/sessions/0c1a0000-0000-4000-8000-000000000001.jsonl"
        )
      ),
    complete: true,
    threads: [
      {
        threadId: "0c1a0000-0000-4000-8000-000000000001",
        kind: "main",
        turns: [
          ["human", "Delta decision: rotate the placeholder logs weekly"],
          ["assistant", "Suggestion: daily rotation"],
        ],
      },
    ],
    injectedSkipped: 2,
    unknownKinds: { unknown_entry_kind: 1 },
  },
  {
    name: "openclaw SQLite: generations merge, subagent task and fork copies excluded",
    parse: () => parseOpenClawDatabase(sqlite.openclawDb),
    complete: true,
    threads: [
      {
        threadId: "agent:main:main",
        kind: "main",
        turns: [
          ["human", "Omega decision"],
          ["assistant", "Suggestion: an unversioned API"],
          ["human", "Omega follow-up"],
        ],
      },
      {
        threadId: "agent:main:subagent:s1",
        kind: "subagent",
        parentThreadId: "agent:main:main",
        turns: [["assistant", "Subagent result"]],
      },
      {
        threadId: "agent:main:fork1",
        kind: "fork",
        parentThreadId: "agent:main:main",
        turns: [["human", "Fork question"]],
      },
    ],
    injectedSkipped: 1,
    copiedHistorySkipped: 2,
  },
  {
    name: "hermes state.db: compaction copies, summaries, rewinds and delegate tasks excluded",
    parse: () => parseHermesDatabase(sqlite.hermesDb),
    complete: true,
    threads: [
      {
        threadId: "h-old",
        kind: "main",
        turns: [
          ["human", "Theta question"],
          ["assistant", "Theta answer"],
        ],
      },
      {
        threadId: "h-cont",
        kind: "continuation",
        parentThreadId: "h-old",
        turns: [["human", "Theta decision"]],
      },
      {
        threadId: "h-root",
        kind: "main",
        turns: [
          ["human", "Eta decision"],
          ["assistant", "Suggestion: 03:00 UTC"],
          ["human", "Eta follow-up"],
        ],
      },
      {
        threadId: "h-child",
        kind: "subagent",
        parentThreadId: "h-root",
        turns: [["assistant", "Delegate result"]],
      },
    ],
    injectedSkipped: 3,
    copiedHistorySkipped: 2,
  },
];

describe("session parsers on pinned fixtures", () => {
  for (const expected of cases) {
    test(expected.name, async () => {
      const result = await expected.parse();
      expect(result.complete).toBe(expected.complete);
      expect(result.threads.length).toBe(expected.threads.length);
      for (const [index, thread] of expected.threads.entries()) {
        const actual = result.threads[index]!;
        expect(actual.threadId).toBe(thread.threadId);
        expect(actual.kind).toBe(thread.kind);
        if (thread.sessionId) expect(actual.sessionId).toBe(thread.sessionId);
        if (thread.parentThreadId) {
          expect(actual.parentThreadId).toBe(thread.parentThreadId);
        }
        expect(actual.turns.map((turn) => turn.role)).toEqual(
          thread.turns.map(([role]) => role)
        );
        for (const [turnIndex, [, prefix]] of thread.turns.entries()) {
          expect(actual.turns[turnIndex]!.text.startsWith(prefix)).toBe(true);
          expect(actual.turns[turnIndex]!.timestamp).toMatch(/Z$/);
        }
      }
      expect(result.diagnostics.injectedSkipped).toBe(
        expected.injectedSkipped ?? 0
      );
      expect(result.diagnostics.copiedHistorySkipped).toBe(
        expected.copiedHistorySkipped ?? 0
      );
      expect(result.diagnostics.unknownKinds).toEqual(
        expected.unknownKinds ?? {}
      );
      expect(result.diagnostics.truncatedTail).toBe(
        expected.truncatedTail ?? false
      );
    });
  }
});

describe("structural detection", () => {
  const detections: Array<[string, () => string, SessionHarness | null]> = [
    [
      "codex rollout",
      () =>
        codex(
          "rollout-2026-09-20T10-00-00-0000c0de-0000-7000-8000-000000000001.jsonl"
        ),
      "codex",
    ],
    [
      "claude session",
      () => claude("-work-legacy/c1a0de00-0000-4000-8000-000000000002.jsonl"),
      "claude-code",
    ],
    [
      "openclaw jsonl",
      () =>
        join(
          FIXTURES,
          "openclaw/agents/main/sessions/0c1a0000-0000-4000-8000-000000000001.jsonl"
        ),
      "openclaw",
    ],
    ["openclaw sqlite", () => sqlite.openclawDb, "openclaw"],
    ["hermes sqlite", () => sqlite.hermesDb, "hermes"],
    ["unrelated file", () => join(FIXTURES, "README.md"), null],
  ];
  for (const [name, path, harness] of detections) {
    test(name, async () => {
      expect(await detectHarness(path())).toBe(harness);
    });
  }

  test("quoted rollout text inside another format does not fool detection", async () => {
    const path = join(tmp, "quoted.jsonl");
    await Bun.write(
      path,
      `${JSON.stringify({ note: '{"type":"session_meta","payload":{}}' })}\n`
    );
    expect(await detectHarness(path)).toBeNull();
  });
});

describe("SQLite snapshot reads", () => {
  test("zstd-framed OpenClaw events decode; mismatched length is a malformed record", async () => {
    const db = new Database(sqlite.openclawDb);
    const event = JSON.stringify({
      type: "message",
      id: "z1",
      timestamp: "2026-09-19T10:09:00.000Z",
      message: {
        role: "user",
        content: "Compressed omega note about the v2 API.",
      },
    });
    const bytes = new TextEncoder().encode(event);
    const insert = db.prepare(
      "INSERT INTO transcript_events (session_id, seq, event_json, created_at, event_zstd, event_utf8_bytes, navigation_json) VALUES (?, ?, NULL, 0, ?, ?, '{\"version\":1}')"
    );
    insert.run("w-main-2", 10, Bun.zstdCompressSync(bytes), bytes.byteLength);
    insert.run(
      "w-main-2",
      11,
      Bun.zstdCompressSync(bytes),
      bytes.byteLength + 1
    );
    db.close();
    const result = parseOpenClawDatabase(sqlite.openclawDb);
    const main = result.threads.find(
      (thread) => thread.threadId === "agent:main:main"
    )!;
    expect(main.turns.at(-1)?.text).toBe(
      "Compressed omega note about the v2 API."
    );
    expect(result.diagnostics.malformedRecords).toBe(1);
  });

  test("a WAL writer's committed rows are visible to the read-only snapshot", async () => {
    const path = join(tmp, "wal-hermes.db");
    const writer = new Database(path, { create: true });
    writer.exec("PRAGMA journal_mode = WAL");
    writer.exec(
      await Bun.file(join(FIXTURES, "sql/hermes-state-v0.19.sql")).text()
    );
    writer.run(
      "INSERT INTO messages (session_id, role, content, timestamp) VALUES ('h-root', 'user', 'WAL-only placeholder turn', 1789790070.0)"
    );
    try {
      const result = parseHermesDatabase(path);
      const root = result.threads.find(
        (thread) => thread.threadId === "h-root"
      )!;
      expect(root.turns.at(-1)?.text).toBe("WAL-only placeholder turn");
    } finally {
      writer.close();
    }
  });

  test("an unreadable database fails explicitly instead of returning empty", () => {
    const path = join(tmp, "not-a-db.sqlite");
    return Bun.write(path, "definitely not sqlite").then(() => {
      expect(() => parseHermesDatabase(path)).toThrow();
    });
  });
});
