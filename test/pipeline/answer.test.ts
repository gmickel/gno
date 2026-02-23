import { describe, expect, test } from "bun:test";

import type { GenerationPort } from "../../src/llm/types";
import type { SearchResult } from "../../src/pipeline/types";

import {
  ABSTENTION_MESSAGE,
  generateGroundedAnswer,
  processAnswerResult,
} from "../../src/pipeline/answer";

function makeResult(
  docid: string,
  score: number,
  snippet: string,
  title?: string
): SearchResult {
  return {
    docid,
    score,
    uri: `gno://notes/${docid.slice(1)}.md`,
    title,
    snippet,
    snippetRange: { startLine: 1, endLine: 5 },
    source: {
      relPath: `${docid.slice(1)}.md`,
      mime: "text/markdown",
      ext: ".md",
    },
  };
}

function makeGenPort(
  response: string,
  onPrompt?: (prompt: string) => void
): GenerationPort {
  return {
    modelUri: "mock://gen",
    generate: async (prompt: string) => {
      onPrompt?.(prompt);
      return { ok: true as const, value: response };
    },
    dispose: async () => {
      // no-op
    },
  };
}

describe("answer source selection", () => {
  test("selects multi-facet sources and includes explain payload", async () => {
    let prompt = "";
    const genPort = makeGenPort(
      "Token rotation [1]. Sessions in Redis [2].",
      (p) => {
        prompt = p;
      }
    );

    const results: SearchResult[] = [
      makeResult(
        "#a1b2c3d4",
        0.95,
        "Refresh tokens rotate on each use.",
        "Auth"
      ),
      makeResult(
        "#b1c2d3e4",
        0.9,
        "Session state is stored in Redis.",
        "Storage"
      ),
      makeResult("#c1d2e3f4", 0.78, "Audit logs are written daily.", "Ops"),
      makeResult(
        "#d1e2f3a4",
        0.7,
        "Monitoring dashboards track latency.",
        "Monitoring"
      ),
    ];

    const raw = await generateGroundedAnswer(
      { genPort, store: null },
      "How does token rotation work and where are sessions stored?",
      results,
      256
    );

    expect(raw).not.toBeNull();
    if (!raw) {
      return;
    }

    expect(raw.answerContext.strategy).toBe("adaptive_coverage_v1");
    expect(raw.answerContext.targetSources).toBe(4);
    expect(raw.answerContext.selected.length).toBeGreaterThanOrEqual(2);
    const selectedDocids = raw.answerContext.selected.map(
      (entry) => entry.docid
    );
    expect(selectedDocids).toContain("#a1b2c3d4");
    expect(selectedDocids).toContain("#b1c2d3e4");
    expect(raw.answerContext.dropped.length).toBe(0);

    const lastContextStart = prompt.lastIndexOf("Context:\n");
    const lastAnswerStart = prompt.lastIndexOf("\n\nAnswer:");
    const activeContext = prompt.slice(
      lastContextStart + "Context:\n".length,
      lastAnswerStart
    );
    const contextBlocks = [...activeContext.matchAll(/^\[(\d+)\]\s/gm)].length;
    expect(contextBlocks).toBe(raw.answerContext.selected.length);
    expect(raw.citations).toHaveLength(raw.answerContext.selected.length);
  });

  test("comparison query keeps at least two competing sources", async () => {
    const genPort = makeGenPort("Redis is fast [1], SQLite is simpler [2].");

    const results: SearchResult[] = [
      makeResult("#aa11bb22", 0.96, "Redis-backed sessions with TTL."),
      makeResult(
        "#cc33dd44",
        0.91,
        "Redis cluster tuning for high throughput."
      ),
      makeResult("#ee55ff66", 0.58, "SQLite file-based session persistence."),
    ];

    const raw = await generateGroundedAnswer(
      { genPort, store: null },
      "Compare Redis vs SQLite for session storage.",
      results,
      256
    );

    expect(raw).not.toBeNull();
    if (!raw) {
      return;
    }

    const selectedDocids = raw.answerContext.selected.map(
      (entry) => entry.docid
    );
    expect(selectedDocids.length).toBeGreaterThanOrEqual(2);
    expect(selectedDocids).toContain("#aa11bb22");
    expect(selectedDocids).toContain("#ee55ff66");
  });
});

describe("answer citation hygiene", () => {
  test("renumbers citations and preserves answer context explain", () => {
    const processed = processAnswerResult({
      answer: "Decision is in [3], with rationale in [1].",
      citations: [
        { docid: "#1111aaaa", uri: "gno://notes/a.md" },
        { docid: "#2222bbbb", uri: "gno://notes/b.md" },
        { docid: "#3333cccc", uri: "gno://notes/c.md" },
      ],
      answerContext: {
        strategy: "adaptive_coverage_v1",
        targetSources: 3,
        facets: ["decision", "rationale"],
        selected: [
          {
            docid: "#1111aaaa",
            uri: "gno://notes/a.md",
            score: 0.9,
            queryTokenHits: 2,
            facetHits: 1,
            reason: "new_facet_coverage",
          },
        ],
        dropped: [],
      },
    });

    expect(processed.answer).toBe("Decision is in [2], with rationale in [1].");
    expect(processed.citations).toHaveLength(2);
    expect(processed.citations[0]?.docid).toBe("#1111aaaa");
    expect(processed.citations[1]?.docid).toBe("#3333cccc");
    expect(processed.answerContext.strategy).toBe("adaptive_coverage_v1");
  });

  test("returns abstention on uncited answer while keeping explain payload", () => {
    const processed = processAnswerResult({
      answer: "I think this might be true.",
      citations: [{ docid: "#1111aaaa", uri: "gno://notes/a.md" }],
      answerContext: {
        strategy: "adaptive_coverage_v1",
        targetSources: 1,
        facets: ["query"],
        selected: [
          {
            docid: "#1111aaaa",
            uri: "gno://notes/a.md",
            score: 0.9,
            queryTokenHits: 1,
            facetHits: 1,
            reason: "relevance",
          },
        ],
        dropped: [],
      },
    });

    expect(processed.answer).toBe(ABSTENTION_MESSAGE);
    expect(processed.citations).toEqual([]);
    expect(processed.answerContext.selected).toHaveLength(1);
  });
});
