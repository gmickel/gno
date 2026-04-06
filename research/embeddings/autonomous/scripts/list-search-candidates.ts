#!/usr/bin/env bun
import { join } from "node:path";

import { collectLeaderboardRows, loadSearchSpace } from "../lib/results";

const repoRoot = join(import.meta.dir, "../../../..");
const searchSpace = await loadSearchSpace(repoRoot);
const leaderboard = await collectLeaderboardRows(repoRoot);
const byCandidateId = new Map(
  leaderboard.map((row) => [row.candidateId, row] as const)
);

console.log(`# ${searchSpace.id}`);
for (const candidate of searchSpace.candidates) {
  const row = byCandidateId.get(candidate.id);
  const status = row?.decision ?? "pending";
  const score =
    row && Number.isFinite(row.weightedScore)
      ? ` score=${row.weightedScore.toFixed(2)}`
      : "";
  console.log(
    `- ${candidate.id}: status=${status}${score}, runtime=${candidate.runtime.kind}, uri=${candidate.runtime.uri}`
  );
}
