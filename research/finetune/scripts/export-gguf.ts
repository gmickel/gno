#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const exportPython = join(
  repoRoot,
  "research/finetune/.venv-export/bin/python"
);
const llamaCppDir = "/tmp/llama.cpp";
const fusedModelDir = join(
  repoRoot,
  "research/finetune/outputs/mlx-qwen3-1.7b-lora/fused-deq"
);
const outFile = join(
  repoRoot,
  "research/finetune/outputs/mlx-qwen3-1.7b-lora/gno-expansion-qwen3-1.7b-f16.gguf"
);

const steps: string[][] = [
  [
    "git",
    "clone",
    "--depth",
    "1",
    "https://github.com/ggerganov/llama.cpp.git",
    llamaCppDir,
  ],
  [
    exportPython,
    join(llamaCppDir, "convert_hf_to_gguf.py"),
    fusedModelDir,
    "--outfile",
    outFile,
    "--outtype",
    "f16",
  ],
];

for (const command of steps) {
  const [bin, ...args] = command;
  if (!(bin && args)) {
    continue;
  }
  if (bin === "git" && existsSync(join(llamaCppDir, "convert_hf_to_gguf.py"))) {
    continue;
  }
  const result = spawnSync(bin, args, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`Wrote GGUF to ${outFile}`);
