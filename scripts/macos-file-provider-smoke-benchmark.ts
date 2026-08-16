/**
 * Physical performance protocol for shipped sourceAvailability any|local.
 *
 * Measures production FileWalker + hierarchical directory classification +
 * guarded content boundary — not the rejected naive per-discovered-file
 * availability pass measured at +15.2323% pre-implementation.
 */

// node:fs/promises — owned temp-corpus structure and exact cleanup; no Bun equivalent
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
// node:os — Bun has no temporary-directory helper
import { tmpdir } from "node:os";
// node:path — Bun has no path utilities
import { join } from "node:path";

import {
  createDirectoryAvailability,
  createSourceContentReader,
  memoizeDirectoryAvailability,
  type DirectoryAvailabilityPort,
  type DirectoryAvailabilityResult,
  type SourceContentReaderPort,
} from "../src/ingestion/source-availability";
import { FileWalker } from "../src/ingestion/walker";
import {
  ANY_REGRESSION_THRESHOLD_PERCENT,
  compareAgainstThreshold,
  type ContaminatedSample,
  LOCAL_OVERHEAD_THRESHOLD_PERCENT,
  measureLane,
  SAMPLE_COUNT,
  type SampleSummary,
  WARMUP_COUNT,
} from "./macos-file-provider-benchmark-stats";
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

export {
  ANY_REGRESSION_THRESHOLD_PERCENT,
  compareAgainstThreshold,
  LOCAL_OVERHEAD_THRESHOLD_PERCENT,
  percentOverhead,
  SAMPLE_COUNT,
  summarizeSamples,
  WARMUP_COUNT,
} from "./macos-file-provider-benchmark-stats";

/**
 * Pre-implementation discovery baseline from the task-1 controlled corpus
 * (`research/file-provider/evidence/2026-08-16-performance.json`). Host re-runs
 * and inserts post-implementation measured values; this constant is the
 * regression anchor only.
 */
export const PRE_IMPLEMENTATION_BASELINE = {
  capturedAt: "2026-08-16",
  evidencePath: "research/file-provider/evidence/2026-08-16-performance.json",
  lane: "discovery-traversal-baseline",
  medianMs: 71.8915,
  p95Ms: 73.4625,
  /** Rejected naive candidate (extra availability check per discovered file). */
  rejectedNaiveCandidateMedianMs: 82.8422,
  rejectedNaiveOverheadPercent: 15.2323,
} as const;

/** Exact task-1 discovery/traversal protocol used for the <=3% regression gate. */
async function discoverTaskOneProtocol(corpusRoot: string): Promise<number> {
  let count = 0;
  const glob = new Bun.Glob("**/*");
  for await (const match of glob.scan({
    cwd: corpusRoot,
    absolute: true,
    onlyFiles: true,
    followSymlinks: false,
  })) {
    await Bun.file(match).stat();
    count += 1;
  }
  return count;
}

/**
 * Counting wrapper proving local mode classifies directories, not every file.
 * Production uses memoizeDirectoryAvailability; this only instruments calls.
 */
export function instrumentDirectoryAvailability(
  port: DirectoryAvailabilityPort
): {
  port: DirectoryAvailabilityPort;
  getCallCount: () => number;
  getUniquePaths: () => number;
  reset: () => void;
} {
  let callCount = 0;
  const unique = new Set<string>();
  return {
    port: {
      mode: port.mode,
      classify: async (
        absPath: string
      ): Promise<DirectoryAvailabilityResult> => {
        callCount += 1;
        unique.add(absPath);
        return port.classify(absPath);
      },
      readDirectory: (absPath, read) => {
        callCount += 1;
        unique.add(absPath);
        return port.readDirectory(absPath, read);
      },
    },
    getCallCount: () => callCount,
    getUniquePaths: () => unique.size,
    reset: () => {
      callCount = 0;
      unique.clear();
    },
  };
}

/**
 * Owned controlled corpus is not under an evidenced File Provider layout.
 * Production still fail-closes those paths; the mechanism-cost lanes inject
 * this pathSupport so hierarchical SF_DATALESS classification and guarded
 * reads actually run on the all-local corpus (R6 cost measurement).
 */
