/** Deterministic watcher candidate-discovery benchmark (ingestion excluded). */

// node:fs/promises — structural temp fixture operations have no Bun equivalent.
import { lstat, mkdir, mkdtemp, readdir } from "node:fs/promises";
// node:os — Bun has no temp-directory helper.
import { tmpdir } from "node:os";
// node:path — Bun has no path utilities.
import { join } from "node:path";

import type { WatcherSnapshotStat } from "../src/serve/watch-snapshot";
import type { SqliteAdapter } from "../src/store/sqlite/adapter";

import { classifyDirtyHints } from "../src/serve/watch-reconciliation";
import {
  buildWatcherSnapshot,
  createPathBackedWatcherFs,
  reconcileWatcherHints,
} from "../src/serve/watch-snapshot";
import { safeRm } from "../test/helpers/cleanup";

const FILE_COUNT = 5_000;
// Windows hosted runners need enough observations that nearest-rank p95 is the
// second-slowest sample instead of the maximum. Keep the established workload
// elsewhere; extra native-adapter scans only increase exposure to old-Bun I/O
// instability without improving the already-wide Unix threshold margin.
const SAMPLE_COUNT = process.platform === "win32" ? 20 : 9;
const WARMUP_COUNT = process.platform === "win32" ? 5 : 2;
const TARGET = "note-02500.md";
const prefetchedStats = new Map<string, Promise<WatcherSnapshotStat>>();

function percentile95(samples: number[]): number {
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? 0;
}

function thresholdMs(): number {
  return process.platform === "win32" ? 500 : 250;
}

function assertOnlyTarget(candidates: readonly string[]): void {
  if (candidates.length !== 1 || candidates[0] !== TARGET) {
    throw new Error(
      `Expected only ${TARGET}; received ${JSON.stringify(candidates)}`
    );
  }
}

async function lstatForWatcherBenchmark(
  absPath: string
): Promise<WatcherSnapshotStat> {
  const stat = await lstat(absPath, { bigint: true });
  return {
    isFile: () => stat.isFile(),
    isDirectory: () => stat.isDirectory(),
    isSymbolicLink: () => stat.isSymbolicLink(),
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

async function readdirForWatcherBenchmark(absPath: string): Promise<string[]> {
  const names = await readdir(absPath);
  // The Windows benchmark adapter is intentionally path-backed. Start its
  // independent child stats together so the measurement reflects discovery
  // work rather than 5,000 sequential promise round trips in the test seam.
  for (const name of names) {
    const child = join(absPath, name);
    prefetchedStats.set(child, lstatForWatcherBenchmark(child));
  }
  return names;
}

async function cachedLstatForWatcherBenchmark(
  absPath: string
): Promise<WatcherSnapshotStat> {
  const prefetched = prefetchedStats.get(absPath);
  if (!prefetched) {
    return lstatForWatcherBenchmark(absPath);
  }
  prefetchedStats.delete(absPath);
  return prefetched;
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "gno-watch-benchmark-"));
  try {
    await mkdir(root, { recursive: true });
    await Promise.all(
      Array.from({ length: FILE_COUNT }, (_, index) => {
        const name = `note-${String(index).padStart(5, "0")}.md`;
        return Bun.write(join(root, name), `fixture-${index}`);
      })
    );

    const benchmarkFs =
      process.platform === "win32"
        ? createPathBackedWatcherFs({
            readdir: readdirForWatcherBenchmark,
            lstat: cachedLstatForWatcherBenchmark,
          })
        : undefined;
    const snapshotOptions = benchmarkFs ? { fs: benchmarkFs } : undefined;
    const initial = await buildWatcherSnapshot(root, snapshotOptions);
    if (initial.status !== "ok") {
      throw new Error(`Initial snapshot failed: ${initial.status}`);
    }
    let snapshot = initial.snapshot;
    const samples: number[] = [];

    for (let sample = 0; sample < WARMUP_COUNT + SAMPLE_COUNT; sample += 1) {
      await Bun.write(
        join(root, TARGET),
        `changed-${sample}-${"x".repeat(sample + 1)}`
      );
      const startedAt = performance.now();
      const result = await reconcileWatcherHints(
        root,
        snapshot,
        [""],
        snapshotOptions
      );
      const durationMs = performance.now() - startedAt;
      if (result.status !== "ok") {
        const cause =
          result.cause instanceof Error ? ` (${result.cause.message})` : "";
        throw new Error(`Fast-path reconcile failed: ${result.reason}${cause}`);
      }
      assertOnlyTarget(result.candidates);
      snapshot = result.nextSnapshot;
      if (sample >= WARMUP_COUNT) {
        samples.push(durationMs);
      }
    }

    const p95 = percentile95(samples);
    const threshold = thresholdMs();
    console.log(
      JSON.stringify({
        mode: "snapshot-fast-path",
        platform: process.platform,
        bun: Bun.version,
        files: FILE_COUNT,
        selected: [TARGET],
        samplesMs: samples.map((value) => Number(value.toFixed(2))),
        p95Ms: Number(p95.toFixed(2)),
        thresholdMs: threshold,
        filesystemAdapter:
          process.platform === "win32"
            ? "path-backed-benchmark"
            : "native-anchored",
      })
    );
    if (p95 > threshold) {
      throw new Error(
        `Watcher discovery p95 ${p95.toFixed(2)}ms exceeds ${threshold}ms`
      );
    }

    const emptyStore = {
      listActiveSourcePaths: async () => ({ ok: true as const, value: [] }),
      listActiveDirectChildSourcePaths: async () => ({
        ok: true as const,
        value: [],
      }),
      listActiveDescendantSourcePaths: async () => ({
        ok: true as const,
        value: [],
      }),
    } as unknown as SqliteAdapter;
    const fallbackStartedAt = performance.now();
    const fallback = await classifyDirtyHints({
      collection: {
        name: "notes",
        path: root,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
      store: emptyStore,
      rootAbs: root,
      previous: null,
      dirtyHints: [""],
      forceFallback: true,
      snapshotOptions,
    });
    const fallbackMs = performance.now() - fallbackStartedAt;
    if (fallback.status !== "ok" || !fallback.candidates.includes(TARGET)) {
      throw new Error("Fallback failed to include the changed target");
    }
    console.log(
      JSON.stringify({
        mode: "bounded-store-disk-fallback",
        platform: process.platform,
        bun: Bun.version,
        files: FILE_COUNT,
        selectedCount: fallback.candidates.length,
        durationMs: Number(fallbackMs.toFixed(2)),
        gating: false,
      })
    );
  } finally {
    await safeRm(root);
  }
}

await main();
