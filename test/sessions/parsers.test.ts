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

test("a codex fork without a history start ordinal archives nothing and reports drift", async () => {
  const source = await Bun.file(
    codex(
      "rollout-2026-09-21T11-00-00-0000c0de-0000-7000-8000-000000000003.jsonl"
    )
  ).text();
  const path = join(tmp, "fork-without-ordinal.jsonl");
  await Bun.write(
    path,
    source.replace('"subagent_history_start_ordinal":4', '"unrelated":4')
  );
  const result = await parseCodexRollout(path);
  expect(result.threads).toEqual([]);
  expect(result.complete).toBe(false);
  expect(result.diagnostics.unknownKinds).toEqual({
    fork_without_history_start: 1,
  });
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

  test("hermes keeps genuine repeats; only the contiguous copied block is skipped", async () => {
    const path = join(tmp, "hermes-repeats.db");
    const db = new Database(path, { create: true });
    db.exec(
      await Bun.file(join(FIXTURES, "sql/hermes-state-v0.19.sql")).text()
    );
    db.run(
      "INSERT INTO messages (session_id, role, content, timestamp) VALUES ('h-cont', 'user', 'Theta question: which placeholder region hosts the cache?', 1789785010.0), ('h-root', 'user', 'Eta decision: the placeholder backup runs at 02:00 UTC.', 1789790070.0)"
    );
    db.close();
    const result = parseHermesDatabase(path);
    const texts = (id: string) =>
      result.threads
        .find((thread) => thread.threadId === id)!
        .turns.map((turn) => turn.text);
    // A continuation repeating a parent question later is a new human turn.
    expect(texts("h-cont")).toEqual([
      "Theta decision: move the placeholder cache to region two.",
      "Theta question: which placeholder region hosts the cache?",
    ]);
    // A human repeating a compacted decision after compaction is kept.
    expect(texts("h-root").at(-1)).toBe(
      "Eta decision: the placeholder backup runs at 02:00 UTC."
    );
    expect(result.diagnostics.copiedHistorySkipped).toBe(2);
  });

  test("an assistant-only main thread does not hold a database unit incomplete", async () => {
    const path = join(tmp, "hermes-assistant-only.db");
    const db = new Database(path, { create: true });
    db.exec(
      await Bun.file(join(FIXTURES, "sql/hermes-state-v0.19.sql")).text()
    );
    db.run(
      "INSERT INTO sessions VALUES ('h-cron', 'cron', '{}', NULL, 1789795000.0, NULL, NULL, '/work/eta', 'Placeholder cron')"
    );
    db.run(
      "INSERT INTO messages (session_id, role, content, timestamp) VALUES ('h-cron', 'assistant', 'Scheduled placeholder report.', 1789795001.0)"
    );
    db.close();
    const result = parseHermesDatabase(path);
    expect(result.complete).toBe(true);
    expect(result.diagnostics.threadsWithoutHuman).toBe(1);
  });

  test("an unreadable database fails explicitly instead of returning empty", () => {
    const path = join(tmp, "not-a-db.sqlite");
    return Bun.write(path, "definitely not sqlite").then(() => {
      expect(() => parseHermesDatabase(path)).toThrow();
    });
  });
});

