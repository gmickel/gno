/**
 * Memory eval fixtures: typed loaders plus the content-hash manifest.
 *
 * Every fixture under `evals/fixtures/memory/` is committed and pinned by
 * sha256 in `manifest.json`. Loading verifies the manifest first, so a fixture
 * edit without a manifest refresh (`bun run eval:memory:fixtures`) fails the
 * run instead of silently changing what the gate measures. The fixture format
 * is documented in docs/MEMORY.md ("Eval fixtures").
 *
 * @module evals/helpers/memory-fixtures
 */

// node:fs/promises readdir enumerates the fixture directory (structure op)
import { readdir } from "node:fs/promises";
// node:path has no Bun path utilities
import { dirname, join } from "node:path";
// node:url resolves this module's directory under both Bun and vitest workers
import { fileURLToPath } from "node:url";

const HELPERS_DIR = dirname(fileURLToPath(import.meta.url));

export const MEMORY_FIXTURE_ROOT = join(HELPERS_DIR, "../fixtures/memory");
export const MEMORY_FIXTURE_MANIFEST = "manifest.json";

/** Fixture files pinned by the manifest, in manifest order. */
export const MEMORY_FIXTURE_FILES = [
  "upsert.json",
  "supersession.json",
  "recall.json",
  "fence.json",
  "scopes.json",
  "agent-day.json",
  "agent-day.golden.json",
] as const;

