/**
 * Sessions eval: cross-session retrieval gate for native agent-session
 * ingestion (fn-171 R6).
 *
 * Two arms are indexed in separate temp indexes and read back through the
 * same lexical retrieval and the same bounded Context Capsule delivery:
 * - pipeline: the real `SessionsService.import` of synthetic native fixtures
 *   for every supported harness format into a temp session archive;
 * - gold: the manually normalized turns in `fixtures/sessions/gold/turns.json`
 *   (hand-written text, roles and identities), indexed as JSONL records.
 *
 * Gate definition: "same usable budget" means the gold archive carries the
 * identical mandatory per-record envelope as the archive format (title
 * shape, speaker prefix, one-line provenance block, categories), so both
 * arms spend the same envelope bytes and the comparison measures dialogue
 * selection and parsing (helpers/sessions-harness, GOLD_ARM_FIELD_MAPPING).
 *
 * Both arms are judged against the gold turn records: a turn counts only when
 * its exact text is fully present in the delivered text with verified
 * identity and role. Everything runs offline and lexical-only (BM25, capsule
 * `depthPolicy: "fast"`, no embedding/rerank/expansion model), so every number
 * is deterministic run to run. SESSIONS_GATE was frozen before the arms were
 * compared. A sub-threshold result is a finding against src/sessions, never
 * something to tune away here: do not lower a threshold or edit a fixture to
 * make the pipeline pass. Failures and abstentions are reported per native
 * format and never averaged away.
 *
 * Layout: fixtures and manifest in helpers/sessions-fixtures, arm setup in
 * helpers/sessions-harness, retrieval and delivered-text judging in
 * helpers/sessions-delivery, measurements in helpers/sessions-scoring.
 *
 * Run: `bun run eval:sessions` (opt-in, local-only, no network, no LLM judge).
 *
 * @module evals/sessions.eval
 */

import { evalite } from "evalite";
// evalite runs eval files inside vitest workers; file-level afterAll is the
// only hook that reliably fires once every suite in this file has finished.
import { afterAll } from "vitest";

import type { SessionsResults } from "./helpers/sessions-scoring";

import {
  loadSessionsCases,
  SESSIONS_FIXTURE_MANIFEST,
  verifySessionsManifest,
} from "./helpers/sessions-fixtures";
import {
  cleanupSessionsEval,
  getSessionsEval,
} from "./helpers/sessions-harness";
import { formatReport, measureSessions } from "./helpers/sessions-scoring";

/**
 * The gate. Frozen before comparing arms; exact metrics assert at 1.0 / 0.
 * Change a value here only with a documented reason, never to make the
 * pipeline arm pass.
 */
export const SESSIONS_GATE = {
  /** Every designated exact lookup returns its turn at rank <= lookupK. */
  exactLookupAccuracy: 1,
  lookupK: 1,
  /** BM25 result depth inspected for role safety on each lookup. */
  lookupDepth: 10,
  /** Every gold turn archived with identical identity, role, text and tags. */
  provenanceRoleAccuracy: 1,
  /** Archived turns that the gold archive does not have. */
  unexpectedArchiveTurns: 0,
  /** Native units whose import outcome differs from the expected outcome. */
  unitFailures: 0,
  /** Fixture secrets (or secret markers) found on any persisted/delivered surface. */
  secretLeaks: 0,
  /** Injected-context / task-prompt noise archived or delivered as human. */
  noiseAsHuman: 0,
  /** Delivered items whose role signals disagree or present a suggestion as human. */
  roleSafetyViolations: 0,
  /** Capsule evidence outside a project filter (basename collision leak). */
  collisionLeaks: 0,
  /** Gold-arm-covered answer-bearing turns the pipeline arm does not cover. */
  coverageRegressions: 0,
  /** Shared bounded delivery for both arms (Context Capsule, lexical-only). */
  capsule: {
    depthPolicy: "fast",
    budgetTokens: 16_000,
    budgetBytes: 16_000,
    safetyMarginTokens: 0,
    safetyMarginBytes: 0,
    limit: 20,
    candidateLimit: 40,
  },
} as const;

let results: Promise<SessionsResults> | null = null;

function getResults(): Promise<SessionsResults> {
  results ??= getSessionsEval().then((ctx) =>
    measureSessions(ctx, SESSIONS_GATE)
  );
  return results;
}

const ratio = (num: number, den: number): string =>
  den === 0 ? "n/a" : `${num}/${den}`;

const pass = (ok: boolean, metadata?: unknown) => ({
  score: ok ? 1 : 0,
  ...(metadata === undefined ? {} : { metadata }),
});

// Close both stores and delete /tmp/gno-sessions-eval-* once the last suite
// in this file has run (process `beforeExit` never fires in vitest workers).
afterAll(async () => {
  results = null;
  await cleanupSessionsEval();
});

