#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  collectLeaderboardRows,
  loadHarnessConfig,
  loadSearchSpace,
  selectCandidates,
} from "../lib/results";

const repoRoot = join(import.meta.dir, "../../../..");
const dryRun = process.argv.includes("--dry-run");

const [config, searchSpace, leaderboard] = await Promise.all([
  loadHarnessConfig(repoRoot),
  loadSearchSpace(repoRoot),
  collectLeaderboardRows(repoRoot),
]);

const completedCandidateIds = new Set(
  leaderboard
    .filter((row) => row.decision !== "pending")
    .map((row) => row.candidateId)
);

const selected = selectCandidates({
  candidates: searchSpace.candidates,
  completedCandidateIds,
  maxRuns: config.budget.maxRunsPerSession ?? searchSpace.candidates.length,
});

if (dryRun) {
  console.log(
    JSON.stringify(
      {
        searchSpaceId: searchSpace.id,
        selected: selected.map((item) => item.id),
        completed: [...completedCandidateIds],
      },
      null,
      2
    )
  );
  process.exit(0);
}

const executed: string[] = [];
for (const candidate of selected) {
  runCommand(
    `bun run research:embeddings:autonomous:run-candidate ${candidate.id}`
  );
  executed.push(candidate.id);
}

const sessionPath = join(
  repoRoot,
  config.logging.runDir,
  `search-session-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}.json`
);
await mkdir(join(repoRoot, config.logging.runDir), { recursive: true });
await Bun.write(
  sessionPath,
  `${JSON.stringify(
    {
      searchSpaceId: searchSpace.id,
      executed,
      generatedAt: new Date().toISOString(),
    },
    null,
    2
  )}\n`
);

console.log(sessionPath);

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
