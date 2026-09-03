/**
 * Memory eval suite: the adapter gate for the fn-130 remember/recall slice.
 *
 * Seven suites run against one temp index through the real SDK path, offline
 * and lexical-only, so every number here is deterministic run to run. The
 * thresholds in MEMORY_GATE are the contract: when this file is green at these
 * values the memory contracts are fit for harness adapters (fn-135). A
 * sub-threshold result is a finding against the memory slice (file it as an
 * fn-130 follow-up), never something to tune away here.
 *
 * Run: `bun run eval:memory` (opt-in, local-only, no network, no LLM judge).
 *
 * @module evals/memory.eval
 */

import { evalite } from "evalite";
// evalite runs eval files inside vitest workers; file-level afterAll is the
// only hook that reliably fires once every suite in this file has finished.
import { afterAll } from "vitest";

import type {
  AgentDayFixture,
  AgentDayGolden,
  FenceFixture,
  RecallFixture,
  ScopeFixture,
  SupersessionFixture,
  UpsertFixture,
} from "./helpers/memory-fixtures";

import {
  buildFixtureManifest,
  loadMemoryFixture,
  manifestDigest,
  verifyFixtureManifest,
} from "./helpers/memory-fixtures";
import { cleanupMemoryEvalClient } from "./helpers/memory-harness";
import { runAgentDay } from "./helpers/memory-suite-agent-day";
import { runLatencySuite } from "./helpers/memory-suite-latency";
import {
  runFenceSuite,
  runRecallSuite,
  runScopeSuite,
  runSupersessionCase,
  runUpsertCase,
} from "./helpers/memory-suites";

/**
 * The adapter gate. Required-exact metrics assert at 1.0 / 0; graded metrics
 * assert at the documented threshold. Change a value here only with a matching
 * note in docs/MEMORY.md ("Eval gate").
 */
export const MEMORY_GATE = {
  /** Suite 1: decision behaviour correct on every upsert case. */
  upsertAccuracy: 1,
  /** Suite 2: only current facts come back; every conflict case behaves. */
  currentStatePrecision: 1,
  /** Suite 3 (graded): mean recall@5 over the quality queries. */
  recallAt5: 0.8,
  /** Suite 3: every returned gno:// URI resolves through the SDK. */
  citeValidity: 1,
  /** Suite 3: facts <= recallMaxFacts and tokens <= recallMaxTokens on every recall. */
  budgetRespected: 1,
  /**
   * Suite 3: the recall budget as literals. Both the observed payload and the
   * implementation constants (MEMORY_RECALL_MAX_*) are asserted against these,
   * so a cap regression in src/ fails the gate instead of moving it.
   */
  recallMaxFacts: 8,
  recallMaxTokens: 512,
  /** Suite 4: receipted replays and gno:// derived origins rejected. */
  exactReplayRejection: 1,
  /** Suite 5: facts from a foreign scope returned or reused (must be 0). */
  scopeLeakage: 0,
  /** Suite 5: expected in-scope facts missing from a read (must be 0). */
  scopeReadMisses: 0,
  /** Suite 6: end state equals the committed golden; every turn as scripted. */
  agentDayMatch: 1,
  /** Suite 7 (graded): recall p95 over `latencySamples` sequential fast-path calls. */
  recallP95Ms: 25,
  latencySamples: 200,
} as const;

const pass = (ok: boolean) => ({ score: ok ? 1 : 0 });

// Close the shared temp index and delete /tmp/gno-memory-eval-* once the
// last suite in this file has run (process `beforeExit` never fires here).
afterAll(cleanupMemoryEvalClient);

evalite("Memory 1: upsert correctness", {
  data: async () => {
    const fixture = await loadMemoryFixture<UpsertFixture>("upsert.json");
    return fixture.cases.map((input) => ({ input, expected: input.expect }));
  },
  task: runUpsertCase,
  scorers: [
    {
      name: "Decision behaviour",
      description: `Outcome, write count and likely-match as scripted (gate ${MEMORY_GATE.upsertAccuracy})`,
      scorer: ({ output }) => ({
        score: output.correct ? 1 : 0,
        metadata: {
          outcome: output.outcome,
          filesWritten: output.filesWritten,
          likely: output.likely,
        },
      }),
    },
  ],
  columns: ({ input, output }) => [
    { label: "Case", value: input.id },
    { label: "Class", value: input.class },
    { label: "Expected", value: input.expect },
    { label: "Outcome", value: output.outcome },
    { label: "Written", value: String(output.filesWritten) },
  ],
});