const BENCHMARK_PATH_SUPPORT = (): "icloud-drive" => "icloud-drive";

function walkConfig(
  root: string,
  sourceAvailability: "any" | "local",
  directoryAvailability?: DirectoryAvailabilityPort
) {
  return {
    root,
    pattern: "**/*",
    include: [] as string[],
    exclude: [] as string[],
    maxBytes: 50 * 1024 * 1024,
    sourceAvailability,
    ...(directoryAvailability ? { directoryAvailability } : {}),
  };
}

async function walkShipped(
  walker: FileWalker,
  root: string,
  sourceAvailability: "any" | "local",
  directoryAvailability?: DirectoryAvailabilityPort
): Promise<{ entryCount: number; skippedCount: number }> {
  const { entries, skipped } = await walker.walk(
    walkConfig(root, sourceAvailability, directoryAvailability)
  );
  return { entryCount: entries.length, skippedCount: skipped.length };
}

async function countDirectories(root: string): Promise<number> {
  let count = 1; // root
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.pop() as string;
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (dirent.isDirectory() && !dirent.isSymbolicLink()) {
        count += 1;
        queue.push(join(dir, dirent.name));
      }
    }
  }
  return count;
}

function hashBytes(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function sniffReadHash(
  files: string[],
  reader: SourceContentReaderPort
): Promise<{ ok: boolean; reason?: string }> {
  for (const file of files) {
    const read = await reader.readAll(file);
    if (!read.ok) {
      return { ok: false, reason: `read_${read.code}` };
    }
    if (read.bytes.byteLength === 0) {
      return { ok: false, reason: "empty_read" };
    }
    hashBytes(read.bytes);
  }
  return { ok: true };
}

/**
 * Shipped-design all-local benchmark (any vs local hierarchical).
 * Does not measure the rejected naive per-file availability candidate.
 */
export async function runShippedDesignBenchmark(options: {
  corpusRoot: string;
  expectedFileCount: number;
  observer?: AvailabilityObserver | null;
  policy?: IoPolicyPort | null;
  provider?: { label: ProviderLabel | "local"; version: string };
  environment?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const walker = new FileWalker();
  const files = await listFixtureFiles(options.corpusRoot);
  const expectedCount = options.expectedFileCount;
  if (files.length !== expectedCount) {
    throw new Error(
      `fixture_drift_file_count: found=${files.length} expected=${expectedCount}`
    );
  }
  const directoryCount = await countDirectories(options.corpusRoot);
  const observer = options.observer ?? loadAvailabilityObserver();
  const policy = options.policy ?? loadIoPolicyPort();

  const runOrder = [
    "task1-protocol-any-regression",
    "any-discovery-traversal",
    "local-discovery-traversal",
    "availability-metadata-hierarchical",
    "sniff-read-hash-any",
    "sniff-read-hash-local",
    "conversion",
    "embedding",
  ] as const;

  // Exact re-run of task 1's baseline lane. This is the only valid comparison
  // with the recorded 71.8915 ms baseline; full FileWalker timings are compared
  // only with one another below.
  const taskOneAny = await measureLane(async () => {
    const found = await discoverTaskOneProtocol(options.corpusRoot);
    return found === expectedCount
      ? {}
      : { contaminated: "fixture_drift_file_count" };
  });

  // ── any mode: production FileWalker (Bun.Glob) ──────────────────────────
  const anyDiscovery = await measureLane(async () => {
    const result = await walkShipped(walker, options.corpusRoot, "any");
    return result.entryCount === expectedCount
      ? {}
      : { contaminated: "fixture_drift_file_count" };
  });

  // ── local mode: hierarchical directory classification (memoized) ────────
  // Instrument once after warm protocol samples via a dedicated probe pass.
  const classifyStats = {
    callsPerSample: [] as number[],
    uniquePathsPerSample: [] as number[],
  };
  const localDiscovery = await measureLane(async () => {
    const base = createDirectoryAvailability("local", {
      pathSupport: BENCHMARK_PATH_SUPPORT,
    });
    const instrumented = instrumentDirectoryAvailability(base);
    const memoized = memoizeDirectoryAvailability(instrumented.port);
    const result = await walkShipped(
      walker,
      options.corpusRoot,
      "local",
      memoized
    );
    classifyStats.callsPerSample.push(instrumented.getCallCount());
    classifyStats.uniquePathsPerSample.push(instrumented.getUniquePaths());
    if (result.entryCount !== expectedCount) {
      return {
        contaminated: `local_entry_count_${result.entryCount}_expected_${expectedCount}`,
      };
    }
    // Hierarchical: unique classified paths track directories, not every file.
    // (Call count may exceed unique paths before memoization; memoized path is used.)
    if (
      expectedCount > directoryCount &&
      instrumented.getUniquePaths() >= expectedCount
    ) {
      return { contaminated: "local_classified_per_file_not_hierarchical" };
    }
    return {};
  });

  // ── availability metadata: hierarchical dir classification only ─────────
  const availabilityMeta = await measureLane(async () => {
    const base = createDirectoryAvailability("local", {
      pathSupport: BENCHMARK_PATH_SUPPORT,
    });
    const memoized = memoizeDirectoryAvailability(base);
    // Classify every directory once (root + descendants).
    const queue = [options.corpusRoot];
    let classified = 0;
    while (queue.length > 0) {
      const dir = queue.pop() as string;
      const result = await memoized.classify(dir);
      classified += 1;
      if (result.kind !== "available") {
        return { contaminated: `directory_not_available_${result.code}` };
      }
      let dirents;
      try {
        dirents = await readdir(dir, { withFileTypes: true });
      } catch {
        return { contaminated: "directory_readdir_failed" };
      }
      for (const dirent of dirents) {
        if (dirent.isDirectory() && !dirent.isSymbolicLink()) {
          queue.push(join(dir, dirent.name));
        }
      }
    }
    if (classified !== directoryCount) {
      return {
        contaminated: `directory_count_mismatch_${classified}_${directoryCount}`,
      };
    }
    return {};
  });

  // ── sniff/read/hash (production readers) ────────────────────────────────
  const anyReader = createSourceContentReader("any");
  const localReader = createSourceContentReader("local", {
    pathSupport: BENCHMARK_PATH_SUPPORT,
  });

  const sniffAny = await measureLane(async () => {
    const result = await sniffReadHash(files, anyReader);
    return result.ok
      ? {}
      : { contaminated: result.reason ?? "sniff_any_failed" };
  });

  const sniffLocal = await measureLane(async () => {
    const result = await sniffReadHash(files, localReader);
    return result.ok
      ? {}
      : { contaminated: result.reason ?? "sniff_local_failed" };
  });

  // Optional smoke observer path retained for evidence continuity (not candidate).
  const observerLane =
    observer == null
      ? null
      : await measureLane(async () => {
          for (const file of files) {
            const snapshot = observer.observe(file);
            if (!snapshot.ok) {
              return { contaminated: "metadata_observe_failed" };
            }
            if (snapshot.dataless === true) {
              return {
                contaminated: "unexpected_dataless_on_all_local_corpus",
              };
            }
          }
          return {};
        });

  // Guarded smoke read (legacy harness path; not the R6 candidate).
  const guardedSmoke =
    policy == null
      ? null
      : await measureLane(async () => {
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

  const anyMedian = anyDiscovery.summary.medianMs;
  const localMedian = localDiscovery.summary.medianMs;

  const taskOneControl = compareAgainstThreshold(
    taskOneAny.summary.medianMs,
    PRE_IMPLEMENTATION_BASELINE.medianMs,
    ANY_REGRESSION_THRESHOLD_PERCENT
  );
  const localVsAny = compareAgainstThreshold(
    localMedian,
    anyMedian,
    LOCAL_OVERHEAD_THRESHOLD_PERCENT
  );

  const maxClassifyCalls = Math.max(0, ...classifyStats.callsPerSample);
  const maxUniqueDirs = Math.max(0, ...classifyStats.uniquePathsPerSample);

  const lane = (
    label: string,
    measured: { summary: SampleSummary; contaminated: ContaminatedSample[] },
    extra: Record<string, unknown> = {}
  ) => ({
    label,
    kind: "measured" as const,
    ...measured.summary,
    contaminated: measured.contaminated,
    ...extra,
  });

  const complete =
    taskOneAny.summary.rawMs.length === SAMPLE_COUNT &&
    anyDiscovery.summary.rawMs.length === SAMPLE_COUNT &&
    localDiscovery.summary.rawMs.length === SAMPLE_COUNT &&
    availabilityMeta.summary.rawMs.length === SAMPLE_COUNT &&
    sniffAny.summary.rawMs.length === SAMPLE_COUNT &&
    sniffLocal.summary.rawMs.length === SAMPLE_COUNT;

  return {
    action: "benchmark-shipped-design",
    design: {
      candidate:
        "hierarchical memoized per-directory availability classification + guarded content recheck",
      rejectedCandidate:
        "naive extra availability check for every discovered file",
      rejectedCandidateOverheadPercent:
        PRE_IMPLEMENTATION_BASELINE.rejectedNaiveOverheadPercent,
      rejectedCandidateNote:
        "Task 1 measured +15.2323% on the 5,000-file all-local corpus; not re-measured as the shipped candidate",
      pathSupportNote:
        "Owned temp corpus injects availability-eligible pathSupport for mechanism-cost measurement only; production still fail-closes outside evidenced macOS File Provider layouts",
    },
    environment: {
      platform: process.platform,
      bun: Bun.version,
      arch: process.arch,
      policyScope: "process",
      policyScopeReason:
        "async Bun I/O may escape thread scope; production local mode uses process scope",
      ...options.environment,
    },
    provider: options.provider ?? { label: "local", version: "n/a" },
    corpus: {
      root: redactToken(options.corpusRoot),
      fileCount: expectedCount,
      directoryCount,
      shape: "deterministic-fn118-all-local-flat",
      notes:
        "Owned temporary directory; 5,000 flat Markdown files by default; not a provider root",
    },
    protocol: {
      warmups: WARMUP_COUNT,
      samplesPerLane: SAMPLE_COUNT,
      runOrder: [...runOrder],
      complete,
      thresholds: {
        taskOneControlDriftPercent: ANY_REGRESSION_THRESHOLD_PERCENT,
        localOverheadVsAnyPercent: LOCAL_OVERHEAD_THRESHOLD_PERCENT,
      },
    },
    hierarchicalProof: {
      directoryCount,
      fileCount: expectedCount,
      classifyCallsPerSample: classifyStats.callsPerSample,
      uniqueDirectoriesPerSample: classifyStats.uniquePathsPerSample,
      maxClassifyCalls,
      maxUniqueDirectories: maxUniqueDirs,
      provesHierarchical:
        maxClassifyCalls > 0 && maxClassifyCalls < expectedCount,
      note: "Local mode classifies directories (memoized), not one availability call per discovered file",
    },
    lanes: {
      "task1-protocol-any-regression": lane(
        "unchanged any-mode discovery/traversal using the exact task-1 protocol",
        taskOneAny,
        { mode: "any", phase: "discovery-traversal", regressionGate: true }
      ),
      "any-discovery-traversal": lane(
        "shipped FileWalker sourceAvailability=any (Bun.Glob)",
        anyDiscovery,
        { mode: "any", phase: "discovery-traversal" }
      ),
      "local-discovery-traversal": lane(
        "shipped FileWalker sourceAvailability=local (hierarchical directory classification)",
        localDiscovery,
        {
          mode: "local",
          phase: "discovery-traversal",
          classification: "hierarchical-memoized-per-directory",
        }
      ),
      "availability-metadata-hierarchical": lane(
        "hierarchical directory availability metadata (SF_DATALESS under no-materialization policy)",
        availabilityMeta,
        {
          phase: "availability-metadata",
          intermediateDirectoryCaveat: INTERMEDIATE_DIR_CAVEAT,
          observerKind: observer?.kind ?? null,
        }
      ),
      "sniff-read-hash-any": lane(
        "sniff/read/hash via AnySourceContentReader",
        sniffAny,
        { mode: "any", phase: "sniff-read-hash" }
      ),
      "sniff-read-hash-local": lane(
        "sniff/read/hash via LocalSourceContentReader (guarded no-materialization)",
        sniffLocal,
        { mode: "local", phase: "sniff-read-hash" }
      ),
      conversion: {
        kind: "not-applicable",
        reason: "Markdown fixture corpus requires no conversion",
        phase: "conversion",
      },
      embedding: {
        kind: "not-applicable",
        reason:
          "Controlled all-local corpus does not invoke models or production embedding",
        phase: "embedding",
      },
      ...(observerLane
        ? {
            "observer-per-file-metadata-smoke": lane(
              "smoke observer per-file SF_DATALESS (evidence continuity; NOT the R6 candidate)",
              observerLane,
              { phase: "smoke-only", candidate: false }
            ),
          }
        : {}),
      ...(guardedSmoke
        ? {
            "guarded-read-hash-smoke": lane(
              "smoke harness guarded read/hash (evidence continuity; NOT the R6 candidate)",
              guardedSmoke,
              { phase: "smoke-only", candidate: false }
            ),
          }
        : {}),
    },
    comparison: {
      taskOneProtocolControl: {
        ...taskOneControl,
        baselineSource: PRE_IMPLEMENTATION_BASELINE.evidencePath,
        baselineCapturedAt: PRE_IMPLEMENTATION_BASELINE.capturedAt,
        note: "Control-to-control drift only; production any regression requires the isolated pre-implementation FileWalker comparison tracked with task-4 evidence",
      },
      localOverheadVsImplementedAny: {
        ...localVsAny,
        note:
          localVsAny.passes === false
            ? "BLOCKER: local mode median exceeds 10% overhead vs implemented any"
            : localVsAny.passes === true
              ? "local hierarchical mode within 10% of implemented any"
              : "indeterminate comparison",
      },
      rejectedNaiveCandidate: {
        measured: false,
        reason:
          "Naive per-discovered-file availability pass already failed R6 at +15.2323%; shipped design is hierarchical per-directory classification",
        preImplementationOverheadPercent:
          PRE_IMPLEMENTATION_BASELINE.rejectedNaiveOverheadPercent,
      },
      hostMeasurementInsertionPoint: {
        status: "measured-evidence-present",
        command:
          "bun scripts/macos-file-provider-smoke.ts benchmark-local --corpus-files 5000",
        evidencePath:
          "research/file-provider/evidence/2026-08-16-post-implementation-performance.json",
        note: "Host re-run may replace evidence; thresholds use task1-protocol for any≤3% and FileWalker any for local≤10%",
        requiredFields: [
          "lanes.task1-protocol-any-regression",
          "lanes.any-discovery-traversal",
          "lanes.local-discovery-traversal",
          "comparison.anyRegressionVsPreImplementation",
          "comparison.localOverheadVsImplementedAny",
          "hierarchicalProof",
        ],
      },
    },
  };
}

/**
 * Backward-compatible entry: runs shipped-design protocol on an existing corpus.
 * Legacy name retained for smoke CLI `benchmark` / existing tests.
 */
export async function runAllLocalBenchmark(options: {
  corpusRoot: string;
  observer?: AvailabilityObserver | null;
  policy?: IoPolicyPort | null;
  provider?: { label: ProviderLabel | "local"; version: string };
  environment?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const files = await listFixtureFiles(options.corpusRoot);
  return runShippedDesignBenchmark({
    corpusRoot: options.corpusRoot,
    expectedFileCount: files.length,
    observer: options.observer,
    policy: options.policy,
    provider: options.provider,
    environment: options.environment,
  });
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
    return await runShippedDesignBenchmark({
      corpusRoot,
      expectedFileCount: options.fileCount,
      provider: { label: "local", version: "n/a" },
      environment: options.environment,
    });
  } finally {
    // Exact mkdtemp-owned parent only; never a provider root or user directory.
    await rm(parent, { recursive: true });
  }
}
