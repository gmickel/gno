import { describe, expect, test } from "bun:test";

describe("desktop distribution scaffold", () => {
  test("rollout doc exists", async () => {
    expect(await Bun.file("docs/DESKTOP-BETA-ROLLOUT.md").exists()).toBe(true);
  });

  test("shell distribution placeholders exist", async () => {
    expect(
      await Bun.file(
        "desktop/electrobun-shell/distribution/channels.example.json"
      ).exists()
    ).toBe(true);
    expect(
      await Bun.file(
        "desktop/electrobun-shell/distribution/macos-signing-checklist.md"
      ).exists()
    ).toBe(true);
  });
});
