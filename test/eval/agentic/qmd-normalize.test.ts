import { describe, expect, test } from "bun:test";

import type { AgentTask, CorpusSnapshot } from "../../../evals/agentic/types";

import {
  mapQmdToolCall,
  normalizeQmdToolResult,
  type QmdEvidenceScope,
} from "../../../evals/agentic/adapters/qmd-normalize";
import { sha256Bytes } from "../../../evals/agentic/canonical";

const task: AgentTask = {
  schemaVersion: "1.0",
  taskId: "t0a1b2c3",
  category: "exact_identifier",
  brief: { goal: "Find alpha", instructions: [] },
  claims: [],
  allowedTools: ["search", "get", "multi_get"],
  budgets: { maxAgentCalls: 3, maxModelVisibleBytes: 10_000 },
  corpus: { collections: ["c001"] },
};

const snapshot: CorpusSnapshot = {
  fixtureVersion: "fixture",
  fingerprint: sha256Bytes("qmd-normalize-fixture"),
  files: [
    {
      taskId: task.taskId,
      collection: "c001",
      relPath: "d001.md",
      sourcePath: "fixture/c001/d001.md",
      sourceHash: sha256Bytes("# Heading\nAlpha\nBeta\n"),
      content: "# Heading\nAlpha\nBeta\n",
    },
    {
      taskId: "t1b2c3d4",
      collection: "c002",
      relPath: "foreign.md",
      sourcePath: "fixture/c002/foreign.md",
      sourceHash: sha256Bytes("# Foreign\nSecret\n"),
      content: "# Foreign\nSecret\n",
    },
  ],
};

const expectScopeViolation = (action: () => unknown): void => {
  expect(action).toThrow("outside the active task");
};

describe("qmd normalized contract", () => {
  test("forces unscoped search into active collections and rejects cross-task reads", () => {
    expect(
      mapQmdToolCall("search", { query: "alpha" }, snapshot, task)
    ).toEqual({
      name: "query",
      arguments: { query: "alpha", rerank: true, collections: ["c001"] },
    });
    expectScopeViolation(() =>
      mapQmdToolCall(
        "search",
        { query: "secret", collection: "c002" },
        snapshot,
        task
      )
    );
    expectScopeViolation(() =>
      mapQmdToolCall("get", { uri: "gno://c002/foreign.md" }, snapshot, task)
    );
    expectScopeViolation(() =>
      mapQmdToolCall(
        "multi_get",
        { uris: ["gno://c001/d001.md", "gno://c002/foreign.md"] },
        snapshot,
        task
      )
    );
  });

  test("uses inner range headers and omits partial or ellipsized lines", () => {
    const diagnostics: string[] = [];
    const scope: QmdEvidenceScope = { snapshot, task, diagnostics };
    const result = normalizeQmdToolResult(
      "search",
      {
        content: [{ type: "text", text: "Found 1" }],
        structuredContent: {
          results: [
            {
              file: "qmd://c001/d001.md",
              line: 2,
              snippet:
                "99: @@ -2,2 @@ (1 before, 0 after)\n100: Alpha\n101: Be...",
            },
          ],
        },
      },
      scope,
      (value) => value
    );
    expect(
      result.evidence.map(({ startLine, text, sourceHash }) => ({
        startLine,
        text,
        sourceHash,
      }))
    ).toEqual([
      {
        startLine: 2,
        text: "Alpha",
        sourceHash: snapshot.files[0]?.sourceHash ?? "missing",
      },
    ]);
    expect(diagnostics).toContain(
      "qmd evidence omitted: returned line is partial, ellipsized, or differs from snapshot"
    );
  });

  test("rejects foreign returned content before raw text reaches the agent", () => {
    const scope: QmdEvidenceScope = { snapshot, task, diagnostics: [] };
    expect(() =>
      normalizeQmdToolResult(
        "search",
        {
          content: [{ type: "text", text: "Secret raw foreign result" }],
          structuredContent: {
            results: [
              {
                file: "qmd://c002/foreign.md",
                line: 2,
                snippet: "2: @@ -2,1 @@ (1 before, 0 after)\n3: Secret",
              },
            ],
          },
        },
        scope,
        (value) => value
      )
    ).toThrow("outside the active task snapshot");
  });

  test("classifies missing or non-array content as malformed harness output", () => {
    const scope: QmdEvidenceScope = { snapshot, task, diagnostics: [] };
    for (const raw of [{}, { content: "not-an-array" }]) {
      expect(() =>
        normalizeQmdToolResult("get", raw as never, scope, (value) => value)
      ).toThrow("malformed result envelope");
    }
  });

  test("scope-checks foreign results and resources even in error envelopes", () => {
    const scope: QmdEvidenceScope = { snapshot, task, diagnostics: [] };
    expectScopeViolation(() =>
      normalizeQmdToolResult(
        "search",
        {
          isError: true,
          content: [{ type: "text", text: "foreign search error" }],
          structuredContent: {
            results: [
              {
                file: "qmd://c002/foreign.md",
                line: 2,
                snippet: "2: @@ -2,1 @@\n3: Secret",
              },
            ],
          },
        },
        scope,
        (value) => value
      )
    );
    expectScopeViolation(() =>
      normalizeQmdToolResult(
        "get",
        {
          isError: true,
          content: [
            {
              type: "resource",
              resource: {
                uri: "qmd://c002/foreign.md",
                text: "2: Secret",
              },
            },
          ],
        },
        scope,
        (value) => value
      )
    );
  });
});
