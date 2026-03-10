#!/usr/bin/env bun
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const dir = join(import.meta.dir, "../configs/prompt-profiles");
const files = (await readdir(dir))
  .filter((file) => file.endsWith(".json"))
  .sort();

for (const file of files) {
  const profile = (await Bun.file(join(dir, file)).json()) as {
    id: string;
    formatReminder: string;
  };
  console.log(`${profile.id} -> ${profile.formatReminder}`);
}
