import { describe, expect, test } from "bun:test";

import {
  hashMemoryText,
  memoryJaccard,
  memoryScopesIntersect,
  normalizeMemoryScopes,
  serializeMemoryRecord,
  validateMemoryRecord,
} from "../../src/core/memory-record";

const VALID_FRONTMATTER = {
  recordId: "mem-0123456789abcdef",
  scopes: ["project:gno", "team"],
  caller: "codex",
  session: "s-1",
  createdAt: "2026-09-03T10:00:00.000Z",
  contentHash: hashMemoryText("Finn prefers the blue cup."),
};

function record(overrides: Record<string, string> = {}): string {
  const base = serializeMemoryRecord({
    frontmatter: VALID_FRONTMATTER,
    supersedes: [],
    text: "Finn prefers the blue cup.",
  });
  let content = base;
  for (const [needle, replacement] of Object.entries(overrides)) {
    content = content.replace(needle, replacement);
  }
  return content;
}

describe("memory scope normalization", () => {
  test.each([
    [["  Project:GNO ", "project:gno"], ["project:gno"]],
    [["Café", "café"], ["café"]],
    [["", "   ", "a"], ["a"]],
    [
      ["b", "a", "B"],
      ["b", "a"],
    ],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeMemoryScopes(input)).toEqual(expected);
  });

  test("any-intersection matching on multi-scope facts", () => {
    expect(memoryScopesIntersect(["a", "b"], ["B"])).toBe(true);
    expect(memoryScopesIntersect(["a", "b"], ["c", "d"])).toBe(false);
    expect(memoryScopesIntersect([], ["a"])).toBe(false);
  });
});

describe("memory record validator", () => {
  test("serialized records round-trip through the validator", () => {
    const validation = validateMemoryRecord(record());
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    expect(validation.record.frontmatter).toEqual(VALID_FRONTMATTER);
    expect(validation.record.text).toBe("Finn prefers the blue cup.");
    expect(validation.record.supersedes).toEqual([]);
  });

  test("supersedes relations are parsed as gno:// URIs", () => {
    const content = serializeMemoryRecord({
      frontmatter: VALID_FRONTMATTER,
      supersedes: ["gno://memory/facts/2026-09-01/mem-aaaaaaaaaaaaaaaa.md"],
      text: "Finn prefers the blue cup.",
    });
    const validation = validateMemoryRecord(content);
    expect(validation.ok && validation.record.supersedes).toEqual([
      "gno://memory/facts/2026-09-01/mem-aaaaaaaaaaaaaaaa.md",
    ]);
  });

  test.each([
    ["no frontmatter", "Just a fact.\n", ["MEMORY_FRONTMATTER_MISSING"]],
    [
      "no memory block",
      "---\ntitle: x\n---\nJust a fact.\n",
      ["MEMORY_FRONTMATTER_MISSING"],
    ],
    [
      "bad record id",
      record({ 'recordId: "mem-0123456789abcdef"': 'recordId: "nope"' }),
      ["MEMORY_RECORD_ID_INVALID"],
    ],
    [
      "scopes not a list",
      record({ 'scopes: ["project:gno", "team"]': "scopes: team" }),
      ["MEMORY_SCOPES_INVALID"],
    ],
    [
      "scopes empty",
      record({ 'scopes: ["project:gno", "team"]': "scopes: []" }),
      ["MEMORY_SCOPES_EMPTY"],
    ],
    [
      "identity missing",
      record({ 'caller: "codex"': 'caller: ""' }),
      ["MEMORY_IDENTITY_MISSING"],
    ],
    [
      "createdAt invalid",
      record({ 'createdAt: "2026-09-03T10:00:00.000Z"': 'createdAt: "soon"' }),
      ["MEMORY_CREATED_AT_INVALID"],
    ],
    [
      "hash mismatch",
      record({ "Finn prefers the blue cup.\n": "Finn prefers the red cup.\n" }),
      ["MEMORY_CONTENT_HASH_MISMATCH"],
    ],
    [
      "body empty",
      record({ "\nFinn prefers the blue cup.\n": "\n" }),
      ["MEMORY_BODY_EMPTY"],
    ],
    [
      "supersedes not a URI",
      record({
        "---\n\nFinn": "relations:\n  supersedes:\n    - nope\n---\n\nFinn",
      }),
      ["MEMORY_SUPERSEDES_INVALID"],
    ],
  ])("reports %s", (_label, content, codes) => {
    const validation = validateMemoryRecord(content);
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.diagnostics.map((item) => String(item.code))).toEqual(
      codes
    );
  });
});

describe("lexical likely-match", () => {
  test("Jaccard is symmetric, normalized, and corpus-independent", () => {
    const left = "Finn prefers the blue cup";
    const right = "the blue cup Finn prefers";
    expect(memoryJaccard(left, right)).toBe(1);
    expect(memoryJaccard(left, "Ivan likes trains")).toBe(0);
    expect(memoryJaccard(left, "Finn prefers the blue mug")).toBeCloseTo(4 / 6);
  });
});
