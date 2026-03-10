import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("variant dataset build", () => {
  test("build script accepts an alternate mix path", async () => {
    const repoRoot = "/Users/gordon/work/gno";
    const tempDir = await mkdtemp(join(tmpdir(), "gno-mix-"));
    const mixPath = join(tempDir, "tiny-mix.json");
    await writeFile(
      mixPath,
      JSON.stringify(
        {
          id: "tiny-mix",
          seed: 42,
          entries: [
            {
              name: "gno-hardcases",
              path: "research/finetune/data/training/gno-hardcases.jsonl",
              repeat: 1,
              maxExamples: 2,
            },
          ],
        },
        null,
        2
      )
    );

    const result = spawnSync(
      "bun",
      [
        "research/finetune/scripts/build-mlx-dataset.ts",
        "--mix",
        mixPath,
        "--output",
        join(tempDir, "mlx-tiny-mix-test"),
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
      }
    );

    expect(result.status).toBe(0);
    const infoPath = join(tempDir, "mlx-tiny-mix-test/dataset-info.json");
    const info = (await Bun.file(infoPath).json()) as { mixId: string };
    expect(info.mixId).toBe("tiny-mix");
  });
});
