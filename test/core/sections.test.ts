import { describe, expect, test } from "bun:test";

import { extractSections } from "../../src/core/sections";

describe("sections", () => {
  test("extracts headings with stable duplicate anchors", () => {
    const sections = extractSections(
      `# Alpha\n\n## Beta\n\n## Beta\n\n### Gamma`
    );

    expect(sections).toEqual([
      { anchor: "alpha", level: 1, line: 1, title: "Alpha" },
      { anchor: "beta", level: 2, line: 3, title: "Beta" },
      { anchor: "beta-2", level: 2, line: 5, title: "Beta" },
      { anchor: "gamma", level: 3, line: 7, title: "Gamma" },
    ]);
  });

  test("ignores headings inside matching backtick and tilde fences", () => {
    const content = [
      "# Outside",
      "```ts",
      "## Backtick decoy",
      "~~~",
      "``",
      "```",
      "## Between",
      "~~~~ note",
      "### Tilde decoy",
      "```",
      "~~~",
      "~~~~",
      "### After",
    ].join("\n");

    expect(extractSections(content)).toEqual([
      { anchor: "outside", level: 1, line: 1, title: "Outside" },
      { anchor: "between", level: 2, line: 7, title: "Between" },
      { anchor: "after", level: 3, line: 13, title: "After" },
    ]);
  });
});
