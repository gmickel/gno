/**
 * Memory eval suite 7: the recall latency envelope over sequential lexical
 * fast-path calls on the recall corpus.
 *
 * @module evals/helpers/memory-suite-latency
 */

import type { RecallFixture } from "./memory-fixtures";

import {
  getMemoryEvalClient,
  percentile,
  recall,
  seedFacts,
} from "./memory-harness";

export interface LatencyOutcome {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  /** Every timed recall returned at least one fact (so the fast path did work). */
  allNonEmpty: boolean;
}

export async function runLatencySuite(
  fixture: RecallFixture,
  samples: number
): Promise<LatencyOutcome> {
  const ctx = await getMemoryEvalClient();
  const collection = "mem-latency";
  const scopes = ["eval:latency"];
  await seedFacts(
    ctx.client,
    collection,
    fixture.facts.map((fact) => ({ ...fact, scopes }))
  );
  const queries = fixture.queries.map((query) => query.query);
  // Warm the path once so the first-call setup is not part of the envelope.
  await recall(ctx.client, { query: queries[0]!, collection, scopes });
  const timings: number[] = [];
  let allNonEmpty = true;
  for (let index = 0; index < samples; index++) {
    const query = queries[index % queries.length]!;
    const started = performance.now();
    const result = await recall(ctx.client, { query, collection, scopes });
    timings.push(performance.now() - started);
    if (result.facts.length === 0) allNonEmpty = false;
  }
  return {
    samples,
    p50Ms: percentile(timings, 0.5),
    p95Ms: percentile(timings, 0.95),
    maxMs: Math.max(...timings),
    allNonEmpty,
  };
}
