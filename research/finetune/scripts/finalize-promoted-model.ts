#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

interface ConfirmedIncumbentArtifact {
  decision: "keep-incumbent" | "promote-challenger";
  incumbentRun: string;
  challengerRun: string;
  repeatPath: string;
}

interface RepeatMedian {
  ndcgAt10: number;
  askRecallAt5: number;
  schemaSuccessRate: number;
  p95Ms: number;
}

interface RepeatSide {
  run: string;
  aggregate: {
    median: RepeatMedian;
  };
}

const [releaseId = "slim-retrieval-v1", explicitRunName, explicitRepoId] =
  process.argv.slice(2);
const repoRoot = join(import.meta.dir, "../../..");

const confirmedPath = join(
  repoRoot,
  "research/finetune/autonomous/runs/confirmed-incumbent.json"
);
const confirmed = (await Bun.file(
  confirmedPath
).json()) as ConfirmedIncumbentArtifact;
const runName =
  explicitRunName ??
  (confirmed.decision === "promote-challenger"
    ? confirmed.challengerRun
    : confirmed.incumbentRun);
const repoId = explicitRepoId ?? `guiltylemon/gno-expansion-${releaseId}`;
const githubBase = "https://github.com/gmickel/gno/blob/main";

const runDir = join(repoRoot, "research/finetune/outputs", runName);
const promotedDir = join(repoRoot, "research/finetune/promoted", releaseId);
const hfStageDir = join(promotedDir, "hf");
const benchmarkPath = join(runDir, "benchmark-summary.json");
const promotionSummaryPath = join(runDir, "promotion/promotion-summary.json");
const installSnippetPath = join(runDir, "promotion/install-snippet.yaml");
const bestCheckpointPath = join(runDir, "best-checkpoint.json");
const repeatPath = confirmed.repeatPath;
const promotionTargetPath = join(
  repoRoot,
  "research/finetune/autonomous/runs",
  `promotion-target-check-${runName}.json`
);
const ggufPath = join(
  repoRoot,
  `research/finetune/outputs/${runName}-best-fused-deq/gno-expansion-${runName}-f16.gguf`
);

const [
  benchmark,
  promotionSummary,
  bestCheckpoint,
  repeat,
  promotionTargetCheck,
] = await Promise.all([
  Bun.file(benchmarkPath).json(),
  Bun.file(promotionSummaryPath).json(),
  Bun.file(bestCheckpointPath).json(),
  Bun.file(repeatPath).json(),
  Bun.file(promotionTargetPath).json(),
]);

await mkdir(promotedDir, { recursive: true });
await mkdir(hfStageDir, { recursive: true });

const repeatSummary =
  "summary" in (repeat as Record<string, unknown>)
    ? (repeat as { summary: Record<string, unknown> }).summary
    : repeat;

const releaseManifest = {
  releaseId,
  repoId,
  runName,
  generatedAt: new Date().toISOString(),
  ggufPath,
  ggufFileName: basename(ggufPath),
  benchmarkPath,
  repeatPath,
  confirmedPath,
  promotionTargetPath,
  installSnippetPath,
  promotionSummaryPath,
  bestCheckpoint,
  benchmark,
  repeatSummary,
  confirmedIncumbent: confirmed,
  promotionTargetCheck,
};

const publicReleaseManifest = {
  releaseId,
  repoId,
  runName,
  generatedAt: new Date().toISOString(),
  ggufFileName: basename(ggufPath),
  benchmarkFile: "benchmark-summary.json",
  repeatBenchmarkFile: "repeat-benchmark.json",
  promotionSummaryFile: "promotion-summary.json",
  confirmedIncumbentFile: "confirmed-incumbent.json",
  promotionTargetCheckFile: "promotion-target-check.json",
  installSnippetFile: "install-snippet.yaml",
  githubReference: `${githubBase}/research/finetune/promoted/${releaseId}/release-manifest.json`,
};

const canonicalInstallSnippet = `models:
  activePreset: slim-tuned
  presets:
    - id: slim-tuned
      name: GNO Slim Retrieval v1
      embed: "hf:gpustack/bge-m3-GGUF/bge-m3-Q4_K_M.gguf"
      rerank: "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf"
      gen: "hf:${repoId}/${basename(ggufPath)}"
`;

const repeated = repeatSummary as {
  left: RepeatSide;
  right: RepeatSide;
};
const repeatedWinner =
  repeated.right.run === runName ? repeated.right : repeated.left;
const repeatedBaseline =
  repeated.left.run === runName ? repeated.right : repeated.left;

