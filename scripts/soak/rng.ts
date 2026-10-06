/**
 * Seeded PRNG for the soak harness: every actor and fault schedule draws from
 * one of these, so a seed reproduces a run.
 *
 * @module scripts/soak/rng
 */

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Independent child stream, stable for (seed, label). */
  fork(label: string): Rng;
  readonly seed: number;
}

function hashLabel(seed: number, label: string): number {
  let hash = seed ^ 0x9e3779b9;
  for (const char of label) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x85ebca6b);
    hash ^= hash >>> 13;
  }
  return hash >>> 0;
}

/** mulberry32: small, fast and good enough for workload scheduling. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    seed,
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (items) => {
      if (items.length === 0) throw new Error("pick from empty list");
      return items[Math.floor(next() * items.length)] as never;
    },
    fork: (label) => createRng(hashLabel(seed, label)),
  };
}
