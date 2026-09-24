/**
 * Sessions eval: cross-session retrieval gate for native agent-session
 * ingestion (fn-171 R6).
 *
 * Two arms are indexed with identical settings in separate temp indexes:
 * - pipeline: the real `SessionsService.import` of synthetic native fixtures
 *   for every supported harness format into a temp session archive;
 * - gold: the manually normalized archive in `fixtures/sessions/gold/`,
 *   synced into its own archive collection with the same field mapping.
 *
 * Everything runs offline and lexical-only (BM25 search, Context Capsule
 * `depthPolicy: "fast"`, no embedding/rerank/expansion model), so every
 * number is deterministic run to run. The thresholds in SESSIONS_GATE were
 * frozen before the arms were compared. A sub-threshold result is a finding
 * against src/sessions, never something to tune away here: do not lower a
 * threshold or edit a fixture to make the pipeline pass. Failures and
 * abstentions are reported per native format and never averaged away.
 *
 * Run: `bun run eval:sessions` (opt-in, local-only, no network, no LLM judge).
 *
 * @module evals/sessions.eval
 */

import { Database } from "bun:sqlite";
import { evalite } from "evalite";
// node:fs/promises for mkdtemp/mkdir/cp/readdir (filesystem structure ops)
import { cp, mkdir, mkdtemp, readdir } from "node:fs/promises";
// node:os provides the temporary root
import { tmpdir } from "node:os";
// node:path has no Bun path utilities
import { dirname, join, relative } from "node:path";
// node:url resolves this module's directory under both Bun and vitest workers
import { fileURLToPath } from "node:url";
// evalite runs eval files inside vitest workers; file-level afterAll is the
// only hook that reliably fires once every suite in this file has finished.
import { afterAll } from "vitest";

import type { Config } from "../src/config/types";
import type { ContextCapsuleV1 } from "../src/core/context-capsule";
import type { QueryModeInput } from "../src/pipeline/types";
import type { SessionImportReceipt } from "../src/sessions/types";
import type { SqliteAdapter } from "../src/store/sqlite/adapter";

import { buildContextCapsule } from "../src/app/context-runtime";
import { initStore } from "../src/cli/commands/shared";
import { defaultSyncService, withContentTypeRules } from "../src/ingestion";
import { searchBm25 } from "../src/pipeline/search";
import {
  addSessionSource,
  initSessionArchive,
  SessionsService,
} from "../src/sessions/service";
import { safeRm } from "../test/helpers/cleanup";

// ─────────────────────────────────────────────────────────────────────────────
// Frozen gate
// ─────────────────────────────────────────────────────────────────────────────

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
  /** Delivered items whose role labels disagree or present a suggestion as human. */
  roleSafetyViolations: 0,
  /** Capsule evidence outside a project-id filter (basename collision leak). */
  collisionLeaks: 0,
  /** Questions where the pipeline covers fewer gold turns than the gold arm. */
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

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures and manifest
// ─────────────────────────────────────────────────────────────────────────────

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
export const SESSIONS_FIXTURE_ROOT = join(EVAL_DIR, "fixtures/sessions");
const MANIFEST = "manifest.json";

type Role = "human" | "assistant";

interface CasesFixture {
  suite: "sessions";
  description: string;
  sources: Array<{
    id: string;
    harness: "codex" | "claude-code" | "openclaw" | "hermes";
    native: string | null;
    sqlite: Record<string, string>;
  }>;
  formats: string[];
  units: Array<{
    sourceId: string;
    locator: string;
    format: string;
    outcome: string;
  }>;
  secrets: Array<{ value: string; format: string; where: string }>;
  secretMarkers: string[];
  neverHuman: Array<{ text: string; format: string; kind: string }>;
  lookups: Array<{ id: string; query: string; expect: string }>;
  questions: Array<{
    id: string;
    goal: string;
    queryModes: QueryModeInput[];
    author?: Role;
    categories?: string[];
    gold: string[];
  }>;
}

