import { expect, test } from "bun:test";
import { bundledLanguages } from "shiki";

import { BUNDLED_LANGUAGE_IDS } from "../../src/serve/public/lib/shiki-language-ids";
import { loadEmbeddedProductionSpa } from "../../src/serve/spa-production";
import { computeSpaSourceHash } from "../../src/serve/spa-production-build";

test("committed snapshot matches current src/serve/public sources", async () => {
  const expected = await computeSpaSourceHash();
  const actual = (await loadEmbeddedProductionSpa()).sourceHash;
  if (actual !== expected) {
    throw new Error(
      `Committed SPA snapshot is stale (sourceHash ${actual} !== ${expected}). Run bun run build:spa.`
    );
  }
});

test("shiki id table matches installed shiki", () => {
  const shikiIds = Object.keys(bundledLanguages).sort();
  const tableIds = [...BUNDLED_LANGUAGE_IDS].sort();
  const shikiSet = new Set(shikiIds);
  const missingFromTable = shikiIds.filter(
    (id) => !BUNDLED_LANGUAGE_IDS.has(id)
  );
  const extraInTable = tableIds.filter((id) => !shikiSet.has(id));
  expect(missingFromTable).toEqual([]);
  expect(extraInTable).toEqual([]);
});
