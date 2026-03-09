import { describe, expect, test } from "bun:test";

import config from "../../research/finetune/configs/expansion-qwen3-1.7b-sft.json";
import heldoutManifest from "../../research/finetune/data/splits/heldout.json";

interface PromotionCase {
  id: string;
  split: "train" | "validation" | "heldout";
  caseSet: "baseline" | "adversarial" | "multilingual" | "ask";
}

describe("finetune sandbox", () => {
  test("baseline config points at fn-34 recommended base", () => {
    expect(config.model.runtimeModelUri).toBe(
      "hf:unsloth/Qwen3-1.7B-GGUF/Qwen3-1.7B-Q4_K_M.gguf"
    );
    expect(config.evaluation.promotionSplit).toBe("heldout");
  });

  test("heldout manifest contains ask and multilingual promotion cases", () => {
    const promotionCases = Bun.file(
      new URL(
        "../../research/finetune/data/promotion/promotion-cases.jsonl",
        import.meta.url
      )
    )
      .text()
      .then((text) =>
        text
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line: string) => JSON.parse(line) as PromotionCase)
      );

    return promotionCases.then((cases) => {
      const heldoutIds = new Set(heldoutManifest.caseIds);
      const requiredIds = cases
        .filter(
          (item: PromotionCase) =>
            item.caseSet === "ask" || item.caseSet === "multilingual"
        )
        .map((item: PromotionCase) => item.id);

      for (const id of requiredIds) {
        expect(heldoutIds.has(id)).toBe(true);
      }
    });
  });
});
