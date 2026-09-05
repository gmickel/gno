/** Frozen reranker schedule and exact fn-143 records. No native allocation here. */
import type { RerankScore } from "../../src/llm/types";
import type { AcceptanceManifest } from "./manifest";
import type { AcceptanceRecord } from "./records";

import { canonicalFingerprint } from "../agentic/canonical";
import fixtures from "../fixtures/acceptance/rerank-long-input/fixtures.json";
import longQuery from "../fixtures/acceptance/rerank-long-input/long-query.json";
import pins from "../fixtures/acceptance/rerank-long-input/manifest.json";
import historical from "../fixtures/acceptance/rerank-long-input/results.json";
import scenarioPins from "../fixtures/acceptance/rerank-long-input/scenario-manifest.json";
import { compareAcceptance } from "./compare";
import { acceptanceManifestFingerprint } from "./manifest";

export interface RerankScenario {
  caseId: string;
  fixtureId: string;
  query: string;
  documents: string[];
  order: ("baseline" | "candidate")[];
  transition: "retain" | "restart" | "unsupported-template";
  historicalScores: number[] | null;
  formattedTokens: number | null;
}

/** The 69 rows retain audit ordering, repeats and original prepared strings.
 * Custom chunks above 4000 chars were already clipped by preparation; ordinary
 * 1000/4000-char cases are intact. This schedule never clips any further.
 */
export function rerankScenarios(): RerankScenario[] {
  const rows: RerankScenario[] = historical.records.map((row) => {
    const fixture = fixtures.find((item) => item.id === row.id);
    if (!fixture) throw new Error(`Missing frozen fixture ${row.id}`);
    return {
      caseId: `${row.id}-repeat-${row.repeat}`,
      fixtureId: row.id,
      query: fixture.query,
      documents: [...fixture.texts],
      order: row.order.map((side) => (side === "A" ? "baseline" : "candidate")),
      transition: "retain",
      historicalScores: [...row.arms.A.scores],
      formattedTokens: row.req,
    };
  });
  const short = fixtures[0];
  if (!short) throw new Error("Missing short fixture");
  const additions: Pick<
    RerankScenario,
    "caseId" | "query" | "documents" | "transition" | "formattedTokens"
  >[] = [
    {
      caseId: "long-query-full-pair",
      query: longQuery.query,
      documents: [longQuery.document],
      transition: "retain",
      formattedTokens: longQuery.auditedFormattedTokens,
    },
    {
      caseId: "shrink-after-long-query",
      query: short.query,
      documents: [...short.texts],
      transition: "retain",
      formattedTokens: 211,
    },
    {
      caseId: "duplicate-ties",
      query: short.query,
      documents: [short.texts[0]!, short.texts[0]!],
      transition: "retain",
      formattedTokens: 211,
    },
    {
      caseId: "unsupported-template",
      query: short.query,
      documents: [...short.texts],
      transition: "unsupported-template",
      formattedTokens: null,
    },
    {
      caseId: "restart-short",
      query: short.query,
      documents: [...short.texts],
      transition: "restart",
      formattedTokens: 211,
    },
  ];
  return rows.concat(
    additions.map((item) => ({
      ...item,
      fixtureId: item.caseId,
      order: ["baseline", "candidate"],
      historicalScores: null,
    }))
  );
}

export async function verifyRerankFixturePins(): Promise<void> {
  if (canonicalFingerprint(rerankScenarios()) !== scenarioPins.scheduleSha256)
    throw new Error("Frozen scenario schedule changed");
  for (const [name, expected] of Object.entries(pins)) {
    const bytes = await Bun.file(
      new URL(
        `../fixtures/acceptance/rerank-long-input/${name}`,
        import.meta.url
      )
    ).arrayBuffer();
    if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== expected)
      throw new Error(`Frozen fixture changed: ${name}`);
  }
}

export interface RerankObservation {
  scores: RerankScore[];
  /** Captured at native _getEvaluationInput, not reconstructed by the oracle. */
  tokens: number[][];
  query: string;
  documents: string[];
  durationMs: number;
  backend: string;
}

/** Executors own their native process. stop must terminate only that owned
 * workload; a deadline ends the schedule, never starts the next GPU workload.
 * Each successful row is checkpointed before advancing, preserving partial QA.
 */
