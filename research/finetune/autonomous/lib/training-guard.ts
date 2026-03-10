import type { ValCheckpointRecord } from "../../lib/run-selection";

export interface EarlyStopGuard {
  enabled: boolean;
  minIteration: number;
  maxBestValLoss: number;
  maxValLossDelta?: number;
  referenceBestValLoss?: number;
}

export interface EarlyStopDecision {
  stop: boolean;
  bestValLoss: number;
  threshold: number;
  iteration?: number;
  reason?: string;
}

export function shouldEarlyStop(
  records: ValCheckpointRecord[],
  guard?: EarlyStopGuard
): EarlyStopDecision {
  if (!guard?.enabled || records.length === 0) {
    return {
      stop: false,
      bestValLoss: Number.POSITIVE_INFINITY,
      threshold: Number.POSITIVE_INFINITY,
    };
  }

  const eligible = records.filter(
    (record) => record.iteration >= guard.minIteration
  );
  const bestValLoss = Math.min(...records.map((record) => record.valLoss));
  const threshold = buildThreshold(guard);
  if (eligible.length === 0) {
    return {
      stop: false,
      bestValLoss,
      threshold,
    };
  }

  if (bestValLoss > threshold) {
    const latest = eligible.at(-1);
    return {
      stop: true,
      bestValLoss,
      threshold,
      iteration: latest?.iteration,
      reason: `best val ${bestValLoss.toFixed(3)} > threshold ${threshold.toFixed(3)} after iter ${latest?.iteration ?? guard.minIteration}`,
    };
  }

  return {
    stop: false,
    bestValLoss,
    threshold,
  };
}

function buildThreshold(guard: EarlyStopGuard): number {
  if (
    guard.referenceBestValLoss === undefined ||
    guard.maxValLossDelta === undefined
  ) {
    return guard.maxBestValLoss;
  }
  return Math.min(
    guard.maxBestValLoss,
    guard.referenceBestValLoss + guard.maxValLossDelta
  );
}
