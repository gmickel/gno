import { describe, expect, test } from "bun:test";

import { formatEmbed } from "../../src/cli/commands/embed";

describe("formatEmbed", () => {
  test("includes sample errors and hint when embedding fails partially", () => {
    const output = formatEmbed(
      {
        success: true,
        embedded: 100,
        errors: 2,
        duration: 12,
        model: "hf:test/embed.gguf",
        searchAvailable: true,
        errorSamples: ["Inference failed for model: hf:test/embed.gguf"],
        suggestion:
          "Try rerunning the same command. If failures persist, rerun with `gno --verbose embed --batch-size 1` to isolate failing chunks.",
      },
      {}
    );

    expect(output).toContain("2 chunks failed to embed.");
    expect(output).toContain(
      "Sample error: Inference failed for model: hf:test/embed.gguf"
    );
    expect(output).toContain("Hint:");
    expect(output).toContain("--batch-size 1");
  });
});