export async function runRerankScenarioSchedule(options: {
  execute: (
    side: "baseline" | "candidate",
    scenario: RerankScenario,
    signal: AbortSignal
  ) => Promise<RerankObservation>;
  checkpoint: (
    side: "baseline" | "candidate",
    scenario: RerankScenario,
    observation: RerankObservation
  ) => Promise<void>;
  stop: () => Promise<void>;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("Invalid scenario timeout");
  try {
    for (const scenario of rerankScenarios()) {
      for (const side of scenario.order) {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const observation = await Promise.race([
            options.execute(side, scenario, controller.signal),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(
                  new Error(`Scenario timeout: ${side}:${scenario.caseId}`)
                );
              }, timeoutMs);
            }),
          ]);
          await options.checkpoint(side, scenario, observation);
        } finally {
          clearTimeout(timer);
        }
      }
    }
  } finally {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        options.stop(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Owned workload cleanup timeout; do not reuse GPU slot"
                )
              ),
            2000
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function rerankRecord(
  manifest: AcceptanceManifest,
  scenario: RerankScenario,
  observation: RerankObservation
): AcceptanceRecord {
  const model = manifest.models.find((item) => item.role === "reranking");
  if (!model) throw new Error("Missing reranking model pin");
  const complete =
    observation.scores.length === scenario.documents.length &&
    observation.tokens.length === scenario.documents.length &&
    new Set(observation.scores.map((item) => item.index)).size ===
      scenario.documents.length &&
    observation.scores.every(
      (item, rank) =>
        Number.isInteger(item.index) &&
        item.index >= 0 &&
        item.index < scenario.documents.length &&
        Number.isFinite(item.score) &&
        item.rank === rank + 1
    ) &&
    observation.tokens.every(
      (tokens) =>
        tokens.length > 0 &&
        tokens.every((token) => Number.isInteger(token) && token >= 0)
    );
  if (!complete) throw new Error("Incomplete or invalid native scoring");
  return {
    schemaVersion: "gno-acceptance-v1",
    manifestSha256: acceptanceManifestFingerprint(manifest),
    caseId: scenario.caseId,
    deterministic: {
      scope: { fixtureId: scenario.fixtureId },
      results: observation.scores.map((item) => ({
        uri: `gno://rerank/${item.index}`,
        score: item.score,
        scores: { rank: item.rank },
        passage: null,
        provenance: { index: item.index },
      })),
      citations: [],
      modelInputs: [
        {
          role: "reranking",
          modelId: model.id,
          input: {
            query: observation.query,
            documents: observation.documents,
            tokens: observation.tokens,
          },
        },
      ],
      semanticState: {
        status: "ok",
        vectorsUsed: false,
        vectorStatus: "not-requested",
        error: null,
        fallbacks: [],
        verification: null,
      },
    },
    generatedAnswer: null,
    transport: { durationMs: observation.durationMs },
  };
}

/** Compare all observations, retaining slower pairs and historical drift. Native
 * coverage is separate: historical or mock replay can never establish it.
 */
export function compareRerankScenarios(
  manifests: Record<"baseline" | "candidate", AcceptanceManifest>,
  observations: Record<"baseline" | "candidate", RerankObservation[]>
) {
  const schedule = rerankScenarios();
  const records = (side: "baseline" | "candidate") =>
    observations[side].map((observation, index) => {
      const scenario = schedule[index];
      if (!scenario) throw new Error("Unexpected observation");
      return rerankRecord(manifests[side], scenario, observation);
    });
  const comparison = compareAcceptance(
    manifests.baseline,
    manifests.candidate,
    records("baseline"),
    records("candidate")
  );
  const historicalDrift: string[] = [];
  const orderDrift: string[] = [];
  const inputDrift: string[] = [];
  const slowerPairs: string[] = [];
  for (const [index, scenario] of schedule.entries()) {
    for (const side of ["baseline", "candidate"] as const) {
      const observation = observations[side][index];
      if (!observation) continue;
      if (
        observation.query !== scenario.query ||
        JSON.stringify(observation.documents) !==
          JSON.stringify(scenario.documents) ||
        (scenario.formattedTokens !== null &&
          Math.max(...observation.tokens.map((tokens) => tokens.length)) !==
            scenario.formattedTokens)
      )
        inputDrift.push(`${side}:${scenario.caseId}`);
      const originalOrder = [...observation.scores]
        .sort((a, b) => a.index - b.index)
        .map((item) => item.score);
      const expectedOrder = originalOrder
        .map((score, candidateIndex) => ({ score, index: candidateIndex }))
        .sort((a, b) => b.score - a.score)
        .map((item) => item.index);
      if (
        JSON.stringify(observation.scores.map((item) => item.index)) !==
        JSON.stringify(expectedOrder)
      )
        orderDrift.push(`${side}:${scenario.caseId}`);
      if (
        scenario.historicalScores &&
        JSON.stringify(originalOrder) !==
          JSON.stringify(scenario.historicalScores)
      )
        historicalDrift.push(`${side}:${scenario.caseId}`);
    }
    const a = observations.baseline[index];
    const b = observations.candidate[index];
    if (a && b && b.durationMs > a.durationMs)
      slowerPairs.push(scenario.caseId);
  }
  return {
    comparison,
    historicalDrift,
    orderDrift,
    inputDrift,
    slowerPairs,
    passed:
      comparison.passed &&
      historicalDrift.length === 0 &&
      inputDrift.length === 0 &&
      orderDrift.length === 0,
  };
}
