import type { AcceptanceComparison } from "./compare";
import type { AcceptanceManifest } from "./manifest";
import type { AcceptanceRecord } from "./records";
import type { ResourceSample } from "./resources";

export type LatencyState =
  | "fresh-process"
  | "resident-model-cold"
  | "warm"
  | "post-idle";
export type Side = "baseline" | "candidate";
export interface SessionProcessIdentity {
  pid: number;
  runId: string;
  sourceRoot: string;
  startedAt?: string;
  directory: string;
  preflightMs?: number;
}
export interface RunSample {
  block: number;
  state: LatencyState;
  side: Side;
  order: Side[];
  caseId: string;
  durationMs: number | null;
  stages: Record<string, number>;
  record: AcceptanceRecord | null;
  resources: ResourceSample[];
  overlap: {
    kind: "two-owned-sessions";
    caseId: string;
    processId: number;
    processIdentity: SessionProcessIdentity | null;
    durationMs: number;
    overlappingMs: number;
    record: AcceptanceRecord;
  } | null;
  beforeIdle: ResourceSample | null;
  afterIdle: ResourceSample | null;
  processId: number | null;
  processIdentity: SessionProcessIdentity | null;
  modelStateBefore: boolean | null;
  primerCaseId: string | null;
  idleMs: number;
  errors: string[];
  caveats: string[];
}
export interface Distribution {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  p99Label: "empirical" | "insufficient-samples";
  min: number | null;
  max: number | null;
}
export function distribution(values: number[]): Distribution {
  const sorted = values
    .filter((n) => Number.isFinite(n) && n >= 0)
    .toSorted((a, b) => a - b);
  const percentile = (p: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
  return {
    count: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: sorted.length >= 100 ? percentile(0.99) : null,
    p99Label: sorted.length >= 100 ? "empirical" : "insufficient-samples",
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
  };
}
export interface PairedReport {
  baseline: AcceptanceManifest;
  candidate: AcceptanceManifest;
  seed: number;
  samples: RunSample[];
  comparisons: Array<{
    block: number;
    state: LatencyState;
    result: AcceptanceComparison;
  }>;
  status: "screened" | "incomplete" | "inconclusive" | "quality-failed";
  caveats: string[];
  summaries: Array<{
    state: LatencyState;
    caseId: string;
    baseline: Distribution;
    candidate: Distribution;
    pairedDeltaMs: number[];
    slowerBlocks: number[];
    status: "screened" | "inconclusive";
    reasons: string[];
  }>;
}

/** Never publish performance summaries until every quality comparison passes. */
export function summarizeReport(
  report: PairedReport,
  states: LatencyState[],
  observations: number
): PairedReport {
  if (report.comparisons.some((entry) => !entry.result.passed)) {
    report.status = "quality-failed";
    return report;
  }
  if (
    report.samples.some(
      (sample) => sample.errors.length || sample.durationMs === null
    )
  ) {
    report.status = "incomplete";
    return report;
  }
  report.status = "screened";
  for (const state of states)
    for (const item of report.baseline.cases) {
      const rows = report.samples.filter(
        (sample) => sample.state === state && sample.caseId === item.caseId
      );
      const baseline = rows.filter((sample) => sample.side === "baseline");
      const candidate = rows.filter((sample) => sample.side === "candidate");
      const deltas: number[] = [];
      const slowerBlocks: number[] = [];
      for (const a of baseline) {
        const b = candidate.find((sample) => sample.block === a.block);
        if (
          a.durationMs !== null &&
          b?.durationMs !== null &&
          b?.durationMs !== undefined
        ) {
          const delta = b.durationMs - a.durationMs;
          deltas.push(delta);
          if (delta > 0) slowerBlocks.push(a.block);
        }
      }
      const reasons: string[] = [];
      if (deltas.length < Math.max(30, observations))
        reasons.push(
          "Insufficient paired observations: screening requires at least 30 per case/state"
        );
      if (rows.some((row) => row.caveats.length))
        reasons.push("Reported host load or measurement caveat");
      const a = distribution(
        baseline.flatMap((row) =>
          row.durationMs === null ? [] : [row.durationMs]
        )
      );
      const b = distribution(
        candidate.flatMap((row) =>
          row.durationMs === null ? [] : [row.durationMs]
        )
      );
      // A declared screening heuristic, not an equivalence or regression threshold.
      if (
        [a, b].some(
          (d) =>
            d.p50 !== null && d.p95 !== null && d.p95 > Math.max(1, d.p50) * 2
        )
      )
        reasons.push("Noisy screen: p95 exceeds twice p50");
      if (reasons.length) report.status = "inconclusive";
      report.summaries.push({
        state,
        caseId: item.caseId,
        baseline: a,
        candidate: b,
        pairedDeltaMs: deltas,
        slowerBlocks,
        status: reasons.length ? "inconclusive" : "screened",
        reasons,
      });
    }
  return report;
}
