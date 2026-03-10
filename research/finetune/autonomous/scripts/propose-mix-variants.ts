#!/usr/bin/env bun
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../../..");
const configPath = join(repoRoot, "research/finetune/autonomous/config.json");
const config = (await Bun.file(configPath).json()) as {
  id: string;
  logging: { runDir: string };
};

const mixesDir = join(repoRoot, "research/finetune/configs/mixes");
const files = (await readdir(mixesDir))
  .filter((file) => file.endsWith(".json"))
  .sort();
const variants = [];

for (const file of files) {
  const path = join(mixesDir, file);
  const mix = (await Bun.file(path).json()) as { id: string };
  variants.push({
    mixId: mix.id,
    path: `research/finetune/configs/mixes/${file}`,
    targetConfig: "research/finetune/configs/training-mix.json",
  });
}

const outPath = join(
  repoRoot,
  config.logging.runDir,
  "mix-variant-proposals.json"
);
await Bun.write(
  outPath,
  `${JSON.stringify({ policyId: config.id, variants }, null, 2)}\n`
);
console.log(outPath);
