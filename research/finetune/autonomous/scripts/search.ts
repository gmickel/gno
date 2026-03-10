#!/usr/bin/env bun
import { join } from "node:path";

import {
  collectLeaderboardRows,
  loadHarnessConfig,
  loadSearchSpace,
  pickBestKeepCandidate,
  selectCandidates,
} from "../lib/results";

interface CliOptions {
  candidateIds: string[];
  dryRun: boolean;
  rerun: boolean;
  limit?: number;
}

const repoRoot = join(import.meta.dir, "../../../..");
const options = parseArgs(process.argv.slice(2));
const [config, searchSpace] = await Promise.all([
  loadHarnessConfig(repoRoot),
  loadSearchSpace(repoRoot),
]);

const existingRows = await collectLeaderboardRows(repoRoot);
const completedCandidateIds = new Set(
  existingRows
    .filter((row) => row.decision !== "pending")
    .map((row) => row.candidateId)
);
const requestedCandidateIds =
  options.candidateIds.length > 0 ? new Set(options.candidateIds) : undefined;
const maxRuns =
  options.limit ??
  config.budget.maxRunsPerSession ??
  searchSpace.candidates.length;
const selected = selectCandidates({
  candidates: searchSpace.candidates,
  completedCandidateIds,
  requestedCandidateIds,
  includeCompleted: options.rerun,
  maxRuns,
});

const skipped = searchSpace.candidates
  .filter((candidate) => !selected.some((item) => item.id === candidate.id))
  .map((candidate) => ({
    candidateId: candidate.id,
    reason:
      requestedCandidateIds && !requestedCandidateIds.has(candidate.id)
        ? "not-requested"
        : completedCandidateIds.has(candidate.id) && !options.rerun
          ? "already-scored"
          : "budget",
  }));

if (options.dryRun) {
  const preview = {
    searchSpaceId: searchSpace.id,
    maxRuns,
    selected: selected.map((candidate) => candidate.id),
    skipped,
  };
  console.log(JSON.stringify(preview, null, 2));
  process.exit(0);
}

runCommand(config.metric.validationCommand);
runCommand(config.metric.smokeCommand);

const executed: Array<{
  candidateId: string;
  runName: string;
  decision: string;
  weightedScore: number;
}> = [];

for (const candidate of selected) {
  const runName = `auto-${candidate.id}`;
  runCommand(
    `bun run research:finetune:autonomous:run-candidate ${candidate.id}`
  );
  runCommand(`bun run research:finetune:autonomous:evaluate ${runName}`);

  const rows = await collectLeaderboardRows(repoRoot);
  const row = rows.find((item) => item.candidateId === candidate.id);
  executed.push({
    candidateId: candidate.id,
    runName,
    decision: row?.decision ?? "pending",
    weightedScore: row?.weightedScore ?? Number.NEGATIVE_INFINITY,
  });
}

const leaderboard = await collectLeaderboardRows(repoRoot);
const bestKeep = pickBestKeepCandidate(leaderboard);
const sessionArtifact = {
  searchSpaceId: searchSpace.id,
  startedAt: new Date().toISOString(),
  maxRuns,
  executed,
  skipped,
  bestKeep,
};

const sessionPath = join(
  repoRoot,
  "research/finetune/autonomous/runs",
  `search-session-${timestampForPath()}.json`
);
await Bun.write(sessionPath, `${JSON.stringify(sessionArtifact, null, 2)}\n`);

console.log(
  JSON.stringify(
    {
      sessionPath,
      executed: executed.map((item) => item.candidateId),
      bestKeep,
    },
    null,
    2
  )
);

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    candidateIds: [],
    dryRun: false,
    rerun: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--rerun") {
      options.rerun = true;
      continue;
    }
    if (arg === "--limit") {
      const raw = args[index + 1];
      if (!raw) {
        throw new Error("--limit requires a number");
      }
      options.limit = Number.parseInt(raw, 10);
      index += 1;
      continue;
    }
    options.candidateIds.push(arg);
  }

  return options;
}

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

function timestampForPath(): string {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}
