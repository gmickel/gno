/** Shared sample statistics for the File Provider physical benchmark. */

export const WARMUP_COUNT = 2;
export const SAMPLE_COUNT = 9;
export const ANY_REGRESSION_THRESHOLD_PERCENT = 3;
export const LOCAL_OVERHEAD_THRESHOLD_PERCENT = 10;

export type SampleSummary = {
  rawMs: number[];
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  stddevMs: number;
};

export type ContaminatedSample = { index: number; reason: string };

export type ThresholdComparison = {
  baselineMedianMs: number;
  candidateMedianMs: number;
  overheadPercent: number | null;
  thresholdPercent: number;
  passes: boolean | null;
  status: "pass" | "fail" | "indeterminate" | "pending-host-measurement";
};

export function percentOverhead(
  candidateMedianMs: number,
  baselineMedianMs: number
): number | null {
  if (baselineMedianMs === 0) {
    return null;
  }
  return Number(
    (((candidateMedianMs - baselineMedianMs) / baselineMedianMs) * 100).toFixed(
      4
    )
  );
}

export function compareAgainstThreshold(
  candidateMedianMs: number,
  baselineMedianMs: number,
  thresholdPercent: number
): ThresholdComparison {
  const overheadPercent = percentOverhead(candidateMedianMs, baselineMedianMs);
  if (overheadPercent === null) {
    return {
      baselineMedianMs,
      candidateMedianMs,
      overheadPercent: null,
      thresholdPercent,
      passes: null,
      status: "indeterminate",
    };
  }
  const passes = overheadPercent <= thresholdPercent;
  return {
    baselineMedianMs,
    candidateMedianMs,
    overheadPercent,
    thresholdPercent,
    passes,
    status: passes ? "pass" : "fail",
  };
}

export function summarizeSamples(samples: number[]): SampleSummary {
  if (samples.length === 0) {
    return {
      rawMs: [],
      medianMs: 0,
      p95Ms: 0,
      minMs: 0,
      maxMs: 0,
      stddevMs: 0,
    };
  }
  const ordered = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  const median =
    ordered.length % 2 === 0
      ? ((ordered[mid - 1] ?? 0) + (ordered[mid] ?? 0)) / 2
      : (ordered[mid] ?? 0);
  const p95 = ordered[Math.ceil(ordered.length * 0.95) - 1] ?? 0;
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance =
    samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    samples.length;
  return {
    rawMs: samples.map((value) => Number(value.toFixed(4))),
    medianMs: Number(median.toFixed(4)),
    p95Ms: Number(p95.toFixed(4)),
    minMs: Number((ordered[0] ?? 0).toFixed(4)),
    maxMs: Number((ordered.at(-1) ?? 0).toFixed(4)),
    stddevMs: Number(Math.sqrt(variance).toFixed(4)),
  };
}

export async function measureLane(
  runOnce: () => Promise<{ contaminated?: string }>
): Promise<{ summary: SampleSummary; contaminated: ContaminatedSample[] }> {
  const measured: number[] = [];
  const contaminated: ContaminatedSample[] = [];
  let warmups = 0;
  let attempts = 0;
  const maxAttempts = WARMUP_COUNT + SAMPLE_COUNT * 2;
  while (warmups < WARMUP_COUNT || measured.length < SAMPLE_COUNT) {
    if (attempts >= maxAttempts) {
      break;
    }
    const started = performance.now();
    const result = await runOnce();
    const elapsed = performance.now() - started;
    attempts += 1;
    if (warmups < WARMUP_COUNT) {
      warmups += 1;
      continue;
    }
    const index = measured.length + contaminated.length;
    if (result.contaminated) {
      contaminated.push({ index, reason: result.contaminated });
    } else {
      measured.push(elapsed);
    }
  }
  return { summary: summarizeSamples(measured), contaminated };
}
