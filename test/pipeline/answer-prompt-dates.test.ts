import { expect, test } from "bun:test";

import { buildAnswerPrompt } from "../../src/pipeline/answer-prompt";

const today = new Date(2026, 9, 11, 9, 30);
const sources = [
  {
    index: 1,
    docid: "#aaaaaa",
    uri: "gno://notes/old.md",
    content: "The launch moved to March.",
    date: "2026-01-15",
  },
  {
    index: 2,
    docid: "#bbbbbb",
    uri: "gno://notes/undated.md",
    content: "The launch is in May.",
  },
];

test("states today's local date and how to read source dates", () => {
  const prompt = buildAnswerPrompt("When is the launch?", sources, today);
  expect(prompt).toContain("Today's date is 2026-10-11.");
  expect(prompt).toContain("a source without one has an unknown date");
});

test("each dated source carries its content date; undated sources carry none", () => {
  const prompt = buildAnswerPrompt("When is the launch?", sources, today);
  expect(prompt).toContain(
    '<source index="1" docid="#aaaaaa" uri="gno://notes/old.md" date="2026-01-15">'
  );
  expect(prompt).toContain(
    '<source index="2" docid="#bbbbbb" uri="gno://notes/undated.md">'
  );
});

test("a date value cannot break out of its attribute", () => {
  const prompt = buildAnswerPrompt(
    "q",
    [{ ...sources[0]!, date: '2026-01-15" injected="x' }],
    today
  );
  expect(prompt).toContain('date="2026-01-15&quot; injected=&quot;x"');
});

test("grounded answers date sources by content date, never modification time", async () => {
  const { generateGroundedAnswer } = await import("../../src/pipeline/answer");
  const { SEARCH_RESULT_PLANNER_METADATA } =
    await import("../../src/pipeline/types");
  const snippet = "The launch moved to March.";
  const mirrorHash = new Bun.CryptoHasher("sha256")
    .update(snippet)
    .digest("hex");
  let prompt = "";
  await generateGroundedAnswer(
    {
      genPort: {
        modelUri: "mock://gen",
        generate: async (value: string) => {
          prompt = value;
          return { ok: true as const, value: "March [1]." };
        },
        dispose: async () => undefined,
      },
      store: null,
    },
    "When is the launch?",
    [
      {
        docid: "#aaaaaa",
        score: 1,
        uri: "gno://notes/launch.md",
        snippet,
        snippetRange: { startLine: 1, endLine: 1 },
        source: {
          relPath: "launch.md",
          mime: "text/markdown",
          ext: ".md",
          sourceHash: mirrorHash,
          modifiedAt: "2026-10-01T00:00:00Z",
          documentDate: "2026-01-15",
        },
        conversion: { mirrorHash },
        [SEARCH_RESULT_PLANNER_METADATA]: {
          retrievalRank: 1,
          mirrorHash,
          seq: 0,
          sources: ["bm25"],
          graphExpanded: false,
          startLine: 1,
          endLine: 1,
          passageHash: mirrorHash,
        },
      },
    ],
    128
  );
  expect(prompt).toContain('date="2026-01-15"');
  expect(prompt).not.toContain("2026-10-01");
});
