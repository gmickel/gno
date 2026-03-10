import { describe, expect, test } from "bun:test";

describe("finalized promoted bundle", () => {
  test("slim retrieval v1 manifest exists", async () => {
    const file = Bun.file(
      "/Users/gordon/work/gno/research/finetune/promoted/slim-retrieval-v1/release-manifest.json"
    );
    expect(await file.exists()).toBe(true);
  });
});
