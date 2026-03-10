#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const runName = process.argv[2] ?? "mlx-run1";
const repoRoot = join(import.meta.dir, "../../..");
const bestCheckpointPath = join(
  repoRoot,
  `research/finetune/outputs/${runName}/best-checkpoint.json`
);

const steps: Array<{ label: string; cmd: string[] }> = [
  {
    label: "fuse-best",
    cmd: ["bun", "run", "research:finetune:fuse-best", runName],
  },
  {
    label: "export-env",
    cmd: ["bun", "run", "research:finetune:export-env"],
  },
  {
    label: "export-gguf",
    cmd: ["bun", "run", "research:finetune:export-gguf", runName],
  },
  {
    label: "smoke-gno-export",
    cmd: ["bun", "run", "research:finetune:smoke-gno-export", runName],
  },
  {
    label: "benchmark-export",
    cmd: ["bun", "run", "research:finetune:benchmark-export", runName],
  },
  {
    label: "promotion-bundle",
    cmd: ["bun", "run", "research:finetune:promotion-bundle", runName],
  },
];

if (!existsSync(bestCheckpointPath)) {
  steps.unshift({
    label: "select-best",
    cmd: ["bun", "run", "research:finetune:select-best", runName],
  });
}

for (const step of steps) {
  console.log(`\n==> ${step.label}`);
  const [bin, ...args] = step.cmd;
  const result = spawnSync(bin!, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`\nPromotion flow completed for ${runName}`);