interface ArchiveLine {
  id: string;
  title: string;
  body: string;
  author: Role;
  categories: string[];
  sessionId: string;
  threadId: string;
  recordedAt?: string;
  provenance: {
    sourceId: string;
    harness: string;
    turnId: string;
    threadKind: string;
    format?: string;
    unit?: string;
  };
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, {
    recursive: true,
    withFileTypes: true,
  }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

const sha256 = (bytes: ArrayBuffer | string): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** sha256 of every fixture file except the manifest, keyed by relative path. */
export async function buildSessionsManifest(): Promise<{
  algorithm: "sha256";
  files: Record<string, string>;
}> {
  const files: Record<string, string> = {};
  for (const file of await listFiles(SESSIONS_FIXTURE_ROOT)) {
    const rel = relative(SESSIONS_FIXTURE_ROOT, file).split("\\").join("/");
    if (rel === MANIFEST) continue;
    files[rel] = sha256(await Bun.file(file).arrayBuffer());
  }
  return { algorithm: "sha256", files };
}

const manifestDigest = (files: Record<string, string>): string =>
  sha256(
    Object.keys(files)
      .sort()
      .map((name) => `${name}:${files[name]}`)
      .join("\n")
  ).slice(0, 16);

/** Throws on any drifted, missing or unpinned fixture file. */
async function verifySessionsManifest(): Promise<{
  committed: string;
  rebuilt: string;
}> {
  const refresh =
    "review the change, then run: bun scripts/sessions-eval-fixtures.ts";
  const file = Bun.file(join(SESSIONS_FIXTURE_ROOT, MANIFEST));
  if (!(await file.exists())) {
    throw new Error(`Sessions fixture manifest missing; ${refresh}`);
  }
  const committed = (await file.json()) as {
    algorithm?: unknown;
    files?: Record<string, unknown>;
  };
  const actual = await buildSessionsManifest();
  if (committed.algorithm !== "sha256" || !committed.files) {
    throw new Error(`Sessions fixture manifest is malformed; ${refresh}`);
  }
  const pinned = committed.files;
  const drifted = Object.keys(actual.files).filter(
    (name) => pinned[name] !== actual.files[name]
  );
  const missing = Object.keys(pinned).filter((name) => !(name in actual.files));
  if (drifted.length > 0 || missing.length > 0) {
    throw new Error(
      `Sessions fixtures drifted from manifest.json (changed or unpinned: ${drifted.join(", ") || "-"}; missing: ${missing.join(", ") || "-"}); ${refresh}`
    );
  }
  return {
    committed: manifestDigest(pinned as Record<string, string>),
    rebuilt: manifestDigest(actual.files),
  };
}

let verified: ReturnType<typeof verifySessionsManifest> | null = null;

async function loadCases(): Promise<CasesFixture> {
  verified ??= verifySessionsManifest();
  await verified;
  return (await Bun.file(
    join(SESSIONS_FIXTURE_ROOT, "cases.json")
  ).json()) as CasesFixture;
}

function parseJsonl(content: string): ArchiveLine[] {
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ArchiveLine);
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivered-text parsing (identical for both arms)
// ─────────────────────────────────────────────────────────────────────────────

const PROVENANCE_SPLIT = "\n\n---\nSession provenance";
const MARKDOWN_ESCAPE = /\\([!-/:-@[-`{-~])/g;

const turnKey = (threadId: string, turnId: string): string =>
  `${threadId}#${turnId}`;

const spokenText = (body: string): string => {
  const head = body.split(PROVENANCE_SPLIT)[0] ?? body;
  return head.replace(/^(?:Human|Assistant): /, "");
};

const speakerLabel = (role: Role): string =>
  role === "human" ? "Human" : "Assistant";

interface DeliveredItem {
  arm: Arm;
  surface: string;
  /** Record metadata as returned by the retrieval surface. */
  author: string | null;
  recordThreadId: string | null;
  categories: string[];
  /** Delivered text after removing markdown escapes. */
  text: string;
  /** Parsed from the delivered text. */
  prefix: Role | null;
  speakerLine: Role | null;
  turnId: string | null;
  threadLine: string | null;
}

const lineValue = (text: string, label: string): string | null => {
  const match = new RegExp(`^- ${label}: (.+)$`, "m").exec(text);
  return match?.[1]?.trim() ?? null;
};

function parseDelivered(
  arm: Arm,
  surface: string,
  rawText: string,
  record:
    | { author?: string; threadId?: string; categories?: string[] }
    | undefined
): DeliveredItem {
  const text = rawText.replace(MARKDOWN_ESCAPE, "$1");
  const prefixMatch = /^(Human|Assistant): /m.exec(text);
  const speaker = lineValue(text, "Speaker");
  const toRole = (value: string | undefined | null): Role | null => {
    if (!value) return null;
    if (value.startsWith("Human")) return "human";
    if (value.startsWith("Assistant")) return "assistant";
    return null;
  };
  return {
    arm,
    surface,
    author: record?.author ?? null,
    recordThreadId: record?.threadId ?? null,
    categories: [...(record?.categories ?? [])].sort(),
    text,
    prefix: toRole(prefixMatch?.[1]),
    speakerLine: toRole(speaker),
    turnId: lineValue(text, "Logical turn"),
    threadLine: lineValue(text, "Thread"),
  };
}

/** Whether a delivered item carries the gold turn fully, with verified identity and role. */
function carriesTurn(item: DeliveredItem, gold: ArchiveLine): boolean {
  const role = gold.author;
  return (
    item.turnId === gold.provenance.turnId &&
    item.threadLine === gold.threadId &&
    item.recordThreadId === gold.threadId &&
    item.author === role &&
    item.prefix === role &&
    item.speakerLine === role &&
    item.text.includes(`${speakerLabel(role)}: ${spokenText(gold.body)}`)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Harness: one temp root, two arms
// ─────────────────────────────────────────────────────────────────────────────

type Arm = "pipeline" | "gold";

interface ArmContext {
  arm: Arm;
  configPath: string;
  indexName: string;
  archiveRoot: string;
  config: Config;
  store: SqliteAdapter;
}

interface SessionsEvalContext {
  root: string;
  cases: CasesFixture;
  arms: Record<Arm, ArmContext>;
  receipts: SessionImportReceipt[];
  goldLines: ArchiveLine[];
  pipelineLines: ArchiveLine[];
}

async function materializeSources(
  root: string,
  cases: CasesFixture
): Promise<Record<string, string>> {
  const roots: Record<string, string> = {};
  for (const source of cases.sources) {
    const target = join(root, "sources", source.harness);
    await mkdir(target, { recursive: true });
    if (source.native) {
      await cp(join(SESSIONS_FIXTURE_ROOT, source.native), target, {
        recursive: true,
      });
    }
    for (const [dbPath, sqlPath] of Object.entries(source.sqlite)) {
      const full = join(target, dbPath);
      await mkdir(dirname(full), { recursive: true });
      const db = new Database(full, { create: true });
      try {
        db.exec(await Bun.file(join(SESSIONS_FIXTURE_ROOT, sqlPath)).text());
      } finally {
        db.close();
      }
    }
    roots[source.id] = target;
  }
  return roots;
}

async function openArm(
  arm: Arm,
  root: string
): Promise<Omit<ArmContext, "config" | "store">> {
  const configPath = join(root, `${arm}.yml`);
  const indexName = `sessions-eval-${arm}`;
  const archiveRoot = join(root, `${arm}-archive`);
  await initSessionArchive({
    configPath,
    indexName,
    archiveRoot,
    collection: "work",
  });
  return { arm, configPath, indexName, archiveRoot };
}

async function openStore(
  base: Omit<ArmContext, "config" | "store">
): Promise<ArmContext> {
  const opened = await initStore({
    configPath: base.configPath,
    indexName: base.indexName,
    allowEmptyCollections: true,
  });
  if (!opened.ok) throw new Error(`${base.arm}: ${opened.error}`);
  return {
    ...base,
    config: opened.config,
    store: opened.store as SqliteAdapter,
  };
}

async function readArchive(dir: string): Promise<ArchiveLine[]> {
  const lines: ArchiveLine[] = [];
  for (const file of await listFiles(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    lines.push(...parseJsonl(await Bun.file(file).text()));
  }
  return lines;
}

async function setupSessionsEval(): Promise<SessionsEvalContext> {
  const cases = await loadCases();
  const root = await mkdtemp(join(tmpdir(), "gno-sessions-eval-"));
  // Keep every GNO config/data/cache lookup inside the temp root.
  process.env.GNO_CONFIG_DIR = join(root, "gno-config");
  process.env.GNO_DATA_DIR = join(root, "gno-data");
  process.env.GNO_CACHE_DIR = join(root, "gno-cache");
  const sourceRoots = await materializeSources(root, cases);

  // Pipeline arm: register every source, then import through the service.
  const pipelineBase = await openArm("pipeline", root);
  for (const source of cases.sources) {
    await addSessionSource({
      configPath: pipelineBase.configPath,
      id: source.id,
      harness: source.harness,
      path:
        source.harness === "hermes"
          ? join(sourceRoots[source.id]!, "state.db")
          : sourceRoots[source.id]!,
      collection: "work",
    });
  }
  const pipeline = await openStore(pipelineBase);
  const service = new SessionsService({
    config: pipeline.config,
    configPath: pipeline.configPath,
    indexName: pipeline.indexName,
    store: pipeline.store,
  });
  const receipts: SessionImportReceipt[] = [];
  for (const source of cases.sources) {
    receipts.push(
      await service.import({ sourceId: source.id }, { allowPaths: false })
    );
  }

  // Gold arm: the hand-normalized archive, synced with the same collection
  // definition and sync options the service uses.
  const goldBase = await openArm("gold", root);
  const goldCollectionDir = join(goldBase.archiveRoot, "work");
  await cp(join(SESSIONS_FIXTURE_ROOT, "gold/work"), goldCollectionDir, {
    recursive: true,
  });
  const gold = await openStore(goldBase);
  const goldCollection = gold.config.collections.find(
    (collection) => collection.name === "work"
  );
  if (!goldCollection) throw new Error("gold archive collection missing");
  await defaultSyncService.syncCollection(
    goldCollection,
    gold.store,
    withContentTypeRules({ runUpdateCmd: false, gitPull: false }, gold.config)
  );

  return {
    root,
    cases,
    arms: { pipeline, gold },
    receipts,
    goldLines: await readArchive(join(SESSIONS_FIXTURE_ROOT, "gold/work")),
    pipelineLines: await readArchive(join(pipeline.archiveRoot, "work")),
  };
}

let shared: Promise<SessionsEvalContext> | null = null;

function getSessionsEval(): Promise<SessionsEvalContext> {
  shared ??= setupSessionsEval();
  return shared;
}

async function cleanupSessionsEval(): Promise<void> {
  if (!shared) return;
  const pending = shared;
  shared = null;
  results = null;
  const ctx = await pending.catch(() => null);
  if (!ctx) return;
  await ctx.arms.pipeline.store.close();
  await ctx.arms.gold.store.close();
  await safeRm(ctx.root);
}

// ─────────────────────────────────────────────────────────────────────────────
// Measurements
// ─────────────────────────────────────────────────────────────────────────────

interface UnitResult {
  sourceId: string;
  locator: string;
  format: string;
  expected: string;
  outcome: string;
  reason?: string;
  warnings?: string[];
  unknownKinds?: Record<string, number>;
  ok: boolean;
}

interface FidelityMismatch {
  key: string;
  format: string;
  problem: string;
}

interface LookupResult {
  id: string;
  query: string;
  expect: string;
  format: string;
  role: Role;
  pipelineRank: number | null;
  goldRank: number | null;
  pipelineTop: string | null;
  pass: boolean;
  problems: string[];
}

interface QuestionArmResult {
  covered: string[];
  missing: string[];
  evidence: number;
  usedTokens: number | null;
  usedBytes: number | null;
  withinBudget: boolean;
  abstention: string | null;
  collisionLeaks: string[];
}

interface QuestionResult {
  id: string;
  goldTurns: number;
  formats: string[];
  pipeline: QuestionArmResult;
  gold: QuestionArmResult;
  regression: boolean;
}

interface SessionsResults {
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

const fidelityProblems = (gold: ArchiveLine, actual: ArchiveLine): string[] => {
  const problems: string[] = [];
  if (actual.author !== gold.author) {
    problems.push(`author ${actual.author} != ${gold.author}`);
  }
  if (actual.sessionId !== gold.sessionId) {
    problems.push(`sessionId ${actual.sessionId} != ${gold.sessionId}`);
  }
  if (actual.recordedAt !== gold.recordedAt) {
    problems.push(`recordedAt ${actual.recordedAt} != ${gold.recordedAt}`);
  }
  if (actual.provenance.threadKind !== gold.provenance.threadKind) {
    problems.push(
      `threadKind ${actual.provenance.threadKind} != ${gold.provenance.threadKind}`
    );
  }
  const actualTags = [...actual.categories].sort().join(",");
  const goldTags = [...gold.categories].sort().join(",");
  if (actualTags !== goldTags) {
    problems.push(`categories [${actualTags}] != [${goldTags}]`);
  }
  if (!actual.body.startsWith(`${speakerLabel(gold.author)}: `)) {
    problems.push("speaker prefix mismatch");
  }
  if (spokenText(actual.body) !== spokenText(gold.body)) {
    problems.push(
      `text ${JSON.stringify(spokenText(actual.body))} != ${JSON.stringify(spokenText(gold.body))}`
    );
  }
  return problems;
};

async function runLookup(
  ctx: ArmContext,
  query: string,
  depth: number,
  surface: string
): Promise<DeliveredItem[]> {
  const result = await searchBm25(ctx.store, query, { limit: depth });
  if (!result.ok) throw new Error(`${ctx.arm} lookup: ${result.error.message}`);
  const items: DeliveredItem[] = [];
  for (const hit of result.value.results) {
    const mirrorHash = hit.conversion?.mirrorHash;
    const content = mirrorHash
      ? await ctx.store.getContent(mirrorHash)
      : undefined;
    const text = content?.ok && content.value ? content.value : hit.snippet;
    items.push(parseDelivered(ctx.arm, surface, text, hit.record));
  }
  return items;
}

async function runCapsule(
  ctx: ArmContext,
  question: CasesFixture["questions"][number]
): Promise<{ capsule: ContextCapsuleV1 | null; abstention: string | null }> {
  const settings = SESSIONS_GATE.capsule;
  try {
    const capsule = await buildContextCapsule(
      {
        goal: question.goal,
        queryModes: question.queryModes,
        ...(question.author ? { author: question.author } : {}),
        ...(question.categories ? { categories: question.categories } : {}),
        depthPolicy: settings.depthPolicy,
        budgetTokens: settings.budgetTokens,
        budgetBytes: settings.budgetBytes,
        safetyMarginTokens: settings.safetyMarginTokens,
        safetyMarginBytes: settings.safetyMarginBytes,
        limit: settings.limit,
        candidateLimit: settings.candidateLimit,
      },
      { store: ctx.store, config: ctx.config, indexName: ctx.indexName }
    );
    return { capsule, abstention: null };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "error";
    return {
      capsule: null,
      abstention: `${code}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Every file under a directory, as latin1 text (raw bytes, incl. SQLite pages). */
async function rawSurface(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const file of await listFiles(dir)) {
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
    parts.push(new TextDecoder("latin1").decode(bytes));
  }
  return parts.join("\n");
}

async function measure(ctx: SessionsEvalContext): Promise<SessionsResults> {
  const { cases } = ctx;
  const goldByKey = new Map(
    ctx.goldLines.map((line) => [
      turnKey(line.threadId, line.provenance.turnId),
      line,
    ])
  );
  const formatOf = new Map<string, string>();
  for (const [key, line] of goldByKey) {
    formatOf.set(key, line.provenance.format ?? "unknown");
  }
  const unitFormat = new Map(
    cases.units.map((unit) => [
      `${unit.sourceId}\0${unit.locator}`,
      unit.format,
    ])
  );

  // Units: every native unit must reach its expected outcome.
  const seenUnits = new Map<string, SessionImportReceipt["units"][number]>();
  for (const receipt of ctx.receipts) {
    for (const unit of receipt.units) {
      seenUnits.set(`${unit.sourceId}\0${unit.locator}`, unit);
    }
  }
  const units: UnitResult[] = cases.units.map((expected) => {
    const actual = seenUnits.get(`${expected.sourceId}\0${expected.locator}`);
    return {
      sourceId: expected.sourceId,
      locator: expected.locator,
      format: expected.format,
      expected: expected.outcome,
      outcome: actual?.outcome ?? "missing",
      reason: actual?.reason,
      warnings: actual?.warnings,
      unknownKinds: actual?.unknownKinds,
      ok: actual?.outcome === expected.outcome,
    };
  });
  for (const [key, unit] of seenUnits) {
    if (!unitFormat.has(key)) {
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
  }

  // Archive fidelity: identity, role, text and tags per gold turn.
  const byFormat: SessionsResults["fidelity"]["byFormat"] = {};
  for (const format of cases.formats) {
    byFormat[format] = { gold: 0, matched: 0, extra: 0 };
  }
  const mismatches: FidelityMismatch[] = [];
  const pipelineByKey = new Map<string, ArchiveLine>();
  for (const line of ctx.pipelineLines) {
    const key = turnKey(line.threadId, line.provenance.turnId);
    if (pipelineByKey.has(key)) {
      mismatches.push({
        key,
        format: formatOf.get(key) ?? "unknown",
        problem: "duplicate archived turn",
      });
    }
    pipelineByKey.set(key, line);
  }
  for (const [key, gold] of goldByKey) {
    const format = gold.provenance.format ?? "unknown";
    const bucket = (byFormat[format] ??= { gold: 0, matched: 0, extra: 0 });
    bucket.gold += 1;
    const actual = pipelineByKey.get(key);
    if (!actual) {
      mismatches.push({ key, format, problem: "missing from archive" });
      continue;
    }
    const problems = fidelityProblems(gold, actual);
    if (problems.length === 0) bucket.matched += 1;
    else mismatches.push({ key, format, problem: problems.join("; ") });
  }
  for (const [key, line] of pipelineByKey) {
    if (goldByKey.has(key)) continue;
    const unitLocator = line.provenance.unit ?? "";
    const format =
      unitFormat.get(`${line.provenance.sourceId}\0${unitLocator}`) ??
      "unknown";
    (byFormat[format] ??= { gold: 0, matched: 0, extra: 0 }).extra += 1;
    mismatches.push({
      key,
      format,
      problem: `unexpected ${line.author} turn: ${JSON.stringify(spokenText(line.body).slice(0, 120))}`,
    });
  }

  const delivered: DeliveredItem[] = [];

  // Exact lookups (pipeline gated; gold rank reported for reference).
  const lookups: LookupResult[] = [];
  for (const lookup of cases.lookups) {
    const gold = goldByKey.get(lookup.expect);
    if (!gold) throw new Error(`lookup ${lookup.id}: unknown gold turn`);
    const ranks: Record<Arm, number | null> = { pipeline: null, gold: null };
    let pipelineTop: string | null = null;
    const problems: string[] = [];
    for (const arm of ["pipeline", "gold"] as const) {
      const items = await runLookup(
        ctx.arms[arm],
        lookup.query,
        SESSIONS_GATE.lookupDepth,
        `lookup ${lookup.id}`
      );
      delivered.push(...items);
      const index = items.findIndex((item) => carriesTurn(item, gold));
      ranks[arm] = index === -1 ? null : index + 1;
      if (arm !== "pipeline") continue;
      const top = items[0];
      pipelineTop =
        top?.threadLine && top.turnId
          ? turnKey(top.threadLine, top.turnId)
          : null;
      if (!top) {
        problems.push("no result (abstention)");
        continue;
      }
      if (ranks.pipeline === null || ranks.pipeline > SESSIONS_GATE.lookupK) {
        problems.push(
          `expected turn at rank ${ranks.pipeline ?? "none"}; top was ${pipelineTop ?? "unidentified"}`
        );
      }
      const hit = ranks.pipeline ? items[ranks.pipeline - 1] : undefined;
      if (hit) {
        for (const tag of gold.categories) {
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
      format: formatOf.get(lookup.expect) ?? "unknown",
      role: gold.author,
      pipelineRank: ranks.pipeline,
      goldRank: ranks.gold,
      pipelineTop,
      pass: problems.length === 0,
      problems,
    });
  }

  // Multi-session questions through the same bounded capsule delivery.
  const questions: QuestionResult[] = [];
  const capsules: Array<{ arm: Arm; id: string; capsule: unknown }> = [];
  for (const question of cases.questions) {
    const golds = question.gold.map((key) => {
      const line = goldByKey.get(key);
      if (!line) throw new Error(`question ${question.id}: unknown ${key}`);
      return { key, line };
    });
    const perArm = {} as Record<Arm, QuestionArmResult>;
    for (const arm of ["pipeline", "gold"] as const) {
      const { capsule, abstention } = await runCapsule(ctx.arms[arm], question);
      capsules.push({ arm, id: question.id, capsule: capsule ?? abstention });
      const items = (capsule?.evidence ?? []).map((evidence) =>
        parseDelivered(arm, `capsule ${question.id}`, evidence.text, {
          author: evidence.record?.author,
          threadId: evidence.record?.threadId,
          categories: evidence.record?.categories,
        })
      );
      delivered.push(...items);
      const covered = golds
        .filter(({ line }) => items.some((item) => carriesTurn(item, line)))
        .map(({ key }) => key);
      const projectFilter = question.categories?.find((tag) =>
        tag.startsWith("project-id/")
      );
      perArm[arm] = {
        covered,
        missing: golds
          .map(({ key }) => key)
          .filter((key) => !covered.includes(key)),
        evidence: items.length,
        usedTokens: capsule?.budget.usedTokens ?? null,
        usedBytes: capsule?.budget.usedBytes ?? null,
        withinBudget: capsule
          ? capsule.budget.usedTokens <= SESSIONS_GATE.capsule.budgetTokens &&
            capsule.budget.usedBytes <= SESSIONS_GATE.capsule.budgetBytes
          : true,
        abstention,
        collisionLeaks: projectFilter
          ? items
              .filter((item) => !item.categories.includes(projectFilter))
              .map(
                (item) =>
                  `${item.threadLine ?? "?"}#${item.turnId ?? "?"} (${item.categories.find((tag) => tag.startsWith("project-id/")) ?? "no project-id"})`
              )
          : [],
      };
    }
    const goldCoveredSet = new Set(perArm.gold.covered);
    questions.push({
      id: question.id,
      goldTurns: golds.length,
      formats: [
        ...new Set(golds.map(({ key }) => formatOf.get(key) ?? "unknown")),
      ],
      pipeline: perArm.pipeline,
      gold: perArm.gold,
      regression:
        perArm.pipeline.covered.length < perArm.gold.covered.length ||
        [...goldCoveredSet].some(
          (key) => !perArm.pipeline.covered.includes(key)
        ),
    });
  }

  // Role safety over every delivered item, both arms.
  const assistantTexts = new Set(
    ctx.goldLines
      .filter((line) => line.author === "assistant")
      .map((line) => spokenText(line.body))
  );
  const roleSafety: string[] = [];
  const noiseAsHuman: SessionsResults["noiseAsHuman"] = [];
  for (const item of delivered) {
    const where = `${item.arm} ${item.surface} ${item.threadLine ?? "?"}#${item.turnId ?? "?"}`;
    const labels = [item.author, item.prefix, item.speakerLine];
    if (labels.some((label) => label !== labels[0]) || !labels[0]) {
      roleSafety.push(
        `${where}: role labels disagree (author=${item.author}, prefix=${item.prefix}, speaker=${item.speakerLine})`
      );
    }
    const humanish = labels.includes("human");
    if (!humanish) continue;
    for (const text of assistantTexts) {
      if (item.text.includes(`Human: ${text}`)) {
        roleSafety.push(`${where}: assistant suggestion delivered as human`);
      }
    }
    for (const noise of cases.neverHuman) {
      if (item.text.includes(noise.text)) {
        noiseAsHuman.push({ text: noise.text, format: noise.format, where });
      }
    }
  }
  for (const line of ctx.pipelineLines) {
    if (line.author !== "human") continue;
    for (const noise of cases.neverHuman) {
      if (line.body.includes(noise.text)) {
        noiseAsHuman.push({
          text: noise.text,
          format: noise.format,
          where: `pipeline archive ${turnKey(line.threadId, line.provenance.turnId)}`,
        });
      }
    }
  }

  // Secret scan: archives, state, index DBs (raw bytes), config/cache,
  // receipts, delivered text and a lexical probe of both indexes.
  const surfaces: Array<[string, string]> = [
    [
      "pipeline archive + state",
      await rawSurface(ctx.arms.pipeline.archiveRoot),
    ],
    ["gold archive", await rawSurface(ctx.arms.gold.archiveRoot)],
    ["index data dir", await rawSurface(process.env.GNO_DATA_DIR ?? "")],
    ["gno config dir", await rawSurface(process.env.GNO_CONFIG_DIR ?? "")],
    ["gno cache dir", await rawSurface(process.env.GNO_CACHE_DIR ?? "")],
    ["import receipts", JSON.stringify(ctx.receipts)],
    ["delivered lookups + capsules", JSON.stringify({ delivered, capsules })],
  ];
  const secretLeaks: SessionsResults["secretLeaks"] = [];
  const probes = [
    ...cases.secrets.map((secret) => ({
      needle: secret.value,
      format: secret.format,
    })),
    ...cases.secretMarkers.map((marker) => ({
      needle: marker,
      format: "marker",
    })),
  ];
  for (const [surface, content] of surfaces) {
    for (const probe of probes) {
      if (content.includes(probe.needle)) {
        secretLeaks.push({
          secret: probe.needle,
          format: probe.format,
          surface,
        });
      }
    }
  }
  for (const arm of ["pipeline", "gold"] as const) {
    for (const secret of cases.secrets) {
      const probe = secret.value.replaceAll("-", " ");
      const found = await searchBm25(ctx.arms[arm].store, probe, { limit: 5 });
      if (found.ok && found.value.results.length > 0) {
        secretLeaks.push({
          secret: secret.value,
          format: secret.format,
          surface: `${arm} lexical index`,
        });
      }
    }
  }

  return {
    units,
    fidelity: { byFormat, mismatches },
    lookups,
    questions,
    roleSafety,
    noiseAsHuman,
    secretLeaks,
    formatOf,
  };
}

let results: Promise<SessionsResults> | null = null;

function getResults(): Promise<SessionsResults> {
  results ??= getSessionsEval().then(measure);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-format report (never averaged away)
// ─────────────────────────────────────────────────────────────────────────────

interface FormatReport {
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
  secretLeaks: string[];
  noiseAsHuman: string[];
}

function formatReport(r: SessionsResults, format: string): FormatReport {
  const all = format === "overall";
  const inFormat = (value: string) => all || value === format;
  const units = r.units.filter((unit) => inFormat(unit.format));
  const fidelityBuckets = all
    ? Object.values(r.fidelity.byFormat)
    : [r.fidelity.byFormat[format] ?? { gold: 0, matched: 0, extra: 0 }];
  const lookups = r.lookups.filter((lookup) => inFormat(lookup.format));
  const coverage = { pipeline: 0, gold: 0, total: 0 };
  const regressions: string[] = [];
  for (const question of r.questions) {
    const keys = [...question.pipeline.covered, ...question.pipeline.missing];
    for (const key of keys) {
      if (!inFormat(r.formatOf.get(key) ?? "unknown")) continue;
      coverage.total += 1;
      if (question.pipeline.covered.includes(key)) coverage.pipeline += 1;
      if (question.gold.covered.includes(key)) coverage.gold += 1;
      if (
        question.gold.covered.includes(key) &&
        !question.pipeline.covered.includes(key)
      ) {
        regressions.push(`${question.id}: ${key}`);
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
      matched: fidelityBuckets.reduce((sum, b) => sum + b.matched, 0),
      gold: fidelityBuckets.reduce((sum, b) => sum + b.gold, 0),
      extra: fidelityBuckets.reduce((sum, b) => sum + b.extra, 0),
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
    secretLeaks: r.secretLeaks
      .filter((leak) => all || leak.format === format)
      .map((leak) => `${leak.secret} in ${leak.surface}`),
    noiseAsHuman: r.noiseAsHuman
      .filter((item) => inFormat(item.format))
      .map((item) => `${item.text} at ${item.where}`),
  };
}

const ratio = (num: number, den: number): string =>
  den === 0 ? "n/a" : `${num}/${den}`;

const pass = (ok: boolean, metadata?: unknown) => ({
  score: ok ? 1 : 0,
  ...(metadata === undefined ? {} : { metadata }),
});

// Close both stores and delete /tmp/gno-sessions-eval-* once the last suite
// in this file has run (process `beforeExit` never fires in vitest workers).
afterAll(cleanupSessionsEval);

// ─────────────────────────────────────────────────────────────────────────────
// Suites
// ─────────────────────────────────────────────────────────────────────────────

evalite("Sessions 0: fixture integrity", {
  data: async () => [{ input: MANIFEST, expected: null }],
  task: async () => {
    verified ??= verifySessionsManifest();
    return await verified;
  },
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
    const cases = await loadCases();
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
      description: `No gold-covered answer-bearing turn missing from the pipeline arm (regressions <= ${SESSIONS_GATE.coverageRegressions})`,
      scorer: ({ output }) =>
        pass(
          output.regressions.length <= SESSIONS_GATE.coverageRegressions,
          output.regressions
        ),
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
        ].join("\n") || "-",
    },
  ],
});

evalite("Sessions 2: exact lookups", {
  data: async () => {
    const cases = await loadCases();
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
        "Pipeline arm; the delivered item must carry the exact turn text, native turn id, thread, author and every gold tag",
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
    const cases = await loadCases();
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
      description: `Same capsule budget (${SESSIONS_GATE.capsule.budgetTokens} tokens / ${SESSIONS_GATE.capsule.budgetBytes} bytes, ${SESSIONS_GATE.capsule.depthPolicy}); every gold-covered turn is also covered by the pipeline arm`,
      scorer: ({ output }) =>
        pass(!output.regression, {
          pipelineMissing: output.pipeline.missing,
          goldMissing: output.gold.missing,
        }),
    },
    {
      name: "Collision isolation",
      description: `Evidence outside a project-id filter (gate ${SESSIONS_GATE.collisionLeaks})`,
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
      label: "Pipeline missing",
      value: output.pipeline.missing.join("\n") || "-",
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
      description: `Delivered items with disagreeing role labels or an assistant suggestion presented as human (gate ${SESSIONS_GATE.roleSafetyViolations})`,
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
