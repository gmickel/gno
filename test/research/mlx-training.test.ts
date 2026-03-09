import { describe, expect, test } from "bun:test";

import {
  buildMlxAssistantResponse,
  buildMlxUserPrompt,
  extractQueryConstraints,
  qmdPairsToTarget,
  toMlxChatExample,
  type TrainingExample,
} from "../../research/finetune/lib/mlx-training";

describe("mlx training helpers", () => {
  test("qmdPairsToTarget converts qmd pair format", () => {
    const target = qmdPairsToTarget([
      ["hyde", "Authentication uses bearer tokens."],
      ["lex", "bearer token auth"],
      ["lex", "jwt auth header"],
      ["vec", "how bearer token authentication works"],
      ["vec", "api jwt authentication flow"],
    ]);

    expect(target?.lexicalQueries).toEqual([
      "bearer token auth",
      "jwt auth header",
    ]);
    expect(target?.vectorQueries).toEqual([
      "how bearer token authentication works",
      "api jwt authentication flow",
    ]);
    expect(target?.hyde).toBe("Authentication uses bearer tokens.");
  });

  test("extractQueryConstraints captures quoted phrases, negations, and entities", () => {
    const constraints = extractQueryConstraints(
      '"Authorization: Bearer" token endpoint -cookie JWT_SECRET'
    );

    expect(constraints.quotedPhrases).toContain("Authorization: Bearer");
    expect(constraints.negations).toContain("-cookie");
    expect(constraints.criticalEntities).toContain("JWT_SECRET");
  });

  test("MLX chat examples produce strict JSON assistant content", () => {
    const example: TrainingExample = {
      id: "test-1",
      query: "JWT_SECRET minimum length validation",
      source: {
        kind: "handcrafted",
        name: "test",
      },
      target: {
        lexicalQueries: ["JWT_SECRET min length validation"],
        vectorQueries: ["how to validate JWT secret length"],
        hyde: "JWT secrets should be length-checked at startup.",
      },
    };

    const prompt = buildMlxUserPrompt(example);
    const response = buildMlxAssistantResponse(example);
    const mlx = toMlxChatExample(example);

    expect(prompt).toContain(
      "/no_think Expand this search query for GNO hybrid retrieval."
    );
    expect(response.trim().startsWith("{")).toBe(true);
    expect(mlx.messages[1]?.content).toBe(response);
  });
});
