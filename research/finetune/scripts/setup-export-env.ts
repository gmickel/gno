#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const venvDir = join(repoRoot, "research/finetune/.venv-export");
const python = "/opt/homebrew/bin/python3";

for (const command of [
  [python, "-m", "venv", venvDir],
  [
    join(venvDir, "bin/pip"),
    "install",
    "-q",
    "--upgrade",
    "pip",
    "setuptools",
    "wheel",
  ],
  [
    join(venvDir, "bin/pip"),
    "install",
    "-q",
    "torch",
    "transformers",
    "sentencepiece",
    "protobuf",
    "numpy",
    "gguf",
    "safetensors",
    "huggingface_hub",
  ],
]) {
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`Export env ready at ${venvDir}`);
