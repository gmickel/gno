/** Deterministic performance protocol for the File Provider smoke harness. */

// node:fs/promises — owned temp-corpus structure and exact cleanup; no Bun equivalent
import { mkdir, mkdtemp, rm } from "node:fs/promises";
// node:os — Bun has no temporary-directory helper
import { tmpdir } from "node:os";
// node:path — Bun has no path utilities
import { join } from "node:path";

import {
  INTERMEDIATE_DIR_CAVEAT,
  loadAvailabilityObserver,
  loadIoPolicyPort,
  readContentUnderActivePolicy,
  type AvailabilityObserver,
  type IoPolicyPort,
  type ProviderLabel,
  redactToken,
  withNoMaterializePolicy,
} from "./macos-file-provider-smoke-lib";
import { listFixtureFiles } from "./macos-file-provider-smoke-ops";

export const WARMUP_COUNT = 2;
export const SAMPLE_COUNT = 9;

export type SampleSummary = {
  rawMs: number[];
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  stddevMs: number;
};

export type ContaminatedSample = { index: number; reason: string };

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

async function measureLane(
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

async function discoverLikeCurrentWalker(
  corpusRoot: string
): Promise<string[]> {
  const matches: string[] = [];
  const glob = new Bun.Glob("**/*");
  for await (const match of glob.scan({
    cwd: corpusRoot,
    absolute: true,
    onlyFiles: true,
    followSymlinks: false,
  })) {
    await Bun.file(match).stat();
    matches.push(match);
  }
  return matches.sort();
}

export async function runAllLocalBenchmark(options: {
  corpusRoot: string;
  observer?: AvailabilityObserver | null;
  policy?: IoPolicyPort | null;
  provider?: { label: ProviderLabel | "local"; version: string };
  environment?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const files = await listFixtureFiles(options.corpusRoot);
  const expectedCount = files.length;
  const observer = options.observer ?? loadAvailabilityObserver();
  const policy = options.policy ?? loadIoPolicyPort();
  const runOrder = [
    "discovery-traversal-baseline",
    "availability-metadata",
    "candidate-discovery-plus-availability",
    "guarded-read-hash",
  ] as const;

  const discovery = await measureLane(async () => {
    const found = await discoverLikeCurrentWalker(options.corpusRoot);
    return found.length === expectedCount
      ? {}
      : { contaminated: "fixture_drift_file_count" };
  });

  const availability = await measureLane(async () => {
    if (!observer) {
      return { contaminated: "observer_unavailable" };
    }
    for (const file of files) {
      const snapshot = observer.observe(file);
      if (!snapshot.ok) {
        return { contaminated: "metadata_observe_failed" };
      }
      if (snapshot.dataless === true) {
        return { contaminated: "unexpected_dataless_on_all_local_corpus" };
      }
    }
    return {};
  });

  const candidate = await measureLane(async () => {
    if (!observer) {
      return { contaminated: "observer_unavailable" };
    }
    const found = await discoverLikeCurrentWalker(options.corpusRoot);
    if (found.length !== expectedCount) {
      return { contaminated: "fixture_drift_file_count" };
    }
    for (const file of found) {
      const snapshot = observer.observe(file);
      if (!snapshot.ok) {
        return { contaminated: "metadata_observe_failed" };
      }
      if (snapshot.dataless === true) {
        return { contaminated: "unexpected_dataless_on_all_local_corpus" };
      }
    }
    return {};
  });

  const guarded = await measureLane(async () => {
    if (files.length === 0) {
      return { contaminated: "empty_corpus" };
    }
    const wrapped = await withNoMaterializePolicy(async () => {
      for (const target of files) {
        const read = readContentUnderActivePolicy(target, policy);
        if (!read.ok || !read.digest) {
          return { contaminated: `guarded_read_${read.classification}` };
        }
      }
      return {};
    }, policy);
    return wrapped.ok ? wrapped.value : { contaminated: wrapped.error };
  });

  const baselineMedian = discovery.summary.medianMs;
  const candidateMedian = candidate.summary.medianMs;
  const overheadPercent =
    baselineMedian === 0
      ? null
      : Number(
          (((candidateMedian - baselineMedian) / baselineMedian) * 100).toFixed(
            4
          )
        );
  const lane = (
    label: string,
    measured: { summary: SampleSummary; contaminated: ContaminatedSample[] },
    extra: Record<string, unknown> = {}
  ) => ({
    label,
    kind: "measured",
    ...measured.summary,
    contaminated: measured.contaminated,
    ...extra,
  });

  return {
    action: "benchmark",
    environment: {
      platform: process.platform,
      bun: Bun.version,
      arch: process.arch,
      policyScope: "process",
      policyScopeReason:
        "async Bun I/O may escape thread scope; smoke uses process scope",
      ...options.environment,
    },
    provider: options.provider ?? { label: "local", version: "n/a" },
    corpus: {
      root: redactToken(options.corpusRoot),
      fileCount: expectedCount,
      shape: "deterministic-fn118-all-local-flat",
    },
    protocol: {
      warmups: WARMUP_COUNT,
      samplesPerLane: SAMPLE_COUNT,
      runOrder,
      complete:
        discovery.summary.rawMs.length === SAMPLE_COUNT &&
        availability.summary.rawMs.length === SAMPLE_COUNT &&
        candidate.summary.rawMs.length === SAMPLE_COUNT &&
        guarded.summary.rawMs.length === SAMPLE_COUNT,
    },
    lanes: {
      "discovery-traversal-baseline": lane(
        "current walker-like discovery/traversal + metadata stat",
        discovery
      ),
      "availability-metadata": lane(
        "availability metadata (SF_DATALESS observer)",
        availability,
        {
          observerKind: observer?.kind ?? null,
          intermediateDirectoryCaveat:
            observer?.intermediateDirectoryCaveat ?? INTERMEDIATE_DIR_CAVEAT,
        }
      ),
      "candidate-discovery-plus-availability": lane(
        "candidate discovery + availability metadata",
        candidate
      ),
      "guarded-read-hash": lane("guarded read/hash", guarded),
      conversion: {
        kind: "not-applicable",
        reason: "Markdown fixture corpus requires no conversion",
      },
      embedding: {
        kind: "not-applicable",
        reason:
          "pre-implementation smoke does not invoke models or production ingestion",
      },
    },
    comparison: {
      baselineLane: "discovery-traversal-baseline",
      candidate: "candidate-discovery-plus-availability",
      baselineMedianMs: baselineMedian,
      candidateMedianMs: candidateMedian,
      overheadPercent,
    },
  };
}

export async function runOwnedLocalBenchmark(options: {
  fileCount: number;
  environment?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  if (
    !Number.isSafeInteger(options.fileCount) ||
    options.fileCount < 1_000 ||
    options.fileCount > 10_000
  ) {
    throw new Error("invalid --corpus-files (expected 1000..10000)");
  }
  const parent = await mkdtemp(join(tmpdir(), "gno-fn118-local-benchmark-"));
  const corpusRoot = join(parent, "GNO-fn118-smoke-controlled-local");
  try {
    await mkdir(corpusRoot);
    await Promise.all(
      Array.from({ length: options.fileCount }, (_, index) => {
        const name = `note-${String(index).padStart(5, "0")}.md`;
        return Bun.write(join(corpusRoot, name), `fixture-${index}\n`);
      })
    );
    return await runAllLocalBenchmark({
      corpusRoot,
      provider: { label: "local", version: "n/a" },
      environment: options.environment,
    });
  } finally {
    // Exact mkdtemp-owned parent only; never a provider root or user directory.
    await rm(parent, { recursive: true });
  }
}