evalite("Memory 2: supersession current state", {
  data: async () => {
    const fixture =
      await loadMemoryFixture<SupersessionFixture>("supersession.json");
    return fixture.cases.map((input) => ({ input, expected: null }));
  },
  task: runSupersessionCase,
  scorers: [
    {
      name: "Current-state precision",
      description: `Returned facts that are current (gate ${MEMORY_GATE.currentStatePrecision})`,
      scorer: ({ output }) =>
        pass(output.currentStatePrecision >= MEMORY_GATE.currentStatePrecision),
    },
    {
      name: "Current fact returned",
      description: "The chain head (or the race winner) is recalled",
      scorer: ({ output }) => pass(output.currentStateRecall === 1),
    },
    {
      name: "Conflict handling",
      description:
        "Stale and racing supersedes yield one successor and MEMORY_SUPERSEDE_CONFLICT",
      scorer: ({ output }) => ({
        score: output.raceOk ? 1 : 0,
        metadata: { stale: output.staleOutcome, race: output.raceOutcomes },
      }),
    },
  ],
  columns: ({ input, output }) => [
    { label: "Case", value: input.id },
    { label: "Current", value: output.expectedCurrent.join(" | ") },
    { label: "Returned", value: output.returned.join(" | ") },
    {
      label: "Stale/race",
      value: [output.staleOutcome, ...(output.raceOutcomes ?? [])]
        .filter(Boolean)
        .join(", "),
    },
  ],
});

evalite("Memory 3: recall quality under budget", {
  data: async () => [
    {
      input: await loadMemoryFixture<RecallFixture>("recall.json"),
      expected: null,
    },
  ],
  task: (fixture) =>
    runRecallSuite(fixture, {
      maxFacts: MEMORY_GATE.recallMaxFacts,
      maxTokens: MEMORY_GATE.recallMaxTokens,
    }),
  scorers: [
    {
      name: `Recall@5 >= ${MEMORY_GATE.recallAt5}`,
      description: "Graded gate on mean recall@5",
      scorer: ({ output }) => ({
        score: output.recallAt5 >= MEMORY_GATE.recallAt5 ? 1 : 0,
        metadata: {
          misses: output.queries
            .filter((q) => q.recallAt5 < 1)
            .map((q) => q.id),
        },
      }),
    },
    {
      name: "Cite validity",
      description: `Every returned URI resolves via client.get (gate ${MEMORY_GATE.citeValidity})`,
      scorer: ({ output }) =>
        pass(output.citeValidity >= MEMORY_GATE.citeValidity),
    },
    {
      name: "Budget respected",
      description: `facts <= ${MEMORY_GATE.recallMaxFacts} and tokens <= ${MEMORY_GATE.recallMaxTokens} on every recall (payload caps and MEMORY_RECALL_MAX_* pinned to the same literals); every budget query filled the fact cap with facts left over`,
      scorer: ({ output }) => ({
        score:
          output.budgetRespected >= MEMORY_GATE.budgetRespected &&
          output.implementationLimitsMatch &&
          output.budgetQueryExercisedCap
            ? 1
            : 0,
        metadata: {
          pinned: {
            maxFacts: MEMORY_GATE.recallMaxFacts,
            maxTokens: MEMORY_GATE.recallMaxTokens,
          },
          implementation: output.implementationLimits,
          budgetQueries: output.budgetQueryCount,
          budgetQueryExercisedCap: output.budgetQueryExercisedCap,
        },
      }),
    },
  ],
  columns: ({ output }) => [
    { label: "Queries", value: String(output.queries.length) },
    { label: "Recall@5", value: output.recallAt5.toFixed(3) },
    {
      label: "Misses",
      value:
        output.queries
          .filter((q) => q.recallAt5 < 1)
          .map((q) => q.id)
          .join(", ") || "-",
    },
    {
      label: "Budget query",
      value: output.queries
        .filter((q) => q.kind === "budget")
        .map(
          (q) =>
            `${q.factsReturned} facts / ${q.usedTokens} tokens / ${q.omitted} omitted`
        )
        .join("; "),
    },
  ],
});

evalite("Memory 4: context fence", {
  data: async () => [
    {
      input: await loadMemoryFixture<FenceFixture>("fence.json"),
      expected: null,
    },
  ],
  task: runFenceSuite,
  scorers: [
    {
      name: "Exact replay rejection",
      description: `Receipted replays + gno:// derived origins rejected (gate ${MEMORY_GATE.exactReplayRejection})`,
      scorer: ({ output }) => ({
        score:
          output.exactRejectionRate >= MEMORY_GATE.exactReplayRejection ? 1 : 0,
        metadata: {
          replays: `${output.replayRejected}/${output.replayAttempts}`,
          derived: `${output.derivedRejected}/${output.derivedAttempts}`,
        },
      }),
    },
    {
      name: "Paraphrase leak-through (observed, not asserted)",
      description:
        "Share of receipted paraphrases that were stored; reported for visibility only",
      scorer: ({ output }) => ({
        score: 1,
        metadata: {
          leaked: `${output.paraphraseLeaked}/${output.paraphraseAttempts}`,
          rate: output.paraphraseLeakRate,
        },
      }),
    },
  ],
  columns: ({ output }) => [
    {
      label: "Replays rejected",
      value: `${output.replayRejected}/${output.replayAttempts}`,
    },
    {
      label: "Derived rejected",
      value: `${output.derivedRejected}/${output.derivedAttempts}`,
    },
    {
      label: "Paraphrase leak",
      value: `${output.paraphraseLeaked}/${output.paraphraseAttempts} (${(output.paraphraseLeakRate * 100).toFixed(0)}%)`,
    },
  ],
});

