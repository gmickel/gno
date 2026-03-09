#!/usr/bin/env bun
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  toMlxChatExample,
  type TrainingExample,
  validateTrainingExample,
} from "../lib/mlx-training";

const TRAINING_ROOT = join(import.meta.dir, "../data/training");
const GENERATED_ROOT = join(import.meta.dir, "../data/generated");
const OUT_ROOT = join(import.meta.dir, "../data/mlx");

async function collectJsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsonlFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function shuffleDeterministic<T>(values: T[]): T[] {
  const out = [...values];
  let seed = 42;
  const next = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(next() * (index + 1));
    [out[index], out[swapIndex]] = [out[swapIndex]!, out[index]!];
  }
  return out;
}

async function main(): Promise<void> {
  const files = [
    ...(await collectJsonlFiles(TRAINING_ROOT)),
    ...(await collectJsonlFiles(GENERATED_ROOT).catch(() => [])),
  ];
  const rawLines: string[] = [];
  for (const path of files) {
    rawLines.push(
      ...(await Bun.file(path)
        .text()
        .then((text) => text.split("\n").filter(Boolean)))
    );
  }

  const examples: TrainingExample[] = [];
  for (const line of rawLines) {
    const parsed = JSON.parse(line) as TrainingExample;
    await validateTrainingExample(parsed);
    examples.push(parsed);
  }

  const deduped = new Map<string, TrainingExample>();
  for (const example of examples) {
    const key = example.query.trim().toLowerCase();
    if (!deduped.has(key)) {
      deduped.set(key, example);
    }
  }

  const shuffled = shuffleDeterministic([...deduped.values()]);
  const splitIndex = Math.max(1, Math.floor(shuffled.length * 0.9));
  const train = shuffled.slice(0, splitIndex).map(toMlxChatExample);
  const valid = shuffled.slice(splitIndex).map(toMlxChatExample);

  await Bun.write(
    join(OUT_ROOT, "train.jsonl"),
    `${train.map((item) => JSON.stringify(item)).join("\n")}\n`
  );
  await Bun.write(
    join(OUT_ROOT, "valid.jsonl"),
    `${valid.map((item) => JSON.stringify(item)).join("\n")}\n`
  );
  await Bun.write(
    join(OUT_ROOT, "dataset-info.json"),
    `${JSON.stringify(
      {
        totalExamples: shuffled.length,
        trainExamples: train.length,
        validExamples: valid.length,
        sources: [...new Set(shuffled.map((item) => item.source.name))],
      },
      null,
      2
    )}\n`
  );

  console.log(
    `Built MLX dataset: ${shuffled.length} examples (${train.length} train / ${valid.length} valid)`
  );
}

await main();
