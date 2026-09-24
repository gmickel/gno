/**
 * Sessions eval scoring: every measurement the gate asserts, computed once
 * over both arms, plus the per-format report (failures and abstentions are
 * listed per native format, never averaged away).
 *
 * All expectations come from the hand-normalized gold turns and `cases.json`;
 * nothing is derived from the pipeline's own output.
 *
 * @module evals/helpers/sessions-scoring
 */

// node:path has no Bun path utilities
import { basename, dirname } from "node:path";

import type { SessionImportReceipt } from "../../src/sessions/types";
import type { CapsuleSettings, DeliveredItem } from "./sessions-delivery";
import type { GoldTurn } from "./sessions-fixtures";
import type {
  Arm,
  PipelineArchiveLine,
  SessionsEvalContext,
} from "./sessions-harness";

import { searchBm25 } from "../../src/pipeline/search";
import {
  carriesTurn,
  deliveredRole,
  goldTextSource,
  itemKey,
  presentsText,
  projectFilter,
  runCapsule,
  runLookup,
  speakerLabel,
} from "./sessions-delivery";
import { ARMS, rawSurface } from "./sessions-harness";

/** The delivery settings `measure` needs from the frozen gate. */
export interface SessionsMeasureSettings {
  lookupK: number;
  lookupDepth: number;
  capsule: CapsuleSettings;
}

export interface UnitResult {
  sourceId: string;
  locator: string;
  format: string;
  expected: string;
  outcome: string;
  reason?: string;
  ok: boolean;
}

export interface FidelityMismatch {
  key: string;
  format: string;
  problem: string;
}

export interface LookupResult {
  id: string;
  query: string;
  expect: string;
  format: string;
  role: string;
  pipelineRank: number | null;
  goldRank: number | null;
  pipelineTop: string | null;
  pass: boolean;
  problems: string[];
}

export interface QuestionArmResult {
  covered: string[];
  missing: string[];
  /** Why each missing turn is missing: a capsule omission reason or "not retrieved". */
  missingReasons: Record<string, string>;
  evidence: number;
  usedTokens: number | null;
  usedBytes: number | null;
  withinBudget: boolean;
  abstention: string | null;
  collisionLeaks: string[];
}

export interface QuestionResult {
  id: string;
  goldTurns: number;
  formats: string[];
  pipeline: QuestionArmResult;
  gold: QuestionArmResult;
  /** Gold-arm-covered turns the pipeline arm did not cover. */
  regressions: string[];
}

