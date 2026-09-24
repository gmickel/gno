/**
 * Sessions eval harness: one temp root, two indexed arms.
 *
 * - pipeline: synthetic native fixtures for every supported harness format,
 *   registered and imported through the public sessions service API into a
 *   temp session archive (its own config + named index);
 * - gold: the hand-normalized turns in `gold/turns.json`, written as a plain
 *   JSONL file with a minimal field mapping defined here (no pipeline
 *   rendering, title format or categories) and synced into its own config +
 *   named index through the same collection sync.
 *
 * Every GNO config/data/cache lookup stays inside the temp root.
 *
 * @module evals/helpers/sessions-harness
 */

import { Database } from "bun:sqlite";
// node:fs/promises for mkdtemp/mkdir/cp/readdir (filesystem structure ops)
import { cp, mkdir, mkdtemp, readdir } from "node:fs/promises";
// node:os provides the temporary root
import { tmpdir } from "node:os";
// node:path has no Bun path utilities
import { dirname, join, sep } from "node:path";

import type { Collection, Config } from "../../src/config/types";
import type { JsonlFieldMapping } from "../../src/converters/adapters/jsonl/config";
import type { SessionImportReceipt } from "../../src/sessions/types";
import type { SqliteAdapter } from "../../src/store/sqlite/adapter";
import type { CasesFixture, GoldTurn, Role } from "./sessions-fixtures";

import { initStore } from "../../src/cli/commands/shared";
import { createDefaultConfig } from "../../src/config/defaults";
import { saveConfigToPath } from "../../src/config/saver";
import { defaultSyncService, withContentTypeRules } from "../../src/ingestion";
import { SESSION_STATE_DIRNAME } from "../../src/sessions/archive";
import { SessionsService } from "../../src/sessions/service";
import { addSessionSource, initSessionArchive } from "../../src/sessions/setup";
import { safeRm } from "../../test/helpers/cleanup";
import {
  loadGoldTurns,
  loadSessionsCases,
  SESSIONS_FIXTURE_ROOT,
} from "./sessions-fixtures";

export type Arm = "pipeline" | "gold";
export const ARMS = ["pipeline", "gold"] as const;

const COLLECTION = "work";

export interface ArmContext {
  arm: Arm;
  configPath: string;
  indexName: string;
  /** Directory the arm's collection indexes. */
  collectionDir: string;
  config: Config;
  store: SqliteAdapter;
}

/** One archived pipeline turn, read back from the durable archive JSONL. */
export interface PipelineArchiveLine {
  body: string;
  author: string;
  categories: string[];
  sessionId?: string;
  threadId: string;
  recordedAt?: string;
  provenance: {
    sourceId: string;
    turnId: string;
    threadKind: string;
    unit?: string;
  };
}

