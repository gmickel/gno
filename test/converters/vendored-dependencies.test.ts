import { expect, test } from "bun:test";

test("vendored converters retain upstream bytes and resolve repaired parser dependencies", async () => {
  const root = new URL("../../vendor/converters/", import.meta.url);
  const manifest = (await Bun.file(
    new URL("upstream-manifest.json", root)
  ).json()) as {
    packages: { name: string; files: Record<string, string> }[];
  };
  for (const upstream of manifest.packages) {
    for (const [path, hash] of Object.entries(upstream.files)) {
      const bytes = await Bun.file(
        new URL(`${upstream.name}/${path}`, root)
      ).bytes();
      expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(
        hash
      );
    }
  }
  for (const [converter, parser, version] of [
    ["markitdown-ts", "xlsx", "0.20.3"],
    ["officeparser", "pdfjs-dist", "6.3.289"],
  ] as const) {
    const directory = new URL(`${converter}/`, root).pathname;
    const metadata = await Bun.file(
      Bun.resolveSync(`${parser}/package.json`, directory)
    ).json();
    expect(metadata.version).toBe(version);
  }
});