describe("OpenClaw legacy JSONL lineage", () => {
  const PARENT = "0c1a0000-0000-4000-8000-00000000aa01";
  const CHILD = "0c1a0000-0000-4000-8000-00000000aa02";
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  const header = (id: string, parentSession?: string) =>
    line({
      type: "session",
      version: 4,
      id,
      timestamp: "2026-09-19T09:00:00.000Z",
      cwd: "/work/lineage",
      ...(parentSession ? { parentSession } : {}),
    });
  const message = (id: string, role: string, text: string) =>
    line({
      type: "message",
      id,
      timestamp: "2026-09-19T09:00:01.000Z",
      message: { role, content: [{ type: "text", text }] },
    });

  /** Parent transcript plus a child that copies its entries by id. */
  async function writeLineage(
    name: string,
    index?: Record<string, unknown>,
    options: { parentFile?: boolean } = {}
  ): Promise<string> {
    const dir = join(tmp, "openclaw-lineage", name);
    if (options.parentFile !== false) {
      await Bun.write(
        join(dir, `${PARENT}.jsonl`),
        header(PARENT) +
          message("p1", "user", "Parent human question") +
          message("p2", "assistant", "Parent answer")
      );
    }
    const child = join(dir, `${CHILD}.jsonl`);
    await Bun.write(
      child,
      header(CHILD, PARENT) +
        message("p1", "user", "Parent human question") +
        message("p2", "assistant", "Parent answer") +
        message("c1", "user", "Child first prompt") +
        message("c2", "assistant", "Child answer")
    );
    if (index)
      await Bun.write(join(dir, "sessions.json"), JSON.stringify(index));
    return child;
  }

  test("a spawned subagent's task prompt is never human; copied history skipped", async () => {
    const child = await writeLineage("subagent", {
      "agent:main:main": { sessionId: PARENT },
      "agent:main:subagent:s1": {
        sessionId: CHILD,
        spawnedBy: "agent:main:main",
      },
    });
    const result = await parseOpenClawJsonl(child);
    expect(result.complete).toBe(true);
    const [thread] = result.threads;
    expect(thread?.kind).toBe("subagent");
    expect(thread?.parentThreadId).toBe("agent:main:main");
    expect(thread?.turns.map((turn) => [turn.role, turn.text])).toEqual([
      ["assistant", "Child answer"],
    ]);
    expect(result.diagnostics.copiedHistorySkipped).toBe(2);
    expect(result.diagnostics.injectedSkipped).toBe(1);
  });

  test("a :subagent: session key marks a subagent without spawnedBy", async () => {
    const child = await writeLineage("subagent-key", {
      "agent:main:subagent:s2": { sessionId: CHILD },
    });
    const result = await parseOpenClawJsonl(child);
    expect(result.threads[0]?.kind).toBe("subagent");
    expect(result.threads[0]?.turns.some((turn) => turn.role === "human")).toBe(
      false
    );
  });

  test("a classified fork keeps its own prompt as human and skips copied history", async () => {
    const child = await writeLineage("fork", {
      "agent:main:main": { sessionId: PARENT },
      "agent:main:fork1": { sessionId: CHILD },
    });
    const result = await parseOpenClawJsonl(child);
    expect(result.complete).toBe(true);
    const [thread] = result.threads;
    expect(thread?.kind).toBe("fork");
    expect(thread?.parentThreadId).toBe(PARENT);
    expect(thread?.turns.map((turn) => [turn.role, turn.text])).toEqual([
      ["human", "Child first prompt"],
      ["assistant", "Child answer"],
    ]);
    expect(result.diagnostics.copiedHistorySkipped).toBe(2);
  });

  test("an unclassified child fails safe: first prompt not human, unit incomplete as drift", async () => {
    const child = await writeLineage("unclassified");
    const result = await parseOpenClawJsonl(child);
    expect(result.complete).toBe(false);
    expect(result.diagnostics.unknownKinds.child_session_unclassified).toBe(1);
    expect(result.threads[0]?.turns.some((turn) => turn.role === "human")).toBe(
      false
    );
  });

  test("a child whose parent transcript is unavailable archives nothing", async () => {
    const child = await writeLineage(
      "orphan",
      { "agent:main:fork2": { sessionId: CHILD } },
      { parentFile: false }
    );
    const result = await parseOpenClawJsonl(child);
    expect(result.complete).toBe(false);
    expect(result.threads).toEqual([]);
    expect(result.diagnostics.unknownKinds.child_parent_unavailable).toBe(1);
  });
});

describe("database thread cap", () => {
  const OVER_CAP = 50_001;

  test("hermes: more sessions than the cap keeps the unit incomplete", () => {
    const path = join(tmp, "hermes-cap.db");
    const db = new Database(path, { create: true });
    db.exec(
      "CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT);"
    );
    db.exec(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${OVER_CAP}) INSERT INTO sessions SELECT printf('s%06d', i) FROM n`
    );
    db.close();
    const result = parseHermesDatabase(path);
    expect(result.threads.length).toBe(50_000);
    expect(result.complete).toBe(false);
    expect(result.diagnostics.threadsOverLimit).toBe(1);
  });

  test("openclaw: more session keys than the cap keeps the unit incomplete", () => {
    const path = join(tmp, "openclaw-cap.sqlite");
    const db = new Database(path, { create: true });
    db.exec(
      "CREATE TABLE session_windows (session_id TEXT, session_key TEXT); CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT);"
    );
    db.exec(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${OVER_CAP}) INSERT INTO session_windows SELECT printf('w%06d', i), printf('agent:main:k%06d', i) FROM n`
    );
    db.close();
    const result = parseOpenClawDatabase(path);
    expect(result.threads.length).toBe(50_000);
    expect(result.complete).toBe(false);
    expect(result.diagnostics.threadsOverLimit).toBe(1);
  });
});