const canonicalModelCard = `---
library_name: llama.cpp
base_model: mlx-community/Qwen3-1.7B-4bit
tags:
  - gguf
  - gno
  - retrieval
  - query-expansion
  - qwen3
---

# GNO Slim Retrieval v1

Fine-tuned query expansion model for GNO hybrid retrieval.

Canonical promoted run: \`${runName}\`
HF repo: \`${repoId}\`
GGUF file: \`${basename(ggufPath)}\`

## What This Model Is For

- retrieval-centric query expansion
- entity / negation preservation
- multilingual retrieval support
- JSON-structured expansion output for GNO

It is not optimized for standalone answer synthesis.

## Promotion Decision

- confirmed incumbent artifact: [confirmed-incumbent.json](${`${githubBase}/research/finetune/autonomous/runs/confirmed-incumbent.json`})
- promotion target gate: [promotion-target-check.json](${`${githubBase}/research/finetune/autonomous/runs/promotion-target-check-${runName}.json`})
- result: passed

## Repeated Benchmark

- promoted median nDCG@10: ${repeatedWinner.aggregate.median.ndcgAt10.toFixed(4)}
- previous incumbent median nDCG@10: ${repeatedBaseline.aggregate.median.ndcgAt10.toFixed(4)}
- promoted median ask Recall@5: ${repeatedWinner.aggregate.median.askRecallAt5.toFixed(4)}
- promoted median schema success: ${(repeatedWinner.aggregate.median.schemaSuccessRate * 100).toFixed(1)}%
- promoted median p95: ${repeatedWinner.aggregate.median.p95Ms.toFixed(2)}ms

## Shipped Slim Baseline Delta

- shipped slim nDCG@10: ${(
  promotionTargetCheck as { shippedSlimNdcgAt10: number }
).shippedSlimNdcgAt10.toFixed(4)}
- promoted median delta vs shipped slim: ${(
  repeatedWinner.aggregate.median.ndcgAt10 -
  (promotionTargetCheck as { shippedSlimNdcgAt10: number }).shippedSlimNdcgAt10
).toFixed(4)}

## Install In GNO

\`\`\`yaml
${canonicalInstallSnippet.trim()}
\`\`\`

## Published Artifact

- HF model URI: \`hf:${repoId}/${basename(ggufPath)}\`
- best checkpoint: \`${basename(
  (
    bestCheckpoint as {
      best: { adapterFile: string };
    }
  ).best.adapterFile
)}\`

## Source Artifacts

- benchmark summary: \`benchmark-summary.json\`
- repeat benchmark: \`repeat-benchmark.json\`
- promotion summary: \`promotion-summary.json\`
- release manifest: \`release-manifest.json\`
`;

const publishScript = `#!/usr/bin/env bash
set -euo pipefail

REPO_ID="${repoId}"
GGUF_PATH="${ggufPath}"
STAGE_DIR="${hfStageDir}"

hf repos create "$REPO_ID" --type model --exist-ok
hf upload "$REPO_ID" "$STAGE_DIR/README.md" README.md --commit-message "docs: update model card"
hf upload "$REPO_ID" "$STAGE_DIR/install-snippet.yaml" install-snippet.yaml --commit-message "docs: add install snippet"
hf upload "$REPO_ID" "$STAGE_DIR/release-manifest.json" release-manifest.json --commit-message "docs: add release manifest"
hf upload "$REPO_ID" "$STAGE_DIR/benchmark-summary.json" benchmark-summary.json --commit-message "docs: add benchmark summary"
hf upload "$REPO_ID" "$STAGE_DIR/repeat-benchmark.json" repeat-benchmark.json --commit-message "docs: add repeated benchmark"
hf upload "$REPO_ID" "$STAGE_DIR/promotion-summary.json" promotion-summary.json --commit-message "docs: add promotion summary"
hf upload "$REPO_ID" "$STAGE_DIR/promotion-target-check.json" promotion-target-check.json --commit-message "docs: add promotion target check"
hf upload "$REPO_ID" "$STAGE_DIR/confirmed-incumbent.json" confirmed-incumbent.json --commit-message "docs: add incumbent confirmation"
hf upload "$REPO_ID" "$GGUF_PATH" "${basename(ggufPath)}" --commit-message "model: upload promoted GGUF"
`;

await Bun.write(
  join(promotedDir, "release-manifest.json"),
  `${JSON.stringify(releaseManifest, null, 2)}\n`
);
await Bun.write(join(promotedDir, "MODEL_CARD.md"), canonicalModelCard);
await Bun.write(
  join(promotedDir, "install-snippet.yaml"),
  canonicalInstallSnippet
);
await Bun.write(join(hfStageDir, "README.md"), canonicalModelCard);
await Bun.write(
  join(hfStageDir, "install-snippet.yaml"),
  canonicalInstallSnippet
);
await Bun.write(
  join(hfStageDir, "release-manifest.json"),
  `${JSON.stringify(publicReleaseManifest, null, 2)}\n`
);
await Bun.write(
  join(hfStageDir, "benchmark-summary.json"),
  `${JSON.stringify(benchmark, null, 2)}\n`
);
await Bun.write(
  join(hfStageDir, "repeat-benchmark.json"),
  `${JSON.stringify(repeat, null, 2)}\n`
);
await Bun.write(
  join(hfStageDir, "promotion-summary.json"),
  `${JSON.stringify(promotionSummary, null, 2)}\n`
);
await Bun.write(
  join(hfStageDir, "promotion-target-check.json"),
  `${JSON.stringify(promotionTargetCheck, null, 2)}\n`
);
await Bun.write(
  join(hfStageDir, "confirmed-incumbent.json"),
  `${JSON.stringify(confirmed, null, 2)}\n`
);
await Bun.write(
  join(hfStageDir, ".gitattributes"),
  `*.gguf filter=lfs diff=lfs merge=lfs -text\n`
);
await Bun.write(join(promotedDir, "publish-hf.sh"), publishScript);

console.log(join(promotedDir, "release-manifest.json"));
