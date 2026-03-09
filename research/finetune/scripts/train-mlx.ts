#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { join } from "node:path";

const configPath = join(import.meta.dir, "../configs/mlx-qwen3-1.7b-lora.yaml");

const child = spawn(
  "python3",
  ["-m", "mlx_lm", "lora", "--train", "--config", configPath],
  {
    cwd: join(import.meta.dir, "../../.."),
    stdio: "inherit",
    env: {
      ...process.env,
      TOKENIZERS_PARALLELISM: "true",
    },
  }
);

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
