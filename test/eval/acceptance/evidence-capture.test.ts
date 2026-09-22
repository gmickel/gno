import { expect, test } from "bun:test";

import type { SearchResults } from "../../../src/pipeline/types";

import { emptyCapture } from "../../../evals/acceptance/capture-contract";
import {
  capturedStages,
  observedText,
  observedFragments,
  parseEvidenceReader,
  prepareEvidenceReader,
} from "../../../evals/acceptance/evidence-capture";
import { loadEvidenceFixtures } from "../../../evals/acceptance/evidence-fixtures";

const { fixtures } = await loadEvidenceFixtures();
const doc = fixtures.documents[0]!;

test("output-only index metadata does not hide delivered evidence", () => {
  const observed = observedText(
    fixtures,
    doc.content,
    "reader",
    `${doc.uri}?index=evidence-current`
  );
  expect(observed?.uri).toBe(doc.uri);
  expect(observed?.text).toBe(doc.content);
  expect(observed?.start).toBe(0);
  expect(
    observedText(fixtures, "not actually observed", "reader", doc.uri)
  ).toBeNull();
});

test("repeated ambiguous text is never assigned a guessed source coordinate", () => {
  const repeated = { ...doc, content: "repeat repeat" };
  expect(
    observedText({ ...fixtures, documents: [repeated] }, "repeat", "x")
  ).toBeNull();
  expect(
    observedText(
      { ...fixtures, documents: [doc, { ...doc, uri: "gno://notes/copy.md" }] },
      doc.content,
      "x"
    )
  ).toBeNull();
});

test("budget accounts for actual fixed-reader framing and snippets, without supplying gold answers", () => {
  const item = { ...fixtures.cases[0]!, tokenBudget: 500 };
  const raw = {
    results: [
      {
        docid: "#fixture",
        score: 1,
        uri: `${doc.uri}?index=evidence-current`,
        snippet: doc.content,
        source: {
          relPath: "operations.md",
          mime: "text/markdown",
          ext: ".md",
          sourceHash: doc.sourceHash,
        },
      },
    ],
    meta: { query: "fixture", mode: "hybrid", totalResults: 0 },
  } as SearchResults;
  const prepared = prepareEvidenceReader(fixtures, item, raw);
  expect(prepared.passages.length).toBeGreaterThan(0);
  expect(Buffer.byteLength(prepared.prompt)).toBeLessThanOrEqual(500);
  expect(prepared.prompt).toContain(item.query);
  for (const passage of prepared.passages) {
    expect(prepared.prompt).toContain(passage.text);
    expect(doc.content.slice(passage.start, passage.end)).toBe(passage.text);
  }
  expect(() =>
    prepareEvidenceReader(fixtures, { ...item, tokenBudget: 1 }, raw)
  ).toThrow("framing");
});

test("reader rejects extra claims and preserves abstention independently of prose", () => {
  const item = fixtures.cases[0]!;
  expect(parseEvidenceReader('{"values":["750"]}', item).verified).toBe(true);
  expect(parseEvidenceReader('{"values":["750","900"]}', item).verified).toBe(
    false
  );
  expect(() =>
    parseEvidenceReader('{"values":["750"],"extra":true}', item)
  ).toThrow();
});

test("native reranker capture uses actual texts and distinct candidate-input identities", () => {
  const capture = emptyCapture("test");
  capture.modelInputs = [
    {
      role: "reranking",
      modelId: "fixture",
      input: ["query", [doc.content, doc.content]],
    },
  ];
  const raw = {
    results: [],
    meta: { query: "fixture", mode: "hybrid", totalResults: 0 },
  } as SearchResults;
  const stages = capturedStages(fixtures, raw, capture, new Map(), new Map());
  expect(stages.retrieval).toBeNull();
  expect(stages.rerank_input).toHaveLength(2);
  expect(new Set(stages.rerank_input!.map((p) => p.inputId)).size).toBe(2);
  capture.modelInputs[0]!.input = ["query", ["missing text"]];
  expect(
    capturedStages(fixtures, raw, capture, new Map(), new Map()).rerank_input
  ).toBeNull();
});

test("converter whitespace does not erase exact observed fact lines", () => {
  const source = fixtures.documents.find((d) =>
    d.uri.endsWith("/reference.md")
  )!;
  const mirror = source.content
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
  expect(observedText(fixtures, mirror, "reader", source.uri)).toBeNull();
  const fragments = observedFragments(fixtures, mirror, "reader", source.uri);
  const fact = fragments.find((p) => p.text.includes("4832"))!;
  expect(fact).toBeDefined();
  expect(fact.text).toBe(source.content.slice(fact.start, fact.end));
});