export interface SessionsEvalContext {
  root: string;
  cases: CasesFixture;
  gold: GoldTurn[];
  arms: Record<Arm, ArmContext>;
  receipts: SessionImportReceipt[];
  pipelineLines: PipelineArchiveLine[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Gold arm rendering (eval-defined, independent of src/sessions)
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal field mapping for the gold arm's JSONL file. */
export const GOLD_ARM_FIELD_MAPPING: JsonlFieldMapping = {
  id: "/key",
  title: "/heading",
  body: "/text",
  author: "/role",
  sessionId: "/session",
  threadId: "/thread",
  categories: "/labels",
  dateFields: { recorded: "/at" },
};

/** Heading of a gold-arm record; the delivered title carries turn identity. */
export const goldArmHeading = (turn: string): string => `Turn ${turn}`;

/**
 * Gold-arm filter label for a native working directory. Record categories
 * follow the tag grammar, so the directory becomes hierarchical segments.
 */
export const goldArmProjectLabel = (project: string): string =>
  `gold-project/${project.replace(/^\/+/, "")}`;

interface GoldArmLine {
  key: string;
  heading: string;
  text: string;
  role: Role;
  session: string;
  thread: string;
  labels: string[];
  at: string;
}

const goldArmLine = (turn: GoldTurn): GoldArmLine => ({
  key: turn.key,
  heading: goldArmHeading(turn.turn),
  text: turn.text,
  role: turn.role,
  session: turn.sessionKey,
  thread: turn.threadKey,
  labels: turn.project ? [goldArmProjectLabel(turn.project)] : [],
  at: turn.at,
});

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

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

/** Every file under a directory as latin1 text (raw bytes, incl. SQLite pages). */
export async function rawSurface(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const file of await listFiles(dir)) {
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
    parts.push(new TextDecoder("latin1").decode(bytes));
  }
  return parts.join("\n");
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

async function openStore(
  arm: Arm,
  configPath: string,
  indexName: string
): Promise<Omit<ArmContext, "collectionDir">> {
  const opened = await initStore({
    configPath,
    indexName,
    allowEmptyCollections: true,
  });
  if (!opened.ok) throw new Error(`${arm}: ${opened.error}`);
  return {
    arm,
    configPath,
    indexName,
    config: opened.config,
    store: opened.store as SqliteAdapter,
  };
}

const collectionOf = (config: Config): Collection => {
  const collection = config.collections.find(
    (item) => item.name === COLLECTION
  );
  if (!collection) throw new Error(`collection "${COLLECTION}" missing`);
  return collection;
};

async function setupPipelineArm(
  root: string,
  cases: CasesFixture,
  sourceRoots: Record<string, string>
): Promise<{ ctx: ArmContext; receipts: SessionImportReceipt[] }> {
  const configPath = join(root, "pipeline.yml");
  const indexName = "sessions-eval-pipeline";
  await initSessionArchive({
    configPath,
    indexName,
    archiveRoot: join(root, "pipeline-archive"),
    collection: COLLECTION,
  });
  for (const source of cases.sources) {
    const sourceRoot = sourceRoots[source.id];
    if (!sourceRoot) throw new Error(`source ${source.id} not materialized`);
    await addSessionSource({
      configPath,
      id: source.id,
      harness: source.harness,
      path:
        source.harness === "hermes" ? join(sourceRoot, "state.db") : sourceRoot,
      collection: COLLECTION,
    });
  }
  const opened = await openStore("pipeline", configPath, indexName);
  const service = new SessionsService({
    config: opened.config,
    configPath,
    indexName,
    store: opened.store,
  });
  const receipts: SessionImportReceipt[] = [];
  for (const source of cases.sources) {
    receipts.push(
      await service.import({ sourceId: source.id }, { allowPaths: false })
    );
  }
  return {
    ctx: { ...opened, collectionDir: collectionOf(opened.config).path },
    receipts,
  };
}

async function setupGoldArm(
  root: string,
  gold: GoldTurn[]
): Promise<ArmContext> {
  const configPath = join(root, "gold.yml");
  const indexName = "sessions-eval-gold";
  const collectionDir = join(root, "gold-archive", COLLECTION);
  await mkdir(collectionDir, { recursive: true });
  await Bun.write(
    join(collectionDir, "gold-turns.jsonl"),
    `${gold.map((turn) => JSON.stringify(goldArmLine(turn))).join("\n")}\n`
  );
  const collection = {
    name: COLLECTION,
    path: collectionDir,
    pattern: "**/*.jsonl",
    include: [],
    exclude: [],
    recordAdapters: { jsonl: { fieldMapping: GOLD_ARM_FIELD_MAPPING } },
  } as unknown as Collection;
  const saved = await saveConfigToPath(
    { ...createDefaultConfig(), collections: [collection] },
    configPath
  );
  if (!saved.ok) throw new Error(`gold config: ${saved.error.message}`);
  const opened = await openStore("gold", configPath, indexName);
  // Same collection sync and options the sessions service uses.
  await defaultSyncService.syncCollection(
    collectionOf(opened.config),
    opened.store,
    withContentTypeRules({ runUpdateCmd: false, gitPull: false }, opened.config)
  );
  // Fail closed if the gold arm lost a turn or a filter label on the way in;
  // a silently dropped label would show up as a gold abstention instead.
  const indexed = opened.store
    .getRawDb()
    .query<{ categories: string | null }, []>(
      "SELECT categories FROM documents WHERE active = 1"
    )
    .all()
    .map((row) => JSON.parse(row.categories ?? "[]") as string[]);
  const labelled = indexed.filter((categories) =>
    categories.some((tag) => tag.startsWith("gold-project/"))
  ).length;
  const expectedLabelled = gold.filter((turn) => turn.project).length;
  if (indexed.length !== gold.length || labelled !== expectedLabelled) {
    throw new Error(
      `gold arm indexed ${indexed.length}/${gold.length} turns, ${labelled}/${expectedLabelled} with a project label`
    );
  }
  return { ...opened, collectionDir };
}

/** Read every archived pipeline turn, whatever the archive file layout. */
async function readPipelineArchive(
  dir: string
): Promise<PipelineArchiveLine[]> {
  const lines: PipelineArchiveLine[] = [];
  for (const file of await listFiles(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    if (file.split(sep).includes(SESSION_STATE_DIRNAME)) continue;
    for (const line of (await Bun.file(file).text()).split("\n")) {
      if (line.trim()) lines.push(JSON.parse(line) as PipelineArchiveLine);
    }
  }
  return lines;
}

async function setupSessionsEval(): Promise<SessionsEvalContext> {
  const cases = await loadSessionsCases();
  const gold = await loadGoldTurns();
  const root = await mkdtemp(join(tmpdir(), "gno-sessions-eval-"));
  // Keep every GNO config/data/cache lookup inside the temp root.
  process.env.GNO_CONFIG_DIR = join(root, "gno-config");
  process.env.GNO_DATA_DIR = join(root, "gno-data");
  process.env.GNO_CACHE_DIR = join(root, "gno-cache");
  const sourceRoots = await materializeSources(root, cases);
  const pipeline = await setupPipelineArm(root, cases, sourceRoots);
  const goldArm = await setupGoldArm(root, gold);
  return {
    root,
    cases,
    gold,
    arms: { pipeline: pipeline.ctx, gold: goldArm },
    receipts: pipeline.receipts,
    pipelineLines: await readPipelineArchive(pipeline.ctx.collectionDir),
  };
}

let shared: Promise<SessionsEvalContext> | null = null;

export function getSessionsEval(): Promise<SessionsEvalContext> {
  shared ??= setupSessionsEval();
  return shared;
}

/** Close both stores and delete the temp root. */
export async function cleanupSessionsEval(): Promise<void> {
  if (!shared) return;
  const pending = shared;
  shared = null;
  const ctx = await pending.catch(() => null);
  if (!ctx) return;
  await ctx.arms.pipeline.store.close();
  await ctx.arms.gold.store.close();
  await safeRm(ctx.root);
}
