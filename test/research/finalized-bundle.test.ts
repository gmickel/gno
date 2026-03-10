import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("finalized promoted bundle", () => {
  test("slim retrieval v1 manifest exists", async () => {
    const repoRoot = join(import.meta.dir, "../..");
    const file = Bun.file(
      join(
        repoRoot,
        "research/finetune/promoted/slim-retrieval-v1/release-manifest.json"
      )
    );
    expect(await file.exists()).toBe(true);
  });
});
