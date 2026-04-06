#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  loadHarnessConfig,
  loadRunArtifacts,
  loadSearchSpace,
  median,
} from "../lib/results";

const repoRoot = join(import.meta.dir, "../../../..");
const incumbentId = process.argv[2];
const challengerId = process.argv[3];
if (!incumbentId || !challengerId) {
  throw new Error(
    "Usage: bun run research:embeddings:autonomous:confirm-winner <incumbent-id> <challenger-id>"
  );
}

const [config, searchSpace] = await Promise.all([
  loadHarnessConfig(repoRoot),
  loadSearchSpace(repoRoot),
]);
const confirmationRuns = config.budget.confirmationRuns ?? 3;
const candidateIds = new Set([incumbentId, challengerId]);
for (const id of candidateIds) {
  if (!searchSpace.candidates.some((candidate) => candidate.id === id)) {
    throw new Error(`Unknown candidate: ${id}`);
  }
}

for (let index = 0; index < confirmationRuns; index += 1) {
  for (const id of candidateIds) {
    runCommand(`bun run research:embeddings:autonomous:run-candidate ${id}`);
  }
}

const runs = await loadRunArtifacts(repoRoot);
const incumbentRuns = runs.filter((item) => item.candidateId === incumbentId);
const challengerRuns = runs.filter((item) => item.candidateId === challengerId);
const primaryFixture = config.metric.fixtures.primary;
const secondaryFixture = config.metric.fixtures.secondary;

const incumbentPrimaryMedian = median(
  incumbentRuns.map(
    (item) => item.benchmarks[primaryFixture]?.vector?.metrics?.ndcgAt10 ?? 0
  )
);
const challengerPrimaryMedian = median(
  challengerRuns.map(
    (item) => item.benchmarks[primaryFixture]?.vector?.metrics?.ndcgAt10 ?? 0
  )
);
const incumbentSecondaryMedian = secondaryFixture
  ? median(
      incumbentRuns.map(
        (item) =>
          item.benchmarks[secondaryFixture]?.vector?.metrics?.ndcgAt10 ?? 0
      )
    )
  : 0;
const challengerSecondaryMedian = secondaryFixture
  ? median(
      challengerRuns.map(
        (item) =>
          item.benchmarks[secondaryFixture]?.vector?.metrics?.ndcgAt10 ?? 0
      )
    )
  : 0;

const decision =
  challengerPrimaryMedian > incumbentPrimaryMedian &&
  challengerSecondaryMedian >= incumbentSecondaryMedian
    ? "promote-challenger"
    : "keep-incumbent";

const outDir = join(repoRoot, config.logging.runDir);
await mkdir(outDir, { recursive: true });
const artifactPath = join(outDir, "confirmed-incumbent.json");
await Bun.write(
  artifactPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      incumbentId,
      challengerId,
      decision,
      confirmationRuns,
      incumbentMedian: {
        primaryVectorNdcgAt10: Number(incumbentPrimaryMedian.toFixed(4)),
        secondaryVectorNdcgAt10: Number(incumbentSecondaryMedian.toFixed(4)),
      },
      challengerMedian: {
        primaryVectorNdcgAt10: Number(challengerPrimaryMedian.toFixed(4)),
        secondaryVectorNdcgAt10: Number(challengerSecondaryMedian.toFixed(4)),
      },
    },
    null,
    2
  )}\n`
);

console.log(artifactPath);

function runCommand(command: string): void {
  const proc = Bun.spawnSync({
    cmd: command.split(" "),
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  if (proc.exitCode !== 0) {
    process.exit(proc.exitCode);
  }
}
