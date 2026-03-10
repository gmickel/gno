#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";

const mixArg = process.argv[2];
if (!mixArg) {
  throw new Error(
    "Usage: bun run research:finetune:build-variant-dataset <mix-json-path>"
  );
}

const repoRoot = join(import.meta.dir, "../../..");
const mixName = basename(mixArg, ".json");
const output = `research/finetune/data/mlx-${mixName}`;

const result = spawnSync(
  "bun",
  [
    "research/finetune/scripts/build-mlx-dataset.ts",
    "--mix",
    mixArg,
    "--output",
    output,
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
  }
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(output);
