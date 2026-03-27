import { describe, expect, test } from "bun:test";

describe("electrobun shell scaffold", () => {
  test("shell package and entrypoint exist", async () => {
    expect(
      await Bun.file("desktop/electrobun-shell/package.json").exists()
    ).toBe(true);
    expect(
      await Bun.file("desktop/electrobun-shell/src/bun/index.ts").exists()
    ).toBe(true);
  });

  test("README records shell boundary and open-file strategy", async () => {
    const readme = await Bun.file("desktop/electrobun-shell/README.md").text();
    expect(readme).toContain("open-file");
    expect(readme).toContain("singleton");
    expect(readme).toContain("Tabs stay app-level GNO workspace state.");
  });

  test("plist fragment records markdown/plaintext association strategy", async () => {
    const plist = await Bun.file(
      "desktop/electrobun-shell/macos/Info.plist.fragment.plist"
    ).text();
    expect(plist).toContain("CFBundleDocumentTypes");
    expect(plist).toContain("net.daringfireball.markdown");
    expect(plist).toContain("public.plain-text");
  });
});