export type MemoryFixtureFile = (typeof MEMORY_FIXTURE_FILES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Fixture shapes
// ─────────────────────────────────────────────────────────────────────────────

export type UpsertClass = "exact" | "paraphrase" | "clean";

export interface UpsertCase {
  id: string;
  class: UpsertClass;
  /** Facts stored (decision add) in the case's private scope before `text`. */
  seed: string[];
  text: string;
  decision?: "add";
  expect: "existing" | "candidates" | "added";
  /** For proposals: whether a `likely` candidate must (true) / must not (false) appear. */
  likely?: boolean;
}

export interface UpsertFixture {
  suite: "upsert";
  description: string;
  cases: UpsertCase[];
}

export interface SupersessionCase {
  id: string;
  /** Written in order; every entry after the first supersedes its predecessor. */
  chain: string[];
  /** Attempted against chain[0] after the chain is built; must conflict. */
  staleSupersede?: string;
  /** Raced against the chain head; exactly one may win. */
  conflictWriters?: string[];
  query: string;
}

export interface SupersessionFixture {
  suite: "supersession";
  description: string;
  cases: SupersessionCase[];
}

export interface FixtureFact {
  id: string;
  text: string;
}

export interface RecallQuery {
  id: string;
  query: string;
  relevant: string[];
  /** `budget`: more relevant facts than the budget admits; checks the caps. */
  kind?: "budget";
}

export interface RecallFixture {
  suite: "recall";
  description: string;
  facts: FixtureFact[];
  queries: RecallQuery[];
}

export interface FenceCase {
  id: string;
  query: string;
  /** Rewordings of the recalled span; carry no receipt hash, so they may pass. */
  paraphrases: string[];
}

export interface FenceFixture {
  suite: "fence";
  description: string;
  facts: FixtureFact[];
  cases: FenceCase[];
}

export interface ScopedFact extends FixtureFact {
  scopes: string[];
}

export interface ScopeRead {
  id: string;
  query: string;
  scopes: string[];
  /** In-scope fact ids that must come back (empty only for a pure negative read). */
  expect: { includes: string[] };
}

export interface ScopeWrite {
  id: string;
  text: string;
  scopes: string[];
  expect: "added" | "existing";
}

export interface ScopeFixture {
  suite: "scopes";
  description: string;
  scopes: Record<string, string>;
  facts: ScopedFact[];
  reads: ScopeRead[];
  writes: ScopeWrite[];
}

export type AgentDayTurn =
  | {
      id: string;
      op: "remember";
      text: string;
      decision?: "add";
      label?: string;
      expect: string;
      /** For proposals: label of the record that must appear as a `likely` candidate. */
      likely?: string;
    }
  | {
      id: string;
      op: "supersede";
      predecessor: string;
      text: string;
      label?: string;
      expect: string;
    }
  | {
      id: string;
      op: "recall";
      query: string;
      scopes?: string[];
      expect: { includes?: string[]; excludes?: string[]; empty?: boolean };
    }
  | {
      id: string;
      op: "replay";
      /** Recall turn whose first fact and receipt are replayed. */
      from: string;
      expect: string;
    };

export interface AgentDayFixture {
  suite: "agent-day";
  description: string;
  scope: string;
  turns: AgentDayTurn[];
}

/** Path-free view of one fact file: what the day left behind. */
export interface NormalizedRecord {
  text: string;
  scopes: string[];
  current: boolean;
  /** Predecessor texts, sorted. */
  supersedes: string[];
}

export interface AgentDayGolden {
  /** Sorted by text. */
  records: NormalizedRecord[];
  /** Recall turn id -> returned fact texts in rank order. */
  recalls: Record<string, string[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifest
// ─────────────────────────────────────────────────────────────────────────────

export interface MemoryFixtureManifest {
  algorithm: "sha256";
  files: Record<string, string>;
}

export function fixturePath(name: string): string {
  return join(MEMORY_FIXTURE_ROOT, name);
}

export async function hashFixtureFile(name: string): Promise<string> {
  const bytes = await Bun.file(fixturePath(name)).arrayBuffer();
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export async function buildFixtureManifest(): Promise<MemoryFixtureManifest> {
  const files: Record<string, string> = {};
  for (const name of MEMORY_FIXTURE_FILES) {
    files[name] = await hashFixtureFile(name);
  }
  return { algorithm: "sha256", files };
}

/** Digest over the manifest itself: one line that identifies the fixture set. */
export function manifestDigest(manifest: MemoryFixtureManifest): string {
  return new Bun.CryptoHasher("sha256")
    .update(
      MEMORY_FIXTURE_FILES.map(
        (name) => `${name}:${manifest.files[name]}`
      ).join("\n")
    )
    .digest("hex")
    .slice(0, 16);
}

export async function writeFixtureManifest(): Promise<MemoryFixtureManifest> {
  const manifest = await buildFixtureManifest();
  await Bun.write(
    fixturePath(MEMORY_FIXTURE_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return manifest;
}

let verifiedManifest: Promise<MemoryFixtureManifest> | null = null;

/** `.json` files in the fixture directory that neither the manifest nor the pin list covers. */
export async function listUnpinnedFixtures(): Promise<string[]> {
  const pinned = new Set<string>([
    ...MEMORY_FIXTURE_FILES,
    MEMORY_FIXTURE_MANIFEST,
  ]);
  const entries = await readdir(MEMORY_FIXTURE_ROOT);
  return entries
    .filter((name) => name.endsWith(".json") && !pinned.has(name))
    .sort();
}

/**
 * Verify every pinned fixture against the committed manifest and refuse any
 * unpinned `.json` in the fixture directory. Throws with the drifted file
 * list and the refresh command on any mismatch.
 */
export function verifyFixtureManifest(): Promise<MemoryFixtureManifest> {
  if (verifiedManifest) return verifiedManifest;
  verifiedManifest = (async () => {
    const file = Bun.file(fixturePath(MEMORY_FIXTURE_MANIFEST));
    if (!(await file.exists())) {
      throw new Error(
        `Memory fixture manifest missing at ${file.name}; run: bun run eval:memory:fixtures`
      );
    }
    const unpinned = await listUnpinnedFixtures();
    if (unpinned.length > 0) {
      throw new Error(
        `Unpinned memory fixtures in ${MEMORY_FIXTURE_ROOT}: ${unpinned.join(", ")}. ` +
          "Add them to MEMORY_FIXTURE_FILES (evals/helpers/memory-fixtures.ts) or remove them."
      );
    }
    const committed: unknown = await file.json();
    const actual = await buildFixtureManifest();
    return checkFixtureManifest(committed, actual);
  })();
  return verifiedManifest;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Validate a committed manifest's shape against what the writer emits, then
 * compare its pins with the freshly hashed fixtures. Pure so the fail-closed
 * cases are unit-testable without touching the fixture directory. Throws on
 * an unexpected `algorithm`, a missing or non-string pin for any fixture in
 * MEMORY_FIXTURE_FILES, or any hash drift.
 */
export function checkFixtureManifest(
  committed: unknown,
  actual: MemoryFixtureManifest
): MemoryFixtureManifest {
  const refresh = "refresh the pins with: bun run eval:memory:fixtures";
  if (!isRecord(committed) || !isRecord(committed.files)) {
    throw new Error(
      `Memory fixture manifest is malformed (expected { algorithm, files }); ${refresh}`
    );
  }
  if (committed.algorithm !== actual.algorithm) {
    throw new Error(
      `Memory fixture manifest algorithm is ${JSON.stringify(committed.algorithm)}, ` +
        `expected ${JSON.stringify(actual.algorithm)}; ${refresh}`
    );
  }
  const { files } = committed;
  const unpinned = MEMORY_FIXTURE_FILES.filter((name) => {
    const hash = files[name];
    return typeof hash !== "string" || hash.length === 0;
  });
  if (unpinned.length > 0) {
    throw new Error(
      `Memory fixture manifest has no hash for: ${unpinned.join(", ")}; ${refresh}`
    );
  }
  const drifted = MEMORY_FIXTURE_FILES.filter(
    (name) => files[name] !== actual.files[name]
  );
  if (drifted.length > 0) {
    throw new Error(
      `Memory fixtures drifted from manifest.json: ${drifted.join(", ")}. ` +
        `Review the change, then ${refresh}`
    );
  }
  return committed as unknown as MemoryFixtureManifest;
}

export async function loadMemoryFixture<T>(
  name: MemoryFixtureFile
): Promise<T> {
  await verifyFixtureManifest();
  return (await Bun.file(fixturePath(name)).json()) as T;
}
