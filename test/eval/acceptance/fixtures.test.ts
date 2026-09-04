import { expect, test } from "bun:test";

import {
  exhaustiveEligibleOracle,
  generateAcceptanceFixtures,
  setupAcceptanceFixturePair,
  verifyAcceptanceFixturePins,
} from "../../../evals/acceptance/fixtures";
import { mustNativeStore } from "../../../evals/agentic/native-fixture-store";
import { formatDocForEmbedding } from "../../../src/pipeline/contextual";

const memoryManifest = new URL(
  "../../../evals/fixtures/memory/manifest.json",
  import.meta.url
);

test("synthetic corpus, queries, and exhaustive oracle repeat with immutable hashes", () => {
  const fixtures = generateAcceptanceFixtures();
  expect(generateAcceptanceFixtures().hashes).toEqual(fixtures.hashes);
  expect(() => verifyAcceptanceFixturePins(fixtures)).not.toThrow();
  fixtures.hashes.corpusSha256 = "0".repeat(64);
  expect(() => verifyAcceptanceFixturePins(fixtures)).toThrow("hash drift");
  const eligible = fixtures.oracle.find(
    (row) => row.caseId === "eligible-top-k"
  )!;
  expect(
    eligible.eligible.map((row) => [row.uri, row.seq, row.language])
  ).toEqual([["gno://eligible/200.md", 0, "en"]]);
  expect(
    fixtures.oracle.find((row) => row.caseId === "hydration-1000")!.eligible
  ).toHaveLength(1000);
  for (const language of ["en", "de", "zh"]) {
    const row = fixtures.oracle.find(
      (item) => item.caseId === `rerank-${language}-16000-end`
    )!;
    expect(row.eligible).toHaveLength(2);
    expect(
      row.eligible.every(
        (item) => item.language === language && item.text.length === 16000
      )
    ).toBe(true);
  }
  const query = fixtures.cases.find((row) => row.caseId === "title-variants")!;
  const modified = structuredClone(fixtures.documents);
  modified.find((doc) => doc.collection === "titles")!.active = false;
  expect(exhaustiveEligibleOracle(modified, query)).toHaveLength(1);
  expect(
    exhaustiveEligibleOracle(modified, { ...query, language: "de" })
  ).toHaveLength(0);
});

test.each(["forward", "reverse"] as const)(
  "%s indexes preserve ownership, title inputs, independent state, and real environment",
  async (order) => {
    const beforeEnv = { ...process.env };
    const beforeMemory = await Bun.file(memoryManifest).text();
    const pair = await setupAcceptanceFixturePair({ order });
    const generatedBefore = generateAcceptanceFixtures().hashes;
    try {
      expect(pair.baseline.dbPath).not.toBe(pair.candidate.dbPath);
      expect(pair.baseline.corpusSha256).toBe(pair.candidate.corpusSha256);
      const snapshots = [];
      for (const index of [pair.baseline, pair.candidate]) {
        const documents = mustNativeStore(
          await index.adapter.listDocuments(),
          "list fixture documents"
        );
        snapshots.push(
          documents
            .map((doc) => [doc.collection, doc.relPath, doc.sourceHash])
            .sort((left, right) =>
              JSON.stringify(left).localeCompare(JSON.stringify(right))
            )
        );
        expect(documents).toHaveLength(pair.fixtures.documents.length);
        const titles = documents
          .filter((doc) => doc.collection === "titles")
          .sort((a, b) => a.relPath.localeCompare(b.relPath));
        expect(titles.map((doc) => doc.title)).toEqual(["Alpha", "Beta"]);
        expect(titles[0]!.mirrorHash).toBe(titles[1]!.mirrorHash);
        const inputs = [];
        for (const doc of titles) {
          const chunks = mustNativeStore(
            await index.adapter.getChunks(doc.mirrorHash!),
            "get fixture chunks"
          );
          inputs.push(
            formatDocForEmbedding(
              chunks[0]!.text,
              doc.title ?? undefined,
              "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/test.gguf"
            )
          );
          expect(
            await Bun.file(
              `${index.root}/corpus/${doc.collection}/${doc.relPath}`
            ).text()
          ).toBe("sentinel unchanged body");
        }
        expect(inputs[0]).not.toBe(inputs[1]);
        expect(inputs[0]).toContain("Alpha");
        expect(inputs[1]).toContain("Beta");
        const hydration = documents.find(
          (doc) => doc.collection === "hydration"
        )!;
        expect(
          mustNativeStore(
            await index.adapter.getChunks(hydration.mirrorHash!),
            "hydration chunks"
          )
        ).toHaveLength(1000);
        expect(
          Object.values(index.env).every((path) =>
            path.startsWith(`${index.root}/`)
          )
        ).toBe(true);
      }
      expect(snapshots[0]).toEqual(snapshots[1]);
      mustNativeStore(
        await pair.candidate.adapter.markInactive("titles", ["Alpha.md"]),
        "negative result-loss control"
      );
      expect(
        mustNativeStore(
          await pair.baseline.adapter.getDocument("titles", "Alpha.md"),
          "baseline title"
        )!.active
      ).toBe(true);
      expect(
        mustNativeStore(
          await pair.candidate.adapter.getDocument("titles", "Alpha.md"),
          "candidate title"
        )!.active
      ).toBe(false);
      expect(generateAcceptanceFixtures().hashes).toEqual(generatedBefore);
      expect(await Bun.file(memoryManifest).text()).toBe(beforeMemory);
      expect(process.env).toEqual(beforeEnv);
    } finally {
      await pair.dispose();
    }
    expect(await Bun.file(pair.baseline.dbPath).exists()).toBe(false);
  }
);
