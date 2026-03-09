#!/usr/bin/env bun
import { join } from "node:path";

import {
  extractQueryConstraints,
  qmdPairsToTarget,
  type TrainingExample,
  validateTrainingExample,
} from "../lib/mlx-training";

const QMD_ROOT = "/Users/gordon/repos/qmd/finetune";
const SOURCE_FILES = [
  "qmd_expansion_handcrafted.jsonl",
  "qmd_expansion_lex_phrases_negation.jsonl",
  "qmd_expansion_balanced_deduped.jsonl",
  "qmd_expansion_v3_structured.jsonl",
];

async function main(): Promise<void> {
  const outDir = join(import.meta.dir, "../data/generated");
  const outPath = join(outDir, "qmd-import.jsonl");
  const examples: TrainingExample[] = [];

  for (const filename of SOURCE_FILES) {
    const path = join(QMD_ROOT, "data", filename);
    const file = Bun.file(path);
    if (!(await file.exists())) {
      continue;
    }
    const lines = (await file.text()).split("\n").filter(Boolean);
    for (const [index, line] of lines.entries()) {
      const parsed = JSON.parse(line) as {
        query?: string;
        output?: unknown;
        category?: string;
        intent?: string;
      };
      if (typeof parsed.query !== "string") {
        continue;
      }
      const target = qmdPairsToTarget(parsed.output);
      if (!target) {
        continue;
      }

      const example: TrainingExample = {
        id: `qmd-${filename.replace(".jsonl", "")}-${index + 1}`,
        query: parsed.query,
        intent: parsed.intent,
        tags: ["qmd-import", filename.replace(".jsonl", "")],
        source: {
          kind: "imported",
          name: "qmd-finetune",
          provenance: path,
        },
        constraints: extractQueryConstraints(parsed.query),
        target,
      };
      await validateTrainingExample(example);
      examples.push(example);
    }
  }

  await Bun.write(
    outPath,
    `${examples.map((example) => JSON.stringify(example)).join("\n")}\n`
  );
  console.log(`Imported ${examples.length} qmd examples -> ${outPath}`);
}

await main();
