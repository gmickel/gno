/**
 * Memory eval suite runners (suites 1-5). Each function drives one fixture
 * through the SDK and returns deterministic metrics; `evals/memory.eval.ts`
 * turns those into scores against the documented gate thresholds. Suite 6
 * lives in memory-suite-agent-day.ts and suite 7 in memory-suite-latency.ts.
 *
 * @module evals/helpers/memory-suites
 */

import type { RecallResult } from "../../src/core/memory";
import type {
  FenceFixture,
  RecallFixture,
  ScopeFixture,
  SupersessionCase,
  UpsertCase,
} from "./memory-fixtures";

import {
  MEMORY_RECALL_MAX_FACTS,
  MEMORY_RECALL_MAX_TOKENS,
} from "../../src/core/memory";
import { normalizeMemoryScopes } from "../../src/core/memory-record";
import {
  countFactFiles,
  getMemoryEvalClient,
  recall,
  seedFacts,
  supersede,
  tryRemember,
} from "./memory-harness";

const withIds = (texts: readonly string[], scopes: string[], prefix: string) =>
  texts.map((text, index) => ({ id: `${prefix}-${index}`, text, scopes }));

// ─────────────────────────────────────────────────────────────────────────────
// 1. Upsert correctness
// ─────────────────────────────────────────────────────────────────────────────

export interface UpsertOutcome {
  id: string;
  class: UpsertCase["class"];
  expected: string;
  outcome: string;
  filesWritten: number;
  likely: boolean | null;
  correct: boolean;
}

