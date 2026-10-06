/**
 * Invariant thresholds and tier defaults for the soak harness.
 *
 * All pass/fail limits live here (fn-203 R3). Starting values are
 * provisional until a baseline run on a healthy build sets them; never
 * loosen one to make a run pass (R7) - file the finding instead.
 *
 * @module scripts/soak/config
 */

export const THRESHOLDS = {
  /** I1: quiet window after convergence before idle is measured. */
  idleQuietMs: 60_000,
  /** I1: mean CPU of the whole GNO process tree over the quiet window. */
  idleCpuPercent: 1,
  /** I1: context switches per second across the tree (Linux only). */
  idleWakeupsPerSec: 50,
  /** I1: index growth allowed while idle (DB + WAL bytes). */
  idleDbGrowthBytes: 256 * 1024,
  /** I1: new ingest_errors rows allowed while idle. */
  idleNewIngestErrors: 0,
  /** I2: how long a child may outlive a killed parent before it is an orphan. */
  orphanGraceMs: 3_000,
  /**
   * I4: status probe latency. Set from the fn-208 healthy baseline (seed 5
   * torture config-edit/sse-flood/sleep-wake/embed-faults, seed 1 smoke, on
   * Linux): worst p99 65 ms and worst max 65 ms (sleep-wake), smoke churn p99
   * 15 ms. The limits leave about 2x headroom for slower machines.
   */
  statusP99Ms: 150,
  statusMaxMs: 1_000,
  /** I5: SIGTERM to exit (drain 5 s + abort 5 s + exit 1 s, plus margin). */
  shutdownMs: 12_000,
  /** I6: per-hour slopes over a soak. */
  rssSlopeMbPerHour: 64,
  fdSlopePerHour: 50,
  ingestErrorsPerHour: 600,
  logBytesPerHour: 5 * 1024 * 1024,
  /** I7: attempts of one failing path inside a 10-minute window. */
  maxAttemptsPer10Min: 20,
  /** I8: time allowed to converge after churn and faults stop. */
  convergenceMs: 180_000,
} as const;

export type Thresholds = typeof THRESHOLDS;

export type Tier = "smoke" | "torture" | "soak";

export interface TierDefaults {
  docs: number;
  durationMs: number;
}

export const TIER_DEFAULTS: Record<Tier, TierDefaults> = {
  smoke: { docs: 300, durationMs: 60_000 },
  torture: { docs: 600, durationMs: 0 },
  soak: { docs: 3_000, durationMs: 4 * 60 * 60_000 },
};

/** Sampling cadence for the process monitor. */
export const SAMPLE_INTERVAL_MS = 1_000;
/** Cadence of the /api/resident/status responsiveness probe. */
export const STATUS_PROBE_MS = 2_000;
