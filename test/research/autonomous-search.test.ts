import { describe, expect, test } from "bun:test";

import {
  pickBestKeepCandidate,
  selectCandidates,
  type CandidateSpec,
  type LeaderboardRow,
} from "../../research/finetune/autonomous/lib/results";

const candidates: CandidateSpec[] = [
  {
    id: "a",
    mix: "research/finetune/configs/training-mix.json",
    promptProfile:
      "research/finetune/configs/prompt-profiles/entity-lock-v1.json",
    learningRate: 1e-5,
  },
  {
    id: "b",
    mix: "research/finetune/configs/mixes/balanced-retrieval-v2.json",
    promptProfile:
      "research/finetune/configs/prompt-profiles/strict-json-v2.json",
    learningRate: 1e-5,
  },
  {
    id: "c",
    mix: "research/finetune/configs/mixes/qmd-majority.json",
    promptProfile:
      "research/finetune/configs/prompt-profiles/entity-lock-v1.json",
    learningRate: 9.5e-6,
  },
];

describe("autonomous search helpers", () => {
  test("selectCandidates skips already-scored candidates by default", () => {
    const selected = selectCandidates({
      candidates,
      completedCandidateIds: new Set(["a", "c"]),
      maxRuns: 2,
    });

    expect(selected.map((candidate) => candidate.id)).toEqual(["b"]);
  });

  test("selectCandidates respects requested ids and rerun mode", () => {
    const selected = selectCandidates({
      candidates,
      completedCandidateIds: new Set(["a"]),
      requestedCandidateIds: new Set(["a", "c"]),
      includeCompleted: true,
      maxRuns: 2,
    });

    expect(selected.map((candidate) => candidate.id)).toEqual(["a", "c"]);
  });

  test("pickBestKeepCandidate prefers weighted score, then retrieval", () => {
    const rows: LeaderboardRow[] = [
      {
        runName: "auto-a",
        candidateId: "a",
        ndcgAt10: 0.918,
        askRecallAt5: 0.875,
        schemaSuccessRate: 1,
        p95Ms: 4100,
        decision: "keep",
        weightedScore: 80,
      },
      {
        runName: "auto-b",
        candidateId: "b",
        ndcgAt10: 0.919,
        askRecallAt5: 0.8125,
        schemaSuccessRate: 1,
        p95Ms: 3900,
        decision: "discard",
        weightedScore: 120,
      },
      {
        runName: "auto-c",
        candidateId: "c",
        ndcgAt10: 0.917,
        askRecallAt5: 0.875,
        schemaSuccessRate: 1,
        p95Ms: 4300,
        decision: "keep",
        weightedScore: 95,
      },
    ];

    expect(pickBestKeepCandidate(rows)?.candidateId).toBe("c");
  });
});
