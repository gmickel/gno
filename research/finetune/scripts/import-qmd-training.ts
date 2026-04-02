#!/usr/bin/env bun
import { join } from "node:path";

import {
  extractQueryConstraints,
  qmdPairsToTarget,
  shouldFilterImportedExample,
  type TrainingExample,
  validateTrainingExample,
} from "../lib/mlx-training";

const SOURCE_FILES = [
  "qmd_expansion_handcrafted.jsonl",
  "qmd_expansion_lex_phrases_negation.jsonl",
  "qmd_expansion_balanced_deduped.jsonl",
  "qmd_expansion_v3_structured.jsonl",
];

function resolveQmdRoot(): string {
  const argRoot = Bun.argv[2]?.trim();
  const envRoot = process.env.QMD_FINETUNE_ROOT?.trim();
  const root = argRoot || envRoot;

  if (!root) {
    throw new Error(
      [
        "Missing QMD finetune root.",
        "This script is legacy-only and exists to refresh the committed frozen snapshot.",
        "Pass the path explicitly as:",
        "  QMD_FINETUNE_ROOT=/abs/path/to/qmd/finetune bun run research:finetune:qmd-import:legacy",
        "or:",
        "  bun research/finetune/scripts/import-qmd-training.ts /abs/path/to/qmd/finetune",
      ].join("\n")
    );
  }

  return root;
}

async function main(): Promise<void> {
  const qmdRoot = resolveQmdRoot();
  const outDir = join(import.meta.dir, "../data/generated");
  const outPath = join(outDir, "qmd-import.jsonl");
  const examples: TrainingExample[] = [];
  let filteredTemporal = 0;

  for (const filename of SOURCE_FILES) {
    const path = join(qmdRoot, "data", filename);
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
      if (shouldFilterImportedExample(parsed.query, target)) {
        filteredTemporal += 1;
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
  await Bun.write(
    join(outDir, "qmd-import-report.json"),
    `${JSON.stringify(
      {
        kept: examples.length,
        filtered: filteredTemporal,
        reason: "temporal_or_release_drift_only",
        sourceRoot: qmdRoot,
        sourceFiles: SOURCE_FILES,
      },
      null,
      2
    )}\n`
  );
  console.log(`Imported ${examples.length} qmd examples -> ${outPath}`);
}

await main();
