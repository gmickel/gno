import { describe, expect, test } from "bun:test";

import {
  buildExpansionPrompt,
  parseExpansionOutput,
} from "../../src/pipeline/expansion";

describe("expansion benchmark helpers", () => {
  test("buildExpansionPrompt reuses production template and intent wiring", () => {
    const prompt = buildExpansionPrompt("helm rollback", {
      lang: "de",
      intent: "exclude upgrade-only fixes",
    });

    expect(prompt).toContain('Anfrage: "helm rollback"');
    expect(prompt).toContain('Query intent: "exclude upgrade-only fixes"');
  });

  test("parseExpansionOutput applies guardrails to parsed JSON", () => {
    const parsed = parseExpansionOutput(
      JSON.stringify({
        lexicalQueries: [
          "best restaurants in paris",
          '"Authorization: Bearer" token',
        ],
        vectorQueries: ["auth bearer token flow"],
        hyde: "Authorization: Bearer headers carry a JWT access token.",
      }),
      '"Authorization: Bearer" token endpoint -cookie'
    );

    expect(parsed?.lexicalQueries[0]).toContain('"Authorization: Bearer"');
    expect(parsed?.lexicalQueries[0]).toContain("-cookie");
    expect(parsed?.vectorQueries).toContain("auth bearer token flow");
  });
});
