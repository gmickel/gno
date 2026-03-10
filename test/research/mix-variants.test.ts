import { describe, expect, test } from "bun:test";

import lexical from "../../research/finetune/configs/mixes/lexical-boost.json";
import multilingual from "../../research/finetune/configs/mixes/multilingual-boost.json";
import qmdMajority from "../../research/finetune/configs/mixes/qmd-majority.json";

describe("mix variants", () => {
  test("qmd-majority keeps imported corpus dominant", () => {
    const qmd = qmdMajority.entries.find(
      (entry) => entry.name === "qmd-import"
    );
    expect(qmd?.maxExamples).toBeGreaterThan(1500);
  });

  test("multilingual variant boosts multilingual hardcases", () => {
    const entry = multilingual.entries.find(
      (item) => item.name === "gno-multilingual-hardcases"
    );
    expect(entry?.repeat).toBeGreaterThan(10);
  });

  test("lexical variant boosts lexical preservation hardcases", () => {
    const entry = lexical.entries.find(
      (item) => item.name === "gno-lexical-preservation-hardcases"
    );
    expect(entry?.repeat).toBeGreaterThan(10);
  });
});
