import { describe, expect, test } from "bun:test";

import type { ParsedThread } from "../../src/sessions/types";

import { renderThread, threadRelPath } from "../../src/sessions/archive";

const thread = (overrides: Partial<ParsedThread> = {}): ParsedThread => ({
  harness: "codex",
  threadId: "thread-1",
  sessionId: "session-1",
  kind: "main",
  cwd: "/work/private-client/api",
  turns: [
    {
      turnId: "t1",
      role: "human",
      text: "We decided to keep the api on port 8080.",
      timestamp: "2026-09-20T10:00:00.000Z",
      locator: "line:3",
    },
    {
      turnId: "t2",
      role: "assistant",
      text: "Proposal: move the api to port 9090.",
      locator: "line:4",
    },
  ],
  ...overrides,
});

const lines = (content: string) =>
  content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("archive rendering", () => {
  test("labels authorship, keeps unknown times unknown and carries provenance", () => {
    const rendered = renderThread({
      thread: thread(),
      sourceId: "codex-main",
      unitKey: "unit-1",
      unitLocator: "rollout-x.jsonl",
      parser: "codex/1",
      redaction: {},
    });
    const [human, assistant] = lines(rendered.content);
    expect(human).toMatchObject({
      author: "human",
      recordedAt: "2026-09-20T10:00:00.000Z",
    });
    expect(assistant!.author).toBe("assistant");
    expect(assistant).not.toHaveProperty("recordedAt");
    expect(String(assistant!.body)).toStartWith("Assistant: Proposal");
    expect(String(assistant!.body)).toContain(
      "Provenance: Assistant (assistant output, not a user decision) · recorded unknown"
    );
    expect(String(human!.body)).toContain("locator rollout-x.jsonl#line:3");
    expect(String(human!.body)).toContain("turn t1");
    expect(String(human!.body)).not.toContain("recorded");
    expect(human!.sessionId).toBe("codex/codex-main/session-1");
    expect(human!.categories).toEqual(
      expect.arrayContaining([
        "harness/codex",
        "project/api",
        "role/human",
        "session",
      ])
    );
    expect(rendered.content).not.toContain("/work/private-client");
  });

  test("turn IDs are stable and thread files never merge across sources", () => {
    const render = (sourceId: string, turns = thread().turns) =>
      renderThread({
        thread: thread({ turns }),
        sourceId,
        unitKey: "unit-1",
        unitLocator: "u",
        parser: "codex/1",
        redaction: {},
      });
    const first = lines(render("a").content).map((line) => line.id);
    const appended = lines(
      render("a", [
        ...thread().turns,
        { turnId: "t3", role: "human", text: "Later note.", locator: "line:9" },
      ]).content
    ).map((line) => line.id);
    expect(appended.slice(0, 2)).toEqual(first);
    const path = (source: string, harness: "codex" | "hermes", unit: string) =>
      threadRelPath(source, harness, unit, "thread-1");
    expect(path("a", "codex", "u1")).not.toBe(path("b", "codex", "u1"));
    expect(path("a", "codex", "u1")).not.toBe(path("a", "hermes", "u1"));
    // Two units reporting the same thread ID never share an archive file.
    expect(path("a", "codex", "u1")).not.toBe(path("a", "codex", "u2"));
  });

  test("same-named projects stay distinguishable by project id", () => {
    const categories = (cwd: string) =>
      lines(
        renderThread({
          thread: thread({ cwd }),
          sourceId: "s",
          unitKey: "unit-1",
          unitLocator: "u",
          parser: "codex/1",
          redaction: {},
        }).content
      )[0]!.categories as string[];
    const left = categories("/work/a/api");
    const right = categories("/work/b/api");
    expect(left).toContain("project/api");
    expect(right).toContain("project/api");
    expect(left.find((tag) => tag.startsWith("project-id/"))).not.toBe(
      right.find((tag) => tag.startsWith("project-id/"))
    );
  });

  test("a secret revealed in a later turn is removed from every field", () => {
    const secret = ["synthetic", "pass123"].join("");
    const rendered = renderThread({
      thread: thread({
        cwd: `/work/${secret}`,
        threadId: `thread-${secret}`,
        turns: [
          {
            turnId: `t-${secret}`,
            role: "human",
            text: "first",
            locator: "line:1",
          },
          {
            turnId: "t2",
            role: "human",
            text: `password=${secret}`,
            locator: "line:2",
          },
        ],
      }),
      sourceId: "s",
      unitKey: "unit-1",
      unitLocator: `${secret}.jsonl`,
      parser: "codex/1",
      redaction: {},
    });
    expect(rendered.content).not.toContain(secret);
  });
});
