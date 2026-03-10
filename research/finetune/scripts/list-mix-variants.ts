#!/usr/bin/env bun
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const mixesDir = join(import.meta.dir, "../configs/mixes");
const files = (await readdir(mixesDir))
  .filter((file) => file.endsWith(".json"))
  .sort();

for (const file of files) {
  const path = join(mixesDir, file);
  const config = (await Bun.file(path).json()) as {
    id: string;
    entries: Array<{ name: string; repeat?: number; maxExamples?: number }>;
  };
  const summary = config.entries
    .map(
      (entry) =>
        `${entry.name}:${entry.repeat ?? 1}${entry.maxExamples ? `@${entry.maxExamples}` : ""}`
    )
    .join(", ");
  console.log(`${config.id} -> ${summary}`);
}