// ─────────────────────────────────────────────────────────────────────────────
// Suites
// ─────────────────────────────────────────────────────────────────────────────

evalite("Sessions 0: fixture integrity", {
  data: async () => [{ input: SESSIONS_FIXTURE_MANIFEST, expected: null }],
  task: async () => await verifySessionsManifest(),
  scorers: [
    {
      name: "Fixtures match manifest",
      description:
        "Every fixture file is pinned and its sha256 equals the committed manifest",
      scorer: ({ output }) => pass(output.committed === output.rebuilt, output),
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

evalite("Sessions 1: per-format gate", {
  data: async () => {
    const cases = await loadSessionsCases();
    return [...cases.formats, "overall"].map((format) => ({
      input: format,
      expected: null,
    }));
  },
  task: async (format) => formatReport(await getResults(), format),
  scorers: [
    {
      name: "Units imported",
      description: `Native units reach their expected outcome (failures <= ${SESSIONS_GATE.unitFailures})`,
      scorer: ({ output }) =>
        pass(
          output.units.failures.length <= SESSIONS_GATE.unitFailures,
          output.units.failures
        ),
    },
    {
      name: "Provenance + role fidelity",
      description: `Gold turns archived with identical identity, role, text, time and tags (gate ${SESSIONS_GATE.provenanceRoleAccuracy}); unexpected turns <= ${SESSIONS_GATE.unexpectedArchiveTurns}`,
      scorer: ({ output }) =>
        pass(
          (output.fidelity.gold === 0 ||
            output.fidelity.matched / output.fidelity.gold >=
              SESSIONS_GATE.provenanceRoleAccuracy) &&
            output.fidelity.extra <= SESSIONS_GATE.unexpectedArchiveTurns,
          output.fidelity.problems
        ),
    },
    {
      name: "Exact lookups",
      description: `Designated lookups rank-${SESSIONS_GATE.lookupK} with verified identity, role and provenance (gate ${SESSIONS_GATE.exactLookupAccuracy})`,
      scorer: ({ output }) =>
        pass(
          output.lookups.total === 0 ||
            output.lookups.pass / output.lookups.total >=
              SESSIONS_GATE.exactLookupAccuracy,
          output.lookups.failures
        ),
    },
    {
      name: "Coverage vs gold",
      description: `No gold-arm-covered answer-bearing turn missing from the pipeline arm (regressions <= ${SESSIONS_GATE.coverageRegressions})`,
      scorer: ({ output }) =>
        pass(output.regressions.length <= SESSIONS_GATE.coverageRegressions, {
          regressions: output.regressions,
          abstentions: output.abstentions,
        }),
    },
    {
      name: "Secret leaks",
      description: `Fixture secrets on any surface (gate ${SESSIONS_GATE.secretLeaks})`,
      scorer: ({ output }) =>
        pass(
          output.secretLeaks.length <= SESSIONS_GATE.secretLeaks,
          output.secretLeaks
        ),
    },
    {
      name: "Noise as human",
      description: `Injected context / task prompts archived or delivered as human (gate ${SESSIONS_GATE.noiseAsHuman})`,
      scorer: ({ output }) =>
        pass(
          output.noiseAsHuman.length <= SESSIONS_GATE.noiseAsHuman,
          output.noiseAsHuman
        ),
    },
  ],
  columns: ({ output }) => [
    { label: "Format", value: output.format },
    { label: "Units", value: ratio(output.units.ok, output.units.total) },
    {
      label: "Fidelity",
      value: `${ratio(output.fidelity.matched, output.fidelity.gold)} (+${output.fidelity.extra} extra)`,
    },
    {
      label: "Lookups",
      value: ratio(output.lookups.pass, output.lookups.total),
    },
    {
      label: "Coverage pipeline / gold",
      value: `${ratio(output.coverage.pipeline, output.coverage.total)} / ${ratio(output.coverage.gold, output.coverage.total)}`,
    },
    { label: "Leaks", value: String(output.secretLeaks.length) },
    { label: "Noise→human", value: String(output.noiseAsHuman.length) },
    {
      label: "Failures",
      value:
        [
          ...output.units.failures,
          ...output.fidelity.problems,
          ...output.lookups.failures,
          ...output.regressions.map((item) => `coverage regression ${item}`),
          ...output.abstentions.map((item) => `abstained ${item}`),
        ].join("\n") || "-",
    },
  ],
});

evalite("Sessions 2: exact lookups", {
  data: async () => {
    const cases = await loadSessionsCases();
    return cases.lookups.map((lookup) => ({
      input: lookup.id,
      expected: lookup.expect,
    }));
  },
  task: async (id) => {
    const found = (await getResults()).lookups.find((item) => item.id === id);
    if (!found) throw new Error(`lookup ${id} missing`);
    return found;
  },
  scorers: [
    {
      name: `Rank <= ${SESSIONS_GATE.lookupK} with identity, role, provenance`,
      description:
        "Pipeline arm; the delivered item must carry the exact gold turn text, native turn id, thread, role and every expected label",
      scorer: ({ output }) => pass(output.pass, output.problems),
    },
  ],
  columns: ({ output }) => [
    { label: "Lookup", value: output.id },
    { label: "Format", value: output.format },
    { label: "Role", value: output.role },
    { label: "Pipeline rank", value: String(output.pipelineRank ?? "miss") },
    { label: "Gold rank", value: String(output.goldRank ?? "miss") },
    { label: "Problems", value: output.problems.join("; ") || "-" },
  ],
});

evalite("Sessions 3: multi-session coverage", {
  data: async () => {
    const cases = await loadSessionsCases();
    return cases.questions.map((question) => ({
      input: question.id,
      expected: question.gold,
    }));
  },
  task: async (id) => {
    const found = (await getResults()).questions.find((item) => item.id === id);
    if (!found) throw new Error(`question ${id} missing`);
    return found;
  },
  scorers: [
    {
      name: "No regression vs gold",
      description: `Same capsule budget (${SESSIONS_GATE.capsule.budgetTokens} tokens / ${SESSIONS_GATE.capsule.budgetBytes} bytes, ${SESSIONS_GATE.capsule.depthPolicy}); every gold-arm-covered turn is also covered by the pipeline arm`,
      scorer: ({ output }) =>
        pass(output.regressions.length <= SESSIONS_GATE.coverageRegressions, {
          regressions: output.regressions,
          pipelineMissing: output.pipeline.missingReasons,
          goldMissing: output.gold.missingReasons,
        }),
    },
    {
      name: "Collision isolation",
      description: `Pipeline evidence outside a project filter (gate ${SESSIONS_GATE.collisionLeaks})`,
      scorer: ({ output }) =>
        pass(
          output.pipeline.collisionLeaks.length <= SESSIONS_GATE.collisionLeaks,
          output.pipeline.collisionLeaks
        ),
    },
    {
      name: "Budget respected",
      description: "Delivered capsules stay within the frozen budget",
      scorer: ({ output }) =>
        pass(output.pipeline.withinBudget && output.gold.withinBudget),
    },
  ],
  columns: ({ output }) => [
    { label: "Question", value: output.id },
    { label: "Formats", value: output.formats.join(", ") },
    {
      label: "Pipeline",
      value: `${output.pipeline.covered.length}/${output.goldTurns}${output.pipeline.abstention ? ` (abstained: ${output.pipeline.abstention})` : ""}`,
    },
    {
      label: "Gold",
      value: `${output.gold.covered.length}/${output.goldTurns}${output.gold.abstention ? ` (abstained: ${output.gold.abstention})` : ""}`,
    },
    {
      label: "Evidence / bytes",
      value: `${output.pipeline.evidence} / ${output.pipeline.usedBytes ?? "-"} vs ${output.gold.evidence} / ${output.gold.usedBytes ?? "-"}`,
    },
    {
      label: "Regressions (pipeline reason)",
      value:
        output.regressions
          .map(
            (key) =>
              `${key}: ${output.pipeline.missingReasons[key] ?? "unknown"}`
          )
          .join("\n") || "-",
    },
  ],
});

evalite("Sessions 4: role safety and secret scan", {
  data: async () => [{ input: "all delivered surfaces", expected: null }],
  task: async () => {
    const r = await getResults();
    return {
      roleSafety: r.roleSafety,
      noiseAsHuman: r.noiseAsHuman,
      secretLeaks: r.secretLeaks,
    };
  },
  scorers: [
    {
      name: "Role safety",
      description: `Delivered items with missing/disagreeing role signals or an assistant suggestion presented as human (gate ${SESSIONS_GATE.roleSafetyViolations})`,
      scorer: ({ output }) =>
        pass(
          output.roleSafety.length <= SESSIONS_GATE.roleSafetyViolations,
          output.roleSafety
        ),
    },
    {
      name: "Zero secret leaks",
      description:
        "Archives, state, raw index DB bytes, config/cache dirs, receipts, delivered text and lexical probes",
      scorer: ({ output }) =>
        pass(
          output.secretLeaks.length <= SESSIONS_GATE.secretLeaks,
          output.secretLeaks
        ),
    },
  ],
  columns: ({ output }) => [
    { label: "Role violations", value: String(output.roleSafety.length) },
    { label: "Noise→human", value: String(output.noiseAsHuman.length) },
    { label: "Secret leaks", value: String(output.secretLeaks.length) },
    {
      label: "Detail",
      value:
        [
          ...output.roleSafety,
          ...output.noiseAsHuman.map((item) => `${item.text} at ${item.where}`),
          ...output.secretLeaks.map(
            (leak) => `${leak.secret} in ${leak.surface}`
          ),
        ].join("\n") || "-",
    },
  ],
});
