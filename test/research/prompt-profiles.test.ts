import { describe, expect, test } from "bun:test";

import {
  loadPromptProfile,
  buildMlxUserPrompt,
} from "../../research/finetune/lib/mlx-training";

describe("prompt profiles", () => {
  test("strict profile can be loaded", async () => {
    const profile = await loadPromptProfile(
      "/Users/gordon/work/gno/research/finetune/configs/prompt-profiles/strict-json-v2.json"
    );
    expect(profile.id).toBe("prompt-profile-strict-json-v2");
  });

  test("prompt builder uses configured reminder text", () => {
    const prompt = buildMlxUserPrompt(
      {
        id: "x",
        query: "JWT_SECRET minimum length validation",
        source: { kind: "handcrafted", name: "test" },
        target: {
          lexicalQueries: ["JWT_SECRET min length validation"],
          vectorQueries: ["how to validate JWT secret length"],
        },
      },
      {
        id: "test",
        systemPrefix:
          "/no_think Expand this search query for GNO hybrid retrieval.",
        requiredKeys: ["lexicalQueries", "vectorQueries"],
        optionalKeys: ["hyde"],
        rules: ["Preserve entities exactly."],
        formatReminder: "Respond with valid JSON only. Do not add prose.",
      }
    );
    expect(prompt).toContain("Respond with valid JSON only. Do not add prose.");
    expect(prompt).toContain("Preserve entities exactly.");
  });
});