evalite("Memory 5: scope isolation", {
  data: async () => [
    {
      input: await loadMemoryFixture<ScopeFixture>("scopes.json"),
      expected: null,
    },
  ],
  task: runScopeSuite,
  scorers: [
    {
      name: "Scope leakage",
      description: `Foreign-scope facts returned or reused on write (gate ${MEMORY_GATE.scopeLeakage})`,
      scorer: ({ output }) => ({
        score: output.leakage <= MEMORY_GATE.scopeLeakage ? 1 : 0,
        metadata: {
          readLeaks: output.readLeaks,
          writeLeaks: output.writeLeaks,
        },
      }),
    },
    {
      name: "In-scope recall",
      description: `Every read returns its expected in-scope facts (gate ${MEMORY_GATE.scopeReadMisses} misses); an all-empty recall is a miss, not isolation`,
      scorer: ({ output }) => ({
        score: output.readMisses <= MEMORY_GATE.scopeReadMisses ? 1 : 0,
        metadata: {
          missed: output.reads
            .filter((r) => r.missed.length > 0)
            .map((r) => `${r.id}: ${r.missed.join("+")}`),
        },
      }),
    },
  ],
  columns: ({ output }) => [
    {
      label: "Reads",
      value: output.reads
        .map((r) => `${r.id}: ${r.returned.join("+")}`)
        .join(" | "),
    },
    {
      label: "Writes",
      value: output.writes.map((w) => `${w.id}: ${w.outcome}`).join(" | "),
    },
    { label: "Leaks", value: String(output.leakage) },
    { label: "Misses", value: String(output.readMisses) },
  ],
});

evalite("Memory 6: agent day (session loop)", {
  data: async () => [
    {
      input: {
        fixture: await loadMemoryFixture<AgentDayFixture>("agent-day.json"),
        golden: await loadMemoryFixture<AgentDayGolden>(
          "agent-day.golden.json"
        ),
      },
      expected: null,
    },
  ],
  task: ({ fixture, golden }) => runAgentDay(fixture, golden),
  scorers: [
    {
      name: "Turn outcomes as scripted",
      description: "Every turn produced its expected outcome / error code",
      scorer: ({ output }) => ({
        score: output.turnAccuracy >= MEMORY_GATE.agentDayMatch ? 1 : 0,
        metadata: { failed: output.turns.filter((t) => !t.ok) },
      }),
    },
    {
      name: "Golden end state",
      description:
        "Fact tree + recall answers equal agent-day.golden.json (diff in metadata)",
      scorer: ({ output }) => ({
        score: output.goldenMatch ? 1 : 0,
        metadata: { diff: output.diff },
      }),
    },
  ],
  columns: ({ output }) => [
    {
      label: "Turns",
      value: `${output.turns.filter((t) => t.ok).length}/${output.turns.length}`,
    },
    { label: "Records", value: String(output.actual.records.length) },
    {
      label: "Golden",
      value: output.goldenMatch ? "match" : `DIFF\n${output.diff}`,
    },
  ],
});

evalite("Memory 7: recall latency envelope", {
  data: async () => [
    {
      input: await loadMemoryFixture<RecallFixture>("recall.json"),
      expected: null,
    },
  ],
  task: (fixture) => runLatencySuite(fixture, MEMORY_GATE.latencySamples),
  scorers: [
    {
      name: `Recall p95 <= ${MEMORY_GATE.recallP95Ms}ms`,
      description: `p95 over ${MEMORY_GATE.latencySamples} sequential lexical recalls on the eval corpus`,
      scorer: ({ output }) => ({
        score:
          output.p95Ms <= MEMORY_GATE.recallP95Ms && output.allNonEmpty ? 1 : 0,
        metadata: {
          p50Ms: output.p50Ms,
          p95Ms: output.p95Ms,
          maxMs: output.maxMs,
        },
      }),
    },
  ],
  columns: ({ output }) => [
    { label: "Samples", value: String(output.samples) },
    { label: "p50", value: `${output.p50Ms.toFixed(2)}ms` },
    { label: "p95", value: `${output.p95Ms.toFixed(2)}ms` },
    { label: "max", value: `${output.maxMs.toFixed(2)}ms` },
  ],
});

evalite("Memory 0: fixture integrity", {
  data: async () => [{ input: "manifest.json", expected: null }],
  task: async () => {
    // verifyFixtureManifest throws on drift or an unpinned file; the digests
    // below make the same check explicit for the scorer.
    const committed = manifestDigest(await verifyFixtureManifest());
    const rebuilt = manifestDigest(await buildFixtureManifest());
    return { committed, rebuilt };
  },
  scorers: [
    {
      name: "Fixtures match manifest",
      description:
        "The digest of the committed manifest equals the digest rebuilt from the fixture bytes on disk",
      scorer: ({ output }) => ({
        score: output.committed === output.rebuilt ? 1 : 0,
        metadata: output,
      }),
    },
  ],
  columns: ({ output }) => [
    { label: "Fixture set", value: output.committed },
    {
      label: "On disk",
      value: output.committed === output.rebuilt ? "match" : output.rebuilt,
    },
  ],
});
