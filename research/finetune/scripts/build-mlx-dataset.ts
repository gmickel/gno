#!/usr/bin/env bun
import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";

import {
  loadDatasetMixConfig,
  loadPromptProfile,
  toMlxChatExample,
  type TrainingExample,
  validateTrainingExample,
} from "../lib/mlx-training";

const TRAINING_ROOT = join(import.meta.dir, "../data/training");
const GENERATED_ROOT = join(import.meta.dir, "../data/generated");
const OUT_ROOT = join(import.meta.dir, "../data/mlx");
const MIX_PATH = join(import.meta.dir, "../configs/training-mix.json");
const PROMPT_PROFILE_PATH = join(
  import.meta.dir,
  "../configs/prompt-profile.json"
);

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
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      mix: { type: "string" },
      output: { type: "string" },
      prompt_profile: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  const mixPath = values.mix
    ? isAbsolute(values.mix)
      ? values.mix
      : join(import.meta.dir, "../../..", values.mix)
    : MIX_PATH;
  const outputRoot = values.output
    ? isAbsolute(values.output)
      ? values.output
      : join(import.meta.dir, "../../..", values.output)
    : OUT_ROOT;
  const promptProfilePath = values.prompt_profile
    ? isAbsolute(values.prompt_profile)
      ? values.prompt_profile
      : join(import.meta.dir, "../../..", values.prompt_profile)
    : PROMPT_PROFILE_PATH;

  const mix = await loadDatasetMixConfig(mixPath);
  const promptProfile = await loadPromptProfile(promptProfilePath);
  const examples: TrainingExample[] = [];
  const availableFiles = new Set([
    ...(await collectJsonlFiles(TRAINING_ROOT)),
    ...(await collectJsonlFiles(GENERATED_ROOT).catch(() => [])),
  ]);

  for (const entry of mix.entries) {
    const absolutePath = join(import.meta.dir, "../../..", entry.path);
    if (!availableFiles.has(absolutePath)) {
      continue;
    }

    const parsedLines = (await Bun.file(absolutePath).text())
      .split("\n")
      .filter(Boolean)
      .slice(0, entry.maxExamples ?? Number.POSITIVE_INFINITY);
    const repeated = entry.repeat ?? 1;
    const canonical = new Map<string, TrainingExample>();

    for (const line of parsedLines) {
      const parsed = JSON.parse(line) as TrainingExample;
      await validateTrainingExample(parsed);
      if (!canonical.has(parsed.id)) {
        canonical.set(parsed.id, parsed);
      }
    }

    for (let repeatIndex = 0; repeatIndex < repeated; repeatIndex += 1) {
      for (const parsed of canonical.values()) {
        examples.push({
          ...parsed,
          id: `${parsed.id}::${entry.name}::r${repeatIndex}`,
        });
      }
    }
  }

  const shuffled = shuffleDeterministic(examples);
  const splitIndex = Math.max(1, Math.floor(shuffled.length * 0.9));
  const train = shuffled
    .slice(0, splitIndex)
    .map((example) => toMlxChatExample(example, promptProfile));
  const valid = shuffled
    .slice(splitIndex)
    .map((example) => toMlxChatExample(example, promptProfile));

  await Bun.write(
    join(outputRoot, "train.jsonl"),
    `${train.map((item) => JSON.stringify(item)).join("\n")}\n`
  );
  await Bun.write(
    join(outputRoot, "valid.jsonl"),
    `${valid.map((item) => JSON.stringify(item)).join("\n")}\n`
  );
  await Bun.write(
    join(outputRoot, "dataset-info.json"),
    `${JSON.stringify(
      {
        totalExamples: shuffled.length,
        trainExamples: train.length,
        validExamples: valid.length,
        sources: [...new Set(shuffled.map((item) => item.source.name))],
        mixId: mix.id,
        mixPath,
        promptProfileId: promptProfile.id,
        promptProfilePath,
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