export interface SessionsResults {
  units: UnitResult[];
  fidelity: {
    byFormat: Record<string, { gold: number; matched: number; extra: number }>;
    mismatches: FidelityMismatch[];
  };
  lookups: LookupResult[];
  questions: QuestionResult[];
  roleSafety: string[];
  noiseAsHuman: Array<{ text: string; format: string; where: string }>;
  secretLeaks: Array<{ secret: string; format: string; surface: string }>;
  formatOf: Map<string, string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Archive fidelity (pipeline archive vs gold turns)
// ─────────────────────────────────────────────────────────────────────────────

const PROVENANCE_SPLIT = "\n\nProvenance: ";

const archiveKey = (line: PipelineArchiveLine): string =>
  `${line.threadId}#${line.provenance.turnId}`;

/** Pipeline category contract for a gold turn (spec: harness/project labels). */
function expectedCategories(
  gold: GoldTurn,
  projectIds: Record<string, string>
): string[] {
  const categories = [
    "session",
    `harness/${gold.harness}`,
    `session-kind/${gold.kind}`,
    `role/${gold.role}`,
  ];
  if (gold.project) {
    categories.push(`project/${basename(gold.project)}`);
    categories.push(`project-id/${projectIds[gold.project] ?? "?"}`);
  }
  return categories.sort();
}

const sameInstant = (left: string | undefined, right: string): boolean =>
  left !== undefined && Date.parse(left) === Date.parse(right);

function fidelityProblems(
  gold: GoldTurn,
  actual: PipelineArchiveLine,
  projectIds: Record<string, string>
): string[] {
  const problems: string[] = [];
  if (actual.author !== gold.role) {
    problems.push(`author ${actual.author} != ${gold.role}`);
  }
  // Main threads omit sessionId: they are their own session.
  const session = actual.sessionId ?? actual.threadId;
  if (session !== gold.sessionKey) {
    problems.push(`session ${session} != ${gold.sessionKey}`);
  }
  if (!sameInstant(actual.recordedAt, gold.at)) {
    problems.push(`recordedAt ${actual.recordedAt ?? "none"} != ${gold.at}`);
  }
  if (actual.provenance.threadKind !== gold.kind) {
    problems.push(`threadKind ${actual.provenance.threadKind} != ${gold.kind}`);
  }
  const actualTags = [...actual.categories].sort().join(",");
  const expectedTags = expectedCategories(gold, projectIds).join(",");
  if (actualTags !== expectedTags) {
    problems.push(`categories [${actualTags}] != [${expectedTags}]`);
  }
  const spoken = actual.body.split(PROVENANCE_SPLIT)[0] ?? actual.body;
  const expected = new RegExp(
    `^${speakerLabel(gold.role)}: ${goldTextSource(gold.text)}$`
  );
  if (!expected.test(spoken)) {
    problems.push(
      `text ${JSON.stringify(spoken)} != gold ${JSON.stringify(gold.text)}`
    );
  }
  return problems;
}

// ─────────────────────────────────────────────────────────────────────────────
// Measure
// ─────────────────────────────────────────────────────────────────────────────

function measureUnits(ctx: SessionsEvalContext): UnitResult[] {
  const expectedKeys = new Set(
    ctx.cases.units.map((unit) => `${unit.sourceId}\0${unit.locator}`)
  );
  const seen = new Map<string, SessionImportReceipt["units"][number]>();
  for (const receipt of ctx.receipts) {
    for (const unit of receipt.units) {
      seen.set(`${unit.sourceId}\0${unit.locator}`, unit);
    }
  }
  const units: UnitResult[] = ctx.cases.units.map((expected) => {
    const actual = seen.get(`${expected.sourceId}\0${expected.locator}`);
    return {
      sourceId: expected.sourceId,
      locator: expected.locator,
      format: expected.format,
      expected: expected.outcome,
      outcome: actual?.outcome ?? "missing",
      reason: actual?.reason,
      ok: actual?.outcome === expected.outcome,
    };
  });
  for (const [key, unit] of seen) {
    if (expectedKeys.has(key)) continue;
    units.push({
      sourceId: unit.sourceId,
      locator: unit.locator,
      format: "unexpected-unit",
      expected: "none",
      outcome: unit.outcome,
      reason: unit.reason,
      ok: false,
    });
  }
  return units;
}

function measureFidelity(
  ctx: SessionsEvalContext,
  goldByKey: Map<string, GoldTurn>
): SessionsResults["fidelity"] {
  const unitFormat = new Map(
    ctx.cases.units.map((unit) => [
      `${unit.sourceId}\0${unit.locator}`,
      unit.format,
    ])
  );
  const byFormat: SessionsResults["fidelity"]["byFormat"] = {};
  for (const format of ctx.cases.formats) {
    byFormat[format] = { gold: 0, matched: 0, extra: 0 };
  }
  const mismatches: FidelityMismatch[] = [];
  const pipelineByKey = new Map<string, PipelineArchiveLine>();
  for (const line of ctx.pipelineLines) {
    const key = archiveKey(line);
    if (pipelineByKey.has(key)) {
      mismatches.push({
        key,
        format: goldByKey.get(key)?.format ?? "unknown",
        problem: "duplicate archived turn",
      });
    }
    pipelineByKey.set(key, line);
  }
  for (const [key, gold] of goldByKey) {
    const bucket = (byFormat[gold.format] ??= {
      gold: 0,
      matched: 0,
      extra: 0,
    });
    bucket.gold += 1;
    const actual = pipelineByKey.get(key);
    if (!actual) {
      mismatches.push({
        key,
        format: gold.format,
        problem: "missing from archive",
      });
      continue;
    }
    const problems = fidelityProblems(gold, actual, ctx.cases.projectIds);
    if (problems.length === 0) bucket.matched += 1;
    else
      mismatches.push({
        key,
        format: gold.format,
        problem: problems.join("; "),
      });
  }
  for (const [key, line] of pipelineByKey) {
    if (goldByKey.has(key)) continue;
    const format =
      unitFormat.get(
        `${line.provenance.sourceId}\0${line.provenance.unit ?? ""}`
      ) ?? "unknown";
    (byFormat[format] ??= { gold: 0, matched: 0, extra: 0 }).extra += 1;
    const spoken = line.body.split(PROVENANCE_SPLIT)[0] ?? line.body;
    mismatches.push({
      key,
      format,
      problem: `unexpected ${line.author} turn: ${JSON.stringify(spoken.slice(0, 120))}`,
    });
  }
  return { byFormat, mismatches };
}

async function measureLookups(
  ctx: SessionsEvalContext,
  goldByKey: Map<string, GoldTurn>,
  settings: SessionsMeasureSettings,
  delivered: DeliveredItem[]
): Promise<LookupResult[]> {
  const lookups: LookupResult[] = [];
  for (const lookup of ctx.cases.lookups) {
    const gold = goldByKey.get(lookup.expect);
    if (!gold) throw new Error(`lookup ${lookup.id}: unknown gold turn`);
    const ranks: Record<Arm, number | null> = { pipeline: null, gold: null };
    let pipelineTop: string | null = null;
    const problems: string[] = [];
    for (const arm of ARMS) {
      const items = await runLookup(
        ctx.arms[arm],
        lookup.query,
        settings.lookupDepth,
        `lookup ${lookup.id}`
      );
      delivered.push(...items);
      const index = items.findIndex((item) => carriesTurn(item, gold));
      ranks[arm] = index === -1 ? null : index + 1;
      if (arm !== "pipeline") continue;
      const top = items[0];
      pipelineTop = top ? itemKey(top) : null;
      if (!top) {
        problems.push("no result (abstention)");
        continue;
      }
      if (ranks.pipeline === null || ranks.pipeline > settings.lookupK) {
        problems.push(
          `expected turn at rank ${ranks.pipeline ?? "none"}; top was ${pipelineTop}`
        );
      }
      const hit = ranks.pipeline ? items[ranks.pipeline - 1] : undefined;
      if (hit) {
        for (const tag of expectedCategories(gold, ctx.cases.projectIds)) {
          if (!hit.categories.includes(tag)) {
            problems.push(`delivered provenance lacks ${tag}`);
          }
        }
      }
    }
    lookups.push({
      id: lookup.id,
      query: lookup.query,
      expect: lookup.expect,
      format: gold.format,
      role: gold.role,
      pipelineRank: ranks.pipeline,
      goldRank: ranks.gold,
      pipelineTop,
      pass: problems.length === 0,
      problems,
    });
  }
  return lookups;
}

async function measureQuestions(
  ctx: SessionsEvalContext,
  goldByKey: Map<string, GoldTurn>,
  settings: SessionsMeasureSettings,
  delivered: DeliveredItem[],
  capsules: Array<{ arm: Arm; id: string; capsule: unknown }>
): Promise<QuestionResult[]> {
  const questions: QuestionResult[] = [];
  for (const question of ctx.cases.questions) {
    const golds = question.gold.map((key) => {
      const turn = goldByKey.get(key);
      if (!turn) throw new Error(`question ${question.id}: unknown ${key}`);
      return turn;
    });
    const perArm = {} as Record<Arm, QuestionArmResult>;
    for (const arm of ARMS) {
      const run = await runCapsule(
        ctx.arms[arm],
        question,
        settings.capsule,
        ctx.cases.projectIds
      );
      capsules.push({
        arm,
        id: question.id,
        capsule: run.capsule ?? run.abstention,
      });
      delivered.push(...run.items);
      const covered = golds
        .filter((turn) => run.items.some((item) => carriesTurn(item, turn)))
        .map((turn) => turn.key);
      const filter = question.project
        ? projectFilter(arm, question.project, ctx.cases.projectIds)
        : null;
      const budget = run.capsule?.budget;
      const missingReasons: Record<string, string> = {};
      for (const turn of golds) {
        if (covered.includes(turn.key)) continue;
        const pattern = new RegExp(goldTextSource(turn.text));
        const omitted = run.omitted.find((item) => pattern.test(item.text));
        missingReasons[turn.key] = omitted
          ? `omitted: ${omitted.reason}`
          : run.items.some((item) => pattern.test(item.text))
            ? "delivered without verified identity/role"
            : "not retrieved";
      }
      perArm[arm] = {
        covered,
        missingReasons,
        missing: golds
          .map((turn) => turn.key)
          .filter((key) => !covered.includes(key)),
        evidence: run.items.length,
        usedTokens: budget?.usedTokens ?? null,
        usedBytes: budget?.usedBytes ?? null,
        withinBudget: budget
          ? budget.usedTokens <= settings.capsule.budgetTokens &&
            budget.usedBytes <= settings.capsule.budgetBytes
          : true,
        abstention: run.abstention,
        collisionLeaks: filter
          ? run.items
              .filter((item) => !item.categories.includes(filter))
              .map((item) => `${itemKey(item)} [${item.categories.join(", ")}]`)
          : [],
      };
    }
    questions.push({
      id: question.id,
      goldTurns: golds.length,
      formats: [...new Set(golds.map((turn) => turn.format))],
      pipeline: perArm.pipeline,
      gold: perArm.gold,
      regressions: perArm.gold.covered.filter(
        (key) => !perArm.pipeline.covered.includes(key)
      ),
    });
  }
  return questions;
}

function measureRoleSafety(
  ctx: SessionsEvalContext,
  delivered: DeliveredItem[]
): Pick<SessionsResults, "roleSafety" | "noiseAsHuman"> {
  const assistantTexts = ctx.gold
    .filter((turn) => turn.role === "assistant")
    .map((turn) => turn.text);
  const roleSafety: string[] = [];
  const noiseAsHuman: SessionsResults["noiseAsHuman"] = [];
  for (const item of delivered) {
    const where = `${item.arm} ${item.surface} ${itemKey(item)}`;
    if (!deliveredRole(item)) {
      roleSafety.push(
        `${where}: role signals missing or disagree (${item.roles.map(String).join(", ")})`
      );
    }
    if (!item.roles.includes("human")) continue;
    for (const text of assistantTexts) {
      if (presentsText(item, text, "human")) {
        roleSafety.push(`${where}: assistant suggestion delivered as human`);
      }
    }
    for (const noise of ctx.cases.neverHuman) {
      if (item.text.includes(noise.text)) {
        noiseAsHuman.push({ text: noise.text, format: noise.format, where });
      }
    }
  }
  for (const line of ctx.pipelineLines) {
    if (line.author !== "human") continue;
    for (const noise of ctx.cases.neverHuman) {
      if (line.body.includes(noise.text)) {
        noiseAsHuman.push({
          text: noise.text,
          format: noise.format,
          where: `pipeline archive ${archiveKey(line)}`,
        });
      }
    }
  }
  return { roleSafety, noiseAsHuman };
}

async function measureSecrets(
  ctx: SessionsEvalContext,
  delivered: DeliveredItem[],
  capsules: unknown
): Promise<SessionsResults["secretLeaks"]> {
  // Archives + state, index DBs (raw bytes), config/cache, receipts,
  // delivered text and a lexical probe of both indexes.
  const surfaces: Array<[string, string]> = [
    [
      "pipeline archive + state",
      await rawSurface(dirname(ctx.arms.pipeline.collectionDir)),
    ],
    ["gold archive", await rawSurface(ctx.arms.gold.collectionDir)],
    ["index data dir", await rawSurface(process.env.GNO_DATA_DIR ?? "")],
    ["gno config dir", await rawSurface(process.env.GNO_CONFIG_DIR ?? "")],
    ["gno cache dir", await rawSurface(process.env.GNO_CACHE_DIR ?? "")],
    ["import receipts", JSON.stringify(ctx.receipts)],
    ["delivered lookups + capsules", JSON.stringify({ delivered, capsules })],
  ];
  const probes = [
    ...ctx.cases.secrets.map((secret) => ({
      needle: secret.value,
      format: secret.format,
    })),
    ...ctx.cases.secretMarkers.map((marker) => ({
      needle: marker,
      format: "marker",
    })),
  ];
  const leaks: SessionsResults["secretLeaks"] = [];
  for (const [surface, content] of surfaces) {
    for (const probe of probes) {
      if (content.includes(probe.needle)) {
        leaks.push({ secret: probe.needle, format: probe.format, surface });
      }
    }
  }
  for (const arm of ARMS) {
    for (const secret of ctx.cases.secrets) {
      const probe = secret.value.replaceAll("-", " ");
      const found = await searchBm25(ctx.arms[arm].store, probe, { limit: 5 });
      if (found.ok && found.value.results.length > 0) {
        leaks.push({
          secret: secret.value,
          format: secret.format,
          surface: `${arm} lexical index`,
        });
      }
    }
  }
  return leaks;
}

export async function measureSessions(
  ctx: SessionsEvalContext,
  settings: SessionsMeasureSettings
): Promise<SessionsResults> {
  const goldByKey = new Map(ctx.gold.map((turn) => [turn.key, turn]));
  const formatOf = new Map(ctx.gold.map((turn) => [turn.key, turn.format]));
  const delivered: DeliveredItem[] = [];
  const capsules: Array<{ arm: Arm; id: string; capsule: unknown }> = [];
  const units = measureUnits(ctx);
  const fidelity = measureFidelity(ctx, goldByKey);
  const lookups = await measureLookups(ctx, goldByKey, settings, delivered);
  const questions = await measureQuestions(
    ctx,
    goldByKey,
    settings,
    delivered,
    capsules
  );
  const { roleSafety, noiseAsHuman } = measureRoleSafety(ctx, delivered);
  const secretLeaks = await measureSecrets(ctx, delivered, capsules);
  return {
    units,
    fidelity,
    lookups,
    questions,
    roleSafety,
    noiseAsHuman,
    secretLeaks,
    formatOf,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-format report
// ─────────────────────────────────────────────────────────────────────────────

export interface FormatReport {
  format: string;
  units: { ok: number; total: number; failures: string[] };
  fidelity: {
    matched: number;
    gold: number;
    extra: number;
    problems: string[];
  };
  lookups: { pass: number; total: number; failures: string[] };
  coverage: { pipeline: number; gold: number; total: number };
  regressions: string[];
  abstentions: string[];
  secretLeaks: string[];
  noiseAsHuman: string[];
}

export function formatReport(r: SessionsResults, format: string): FormatReport {
  const all = format === "overall";
  const inFormat = (value: string): boolean => all || value === format;
  const units = r.units.filter((unit) => inFormat(unit.format));
  const buckets = all
    ? Object.values(r.fidelity.byFormat)
    : [r.fidelity.byFormat[format] ?? { gold: 0, matched: 0, extra: 0 }];
  const lookups = r.lookups.filter((lookup) => inFormat(lookup.format));
  const coverage = { pipeline: 0, gold: 0, total: 0 };
  const regressions: string[] = [];
  const abstentions = new Set<string>();
  for (const question of r.questions) {
    for (const key of [
      ...question.pipeline.covered,
      ...question.pipeline.missing,
    ]) {
      if (!inFormat(r.formatOf.get(key) ?? "unknown")) continue;
      coverage.total += 1;
      if (question.pipeline.covered.includes(key)) coverage.pipeline += 1;
      if (question.gold.covered.includes(key)) coverage.gold += 1;
      if (question.regressions.includes(key)) {
        regressions.push(`${question.id}: ${key}`);
      }
      for (const arm of ARMS) {
        const abstention = question[arm].abstention;
        if (abstention) abstentions.add(`${question.id} ${arm}: ${abstention}`);
      }
    }
  }
  return {
    format,
    units: {
      ok: units.filter((unit) => unit.ok).length,
      total: units.length,
      failures: units
        .filter((unit) => !unit.ok)
        .map(
          (unit) =>
            `${unit.locator}: ${unit.outcome}${unit.reason ? ` (${unit.reason})` : ""}`
        ),
    },
    fidelity: {
      matched: buckets.reduce((sum, bucket) => sum + bucket.matched, 0),
      gold: buckets.reduce((sum, bucket) => sum + bucket.gold, 0),
      extra: buckets.reduce((sum, bucket) => sum + bucket.extra, 0),
      problems: r.fidelity.mismatches
        .filter((item) => inFormat(item.format))
        .map((item) => `${item.key}: ${item.problem}`),
    },
    lookups: {
      pass: lookups.filter((lookup) => lookup.pass).length,
      total: lookups.length,
      failures: lookups
        .filter((lookup) => !lookup.pass)
        .map((lookup) => `${lookup.id}: ${lookup.problems.join("; ")}`),
    },
    coverage,
    regressions,
    abstentions: [...abstentions],
    secretLeaks: r.secretLeaks
      .filter((leak) => all || leak.format === format)
      .map((leak) => `${leak.secret} in ${leak.surface}`),
    noiseAsHuman: r.noiseAsHuman
      .filter((item) => inFormat(item.format))
      .map((item) => `${item.text} at ${item.where}`),
  };
}
