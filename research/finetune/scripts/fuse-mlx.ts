#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { join } from "node:path";

const model = "mlx-community/Qwen3-1.7B-4bit";
const adapterPath = join(
  import.meta.dir,
  "../outputs/mlx-qwen3-1.7b-lora/adapters"
);
const savePath = join(
  import.meta.dir,
  "../outputs/mlx-qwen3-1.7b-lora/fused-deq"
);

const child = spawn(
  "python3",
  [
    "-m",
    "mlx_lm",
    "fuse",
    "--model",
    model,
    "--adapter-path",
    adapterPath,
    "--save-path",
    savePath,
    "--dequantize",
  ],
  {
    cwd: join(import.meta.dir, "../../.."),
    stdio: "inherit",
    env: process.env,
  }
);

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