export async function runUpsertCase(input: UpsertCase): Promise<UpsertOutcome> {
  const ctx = await getMemoryEvalClient();
  const collection = "mem-upsert";
  const scopes = [`eval:upsert:${input.id}`];
  await seedFacts(
    ctx.client,
    collection,
    withIds(input.seed, scopes, input.id)
  );
  const before = await countFactFiles(ctx, collection, scopes[0]);
  const attempt = await tryRemember(ctx.client, {
    collection,
    scopes,
    text: input.text,
    ...(input.decision ? { decision: input.decision } : {}),
  });
  const filesWritten =
    (await countFactFiles(ctx, collection, scopes[0])) - before;
  const likely =
    attempt.kind === "result" && attempt.result.outcome === "candidates"
      ? attempt.result.candidates.some(
          (candidate) => candidate.match === "likely"
        )
      : null;
  const expectedFiles = input.expect === "added" ? 1 : 0;
  const correct =
    attempt.outcome === input.expect &&
    filesWritten === expectedFiles &&
    (input.likely === undefined || likely === input.likely);
  return {
    id: input.id,
    class: input.class,
    expected: input.expect,
    outcome: attempt.outcome,
    filesWritten,
    likely,
    correct,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Supersession current-state accuracy
// ─────────────────────────────────────────────────────────────────────────────

export interface SupersessionOutcome {
  id: string;
  returned: string[];
  expectedCurrent: string[];
  /** Returned facts that are current / returned facts. */
  currentStatePrecision: number;
  /** Expected current facts that were returned / expected. */
  currentStateRecall: number;
  staleOutcome: string | null;
  raceOutcomes: string[] | null;
  raceOk: boolean;
}

export async function runSupersessionCase(
  input: SupersessionCase
): Promise<SupersessionOutcome> {
  const ctx = await getMemoryEvalClient();
  const collection = "mem-supersede";
  const scopes = [`eval:supersede:${input.id}`];
  const [first, ...rest] = input.chain;
  const seeded = await seedFacts(ctx.client, collection, [
    { id: "root", text: first!, scopes },
  ]);
  let head = seeded.get("root")!;
  for (const text of rest) {
    const attempt = await supersede(ctx.client, collection, scopes, head, text);
    if (attempt.kind !== "result" || attempt.result.outcome !== "superseded") {
      throw new Error(
        `${input.id}: chain supersede failed with ${attempt.outcome}`
      );
    }
    head = attempt.result.record;
  }

  let staleOutcome: string | null = null;
  if (input.staleSupersede) {
    const root = seeded.get("root")!;
    staleOutcome = (
      await supersede(
        ctx.client,
        collection,
        scopes,
        root,
        input.staleSupersede
      )
    ).outcome;
  }

  let raceOutcomes: string[] | null = null;
  let raceOk = true;
  const expectedCurrent = new Set<string>([head.text]);
  if (input.conflictWriters) {
    const settled = await Promise.all(
      input.conflictWriters.map((text) =>
        supersede(ctx.client, collection, scopes, head, text)
      )
    );
    raceOutcomes = settled.map((attempt) => attempt.outcome);
    const winners = settled.filter(
      (attempt) => attempt.kind === "result" && attempt.outcome === "superseded"
    );
    const conflicts = settled.filter(
      (attempt) => attempt.outcome === "MEMORY_SUPERSEDE_CONFLICT"
    );
    raceOk = winners.length === 1 && conflicts.length === settled.length - 1;
    expectedCurrent.clear();
    for (const winner of winners) {
      if (winner.kind === "result" && winner.outcome === "superseded") {
        expectedCurrent.add(winner.result.record.text);
      }
    }
  }
  if (input.staleSupersede) {
    // The stale attempt must not have become current.
    raceOk = raceOk && staleOutcome === "MEMORY_SUPERSEDE_CONFLICT";
  }

  const result = await recall(ctx.client, {
    query: input.query,
    collection,
    scopes,
  });
  const returned = result.facts.map((fact) => fact.text);
  const currentHits = returned.filter((text) =>
    expectedCurrent.has(text)
  ).length;
  return {
    id: input.id,
    returned,
    expectedCurrent: [...expectedCurrent],
    currentStatePrecision:
      returned.length === 0 ? 0 : currentHits / returned.length,
    currentStateRecall:
      expectedCurrent.size === 0 ? 1 : currentHits / expectedCurrent.size,
    staleOutcome,
    raceOutcomes,
    raceOk,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Recall quality under budget
// ─────────────────────────────────────────────────────────────────────────────

/** The recall budget the gate pins (literals, never the implementation constants). */
export interface RecallBudgetLimits {
  maxFacts: number;
  maxTokens: number;
}

export interface RecallQueryOutcome {
  id: string;
  kind: "quality" | "budget";
  recallAt5: number;
  factsReturned: number;
  usedTokens: number;
  omitted: number;
  citeValid: boolean;
  /** Observed facts/tokens within the pinned caps and the payload's own caps equal them. */
  budgetRespected: boolean;
}

export interface RecallSuiteOutcome {
  queries: RecallQueryOutcome[];
  recallAt5: number;
  citeValidity: number;
  budgetRespected: number;
  /** MEMORY_RECALL_MAX_FACTS / MEMORY_RECALL_MAX_TOKENS still equal the pinned literals. */
  implementationLimits: RecallBudgetLimits;
  implementationLimitsMatch: boolean;
  /** At least one budget query, and every one filled the fact cap with facts left over. */
  budgetQueryCount: number;
  budgetQueryExercisedCap: boolean;
}

async function citesResolve(
  client: Awaited<ReturnType<typeof getMemoryEvalClient>>["client"],
  result: RecallResult
): Promise<boolean> {
  for (const fact of result.facts) {
    if (!fact.uri.startsWith("gno://")) return false;
    try {
      const doc = await client.get(fact.uri);
      if (!doc || doc.docid !== fact.docid) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export async function runRecallSuite(
  fixture: RecallFixture,
  limits: RecallBudgetLimits
): Promise<RecallSuiteOutcome> {
  const ctx = await getMemoryEvalClient();
  const collection = "mem-recall";
  const scopes = ["eval:recall"];
  const records = await seedFacts(
    ctx.client,
    collection,
    fixture.facts.map((fact) => ({ ...fact, scopes }))
  );
  const idByUri = new Map(
    [...records.entries()].map(([id, record]) => [record.uri, id])
  );
  const queries: RecallQueryOutcome[] = [];
  for (const query of fixture.queries) {
    const result = await recall(ctx.client, {
      query: query.query,
      collection,
      scopes,
    });
    const returnedIds = result.facts.map(
      (fact) => idByUri.get(fact.uri) ?? "?"
    );
    const top5 = returnedIds.slice(0, 5);
    const hits = query.relevant.filter((id) => top5.includes(id)).length;
    const kind = query.kind ?? "quality";
    queries.push({
      id: query.id,
      kind,
      // Budget queries have more relevant facts than the window; bound the denominator.
      recallAt5:
        hits /
        Math.min(query.relevant.length, kind === "budget" ? 5 : Infinity),
      factsReturned: result.facts.length,
      usedTokens: result.budget.usedTokens,
      omitted: result.budget.omitted,
      citeValid: await citesResolve(ctx.client, result),
      budgetRespected:
        result.facts.length <= limits.maxFacts &&
        result.budget.usedTokens <= limits.maxTokens &&
        result.budget.maxFacts === limits.maxFacts &&
        result.budget.maxTokens === limits.maxTokens,
    });
  }
  const budgetQueries = queries.filter((query) => query.kind === "budget");
  const quality = queries.filter((query) => query.kind === "quality");
  const mean = (values: number[]) =>
    values.length === 0
      ? 0
      : values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    queries,
    recallAt5: mean(quality.map((query) => query.recallAt5)),
    citeValidity: mean(queries.map((query) => (query.citeValid ? 1 : 0))),
    budgetRespected: mean(
      queries.map((query) => (query.budgetRespected ? 1 : 0))
    ),
    implementationLimits: {
      maxFacts: MEMORY_RECALL_MAX_FACTS,
      maxTokens: MEMORY_RECALL_MAX_TOKENS,
    },
    implementationLimitsMatch:
      MEMORY_RECALL_MAX_FACTS === limits.maxFacts &&
      MEMORY_RECALL_MAX_TOKENS === limits.maxTokens,
    budgetQueryCount: budgetQueries.length,
    budgetQueryExercisedCap:
      budgetQueries.length > 0 &&
      budgetQueries.every(
        (query) => query.factsReturned === limits.maxFacts && query.omitted > 0
      ),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Fencing
// ─────────────────────────────────────────────────────────────────────────────

export interface FenceSuiteOutcome {
  replayAttempts: number;
  replayRejected: number;
  derivedAttempts: number;
  derivedRejected: number;
  /** Exact replays + derivedFrom origins rejected / attempted. */
  exactRejectionRate: number;
  paraphraseAttempts: number;
  paraphraseLeaked: number;
  /** Observability only: paraphrases carry no fence marker by design. */
  paraphraseLeakRate: number;
}

export async function runFenceSuite(
  fixture: FenceFixture
): Promise<FenceSuiteOutcome> {
  const ctx = await getMemoryEvalClient();
  const collection = "mem-fence";
  const scopes = ["eval:fence"];
  await seedFacts(
    ctx.client,
    collection,
    fixture.facts.map((fact) => ({ ...fact, scopes }))
  );
  const outcome: FenceSuiteOutcome = {
    replayAttempts: 0,
    replayRejected: 0,
    derivedAttempts: 0,
    derivedRejected: 0,
    exactRejectionRate: 0,
    paraphraseAttempts: 0,
    paraphraseLeaked: 0,
    paraphraseLeakRate: 0,
  };
  for (const fenceCase of fixture.cases) {
    const recalled = await recall(ctx.client, {
      query: fenceCase.query,
      collection,
      scopes,
    });
    if (recalled.facts.length === 0) {
      throw new Error(`fence case ${fenceCase.id}: query returned no facts`);
    }
    for (const fact of recalled.facts) {
      outcome.replayAttempts += 1;
      const replay = await tryRemember(ctx.client, {
        collection,
        scopes,
        text: fact.text,
        decision: "add",
        receipt: recalled.receipt,
      });
      if (replay.outcome === "MEMORY_FENCED_REPLAY")
        outcome.replayRejected += 1;

      outcome.derivedAttempts += 1;
      const derived = await tryRemember(ctx.client, {
        collection,
        scopes,
        text: `${fact.text} (copied)`,
        decision: "add",
        derivedFrom: [fact.uri],
      });
      if (derived.outcome === "MEMORY_FENCED_DERIVED")
        outcome.derivedRejected += 1;
    }
    for (const paraphrase of fenceCase.paraphrases) {
      outcome.paraphraseAttempts += 1;
      const attempt = await tryRemember(ctx.client, {
        collection,
        scopes,
        text: paraphrase,
        decision: "add",
        receipt: recalled.receipt,
      });
      if (attempt.outcome === "added") outcome.paraphraseLeaked += 1;
    }
  }
  const exactAttempts = outcome.replayAttempts + outcome.derivedAttempts;
  outcome.exactRejectionRate =
    exactAttempts === 0
      ? 0
      : (outcome.replayRejected + outcome.derivedRejected) / exactAttempts;
  outcome.paraphraseLeakRate =
    outcome.paraphraseAttempts === 0
      ? 0
      : outcome.paraphraseLeaked / outcome.paraphraseAttempts;
  return outcome;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Scope isolation
// ─────────────────────────────────────────────────────────────────────────────

export interface ScopeSuiteOutcome {
  reads: Array<{
    id: string;
    returned: string[];
    leaked: string[];
    /** Expected in-scope facts that did not come back. */
    missed: string[];
  }>;
  writes: Array<{
    id: string;
    expected: string;
    outcome: string;
    /** Scopes on the record the write returned (empty when it returned none). */
    recordScopes: string[];
    scopesOk: boolean;
  }>;
  readLeaks: number;
  /** Expected in-scope facts missing across all reads (an all-empty recall is a miss, not a pass). */
  readMisses: number;
  writeLeaks: number;
  leakage: number;
}

/**
 * A write that added a record must have stamped exactly the normalized
 * requested scopes: an extra scope leaks the fact into a scope the caller
 * never named, a missing one hides it from a scope it was written to. A write
 * that matched an existing record only proves that record is visible in a
 * requested scope (dedup runs over `memoryScopesAny`), so its full scope set
 * may legitimately be wider.
 */
function writeScopesOk(
  outcome: string,
  recordScopes: readonly string[],
  requested: readonly string[]
): boolean {
  const wanted = new Set(normalizeMemoryScopes(requested));
  if (outcome === "added") {
    const actual = new Set(recordScopes);
    return (
      actual.size === wanted.size &&
      [...actual].every((scope) => wanted.has(scope))
    );
  }
  return recordScopes.some((scope) => wanted.has(scope));
}

export async function runScopeSuite(
  fixture: ScopeFixture
): Promise<ScopeSuiteOutcome> {
  const ctx = await getMemoryEvalClient();
  const collection = "mem-scope";
  const records = await seedFacts(ctx.client, collection, fixture.facts);
  const idByUri = new Map(
    [...records.entries()].map(([id, record]) => [record.uri, id])
  );
  const reads: ScopeSuiteOutcome["reads"] = [];
  for (const read of fixture.reads) {
    const result = await recall(ctx.client, {
      query: read.query,
      collection,
      scopes: read.scopes,
    });
    const wanted = new Set(read.scopes);
    const returned = result.facts.map(
      (fact) => idByUri.get(fact.uri) ?? fact.uri
    );
    reads.push({
      id: read.id,
      returned,
      leaked: result.facts
        .filter((fact) => !fact.scopes.some((scope) => wanted.has(scope)))
        .map((fact) => idByUri.get(fact.uri) ?? fact.uri),
      missed: read.expect.includes.filter((id) => !returned.includes(id)),
    });
  }
  const writes: ScopeSuiteOutcome["writes"] = [];
  for (const write of fixture.writes) {
    const attempt = await tryRemember(ctx.client, {
      collection,
      scopes: write.scopes,
      text: write.text,
      decision: "add",
    });
    const record =
      attempt.kind === "result" && attempt.outcome !== "candidates"
        ? attempt.result.record
        : null;
    writes.push({
      id: write.id,
      expected: write.expect,
      outcome: attempt.outcome,
      recordScopes: record?.scopes ?? [],
      scopesOk:
        record !== null &&
        writeScopesOk(attempt.outcome, record.scopes, write.scopes),
    });
  }
  const readLeaks = reads.reduce((sum, read) => sum + read.leaked.length, 0);
  const readMisses = reads.reduce((sum, read) => sum + read.missed.length, 0);
  const writeLeaks = writes.filter(
    (write) => write.outcome !== write.expected || !write.scopesOk
  ).length;
  return {
    reads,
    writes,
    readLeaks,
    readMisses,
    writeLeaks,
    leakage: readLeaks + writeLeaks,
  };
}
