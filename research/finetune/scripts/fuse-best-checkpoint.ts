#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, copyFile } from "node:fs/promises";
import { basename, join } from "node:path";

const runName = process.argv[2] ?? "mlx-run1";
const repoRoot = join(import.meta.dir, "../../..");
const outputsDir = join(repoRoot, "research/finetune/outputs");
const adapterDir = join(outputsDir, runName);
const bestPath = join(adapterDir, "best-checkpoint.json");
if (!existsSync(bestPath)) {
  throw new Error(
    `Missing ${bestPath}. Run research:finetune:select-best first.`
  );
}

const best = (await Bun.file(bestPath).json()) as {
  best?: { iteration: number; adapterFile?: string };
};
const adapterFile = best.best?.adapterFile;
if (!adapterFile) {
  throw new Error(`No adapter file in ${bestPath}`);
}

const selectedAdapterDir = join(outputsDir, `${runName}-best-adapter`);
await mkdir(selectedAdapterDir, { recursive: true });
await copyFile(
  join(adapterDir, "adapter_config.json"),
  join(selectedAdapterDir, "adapter_config.json")
);
await copyFile(adapterFile, join(selectedAdapterDir, "adapters.safetensors"));

const savePath = join(outputsDir, `${runName}-best-fused-deq`);
const result = spawnSync(
  "python3",
  [
    "-m",
    "mlx_lm",
    "fuse",
    "--model",
    "mlx-community/Qwen3-1.7B-4bit",
    "--adapter-path",
    selectedAdapterDir,
    "--save-path",
    savePath,
    "--dequantize",
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  }
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`Fused ${basename(adapterFile)} -> ${savePath}`);
