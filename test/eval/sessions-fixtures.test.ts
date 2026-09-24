import { expect, test } from "bun:test";
// node:fs/promises readdir enumerates the fixture tree (structure op)
import { readdir } from "node:fs/promises";
// node:path has no Bun path utilities
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "../../evals/fixtures/sessions");

test("sessions eval fixtures match their committed sha256 pins", async () => {
  const manifest = (await Bun.file(join(ROOT, "manifest.json")).json()) as {
    algorithm: string;
    files: Record<string, string>;
  };
  const entries = await readdir(ROOT, { recursive: true, withFileTypes: true });
  const actual: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const rel = relative(ROOT, path).split("\\").join("/");
    if (rel === "manifest.json") continue;
    actual[rel] = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(path).arrayBuffer())
      .digest("hex");
  }
  expect(manifest.algorithm).toBe("sha256");
  expect(manifest.files).toEqual(actual);
});
