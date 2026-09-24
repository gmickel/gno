/**
 * Sessions eval fixtures: typed loaders, the hand-normalized gold turns and
 * the content-hash manifest.
 *
 * Every file under `evals/fixtures/sessions/` is committed and pinned by
 * sha256 in `manifest.json`. {@link buildSessionsManifest} is the single walk
 * over the fixture tree; the refresh script, the fixture test and the eval's
 * pin check all use it. Loading verifies the manifest first, so a fixture
 * edit without a reviewed refresh (`bun scripts/sessions-eval-fixtures.ts`)
 * fails the run instead of silently changing what the gate measures.
 *
 * @module evals/helpers/sessions-fixtures
 */

// node:fs/promises readdir enumerates the fixture tree (structure op)
import { readdir } from "node:fs/promises";
// node:path has no Bun path utilities
import { dirname, join, relative } from "node:path";
// node:url resolves this module's directory under both Bun and vitest workers
import { fileURLToPath } from "node:url";

import type { QueryModeInput } from "../../src/pipeline/types";

const HELPERS_DIR = dirname(fileURLToPath(import.meta.url));

export const SESSIONS_FIXTURE_ROOT = join(HELPERS_DIR, "../fixtures/sessions");
export const SESSIONS_FIXTURE_MANIFEST = "manifest.json";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture shapes
// ─────────────────────────────────────────────────────────────────────────────

export type Role = "human" | "assistant";
export type Harness = "codex" | "claude-code" | "openclaw" | "hermes";

export interface SessionsQuestion {
  id: string;
  goal: string;
  queryModes: QueryModeInput[];
  author?: Role;
  /** Native working directory; each arm maps it to its own filter label. */
  project?: string;
  /** Answer-bearing gold turn keys. */
  gold: string[];
}

export interface CasesFixture {
  suite: "sessions";
  description: string;
  sources: Array<{
    id: string;
    harness: Harness;
    native: string | null;
    sqlite: Record<string, string>;
  }>;
  formats: string[];
  /** Expected pipeline `project-id/*` value per native working directory. */
  projectIds: Record<string, string>;
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
  questions: SessionsQuestion[];
}

/** One hand-normalized spoken turn, as written in `gold/turns.json`. */
export interface GoldTurnRecord {
  turn: string;
  role: Role;
  at: string;
  text: string;
}

export interface GoldThreadRecord {
  harness: Harness;
  source: string;
  thread: string;
  parent: string | null;
  kind: "main" | "subagent";
  format: string;
  project: string | null;
  turns: GoldTurnRecord[];
}

export interface GoldFixture {
  description: string;
  normalization: string[];
  threads: GoldThreadRecord[];
}

/** A gold turn with its derived identity keys. */
export interface GoldTurn extends GoldTurnRecord {
  /** `<threadKey>#<turn>`; the key used by `cases.json`. */
  key: string;
  /** `<harness>/<source>/<native thread id>`. */
  threadKey: string;
  /** `<harness>/<source>/<root native thread id>`. */
  sessionKey: string;
  harness: Harness;
  source: string;
  kind: GoldThreadRecord["kind"];
  format: string;
  project: string | null;
}

/** The literal the gold archive uses where a credential value was removed. */
export const GOLD_REDACTION = "[REDACTED]";

export function flattenGold(fixture: GoldFixture): GoldTurn[] {
  const turns: GoldTurn[] = [];
  for (const thread of fixture.threads) {
    const threadKey = `${thread.harness}/${thread.source}/${thread.thread}`;
    const sessionKey = `${thread.harness}/${thread.source}/${thread.parent ?? thread.thread}`;
    for (const turn of thread.turns) {
      turns.push({
        ...turn,
        key: `${threadKey}#${turn.turn}`,
        threadKey,
        sessionKey,
        harness: thread.harness,
        source: thread.source,
        kind: thread.kind,
        format: thread.format,
        project: thread.project,
      });
    }
  }
  return turns;
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifest
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionsFixtureManifest {
  algorithm: "sha256";
  files: Record<string, string>;
}

const sha256 = (bytes: ArrayBuffer | string): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** Every fixture file path (absolute), sorted. */
export async function listSessionsFixtureFiles(): Promise<string[]> {
  const entries = await readdir(SESSIONS_FIXTURE_ROOT, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/** The single fixture walk: sha256 of every file except the manifest. */
export async function buildSessionsManifest(): Promise<SessionsFixtureManifest> {
  const files: Record<string, string> = {};
  for (const file of await listSessionsFixtureFiles()) {
    const rel = relative(SESSIONS_FIXTURE_ROOT, file).split("\\").join("/");
    if (rel === SESSIONS_FIXTURE_MANIFEST) continue;
    files[rel] = sha256(await Bun.file(file).arrayBuffer());
  }
  return { algorithm: "sha256", files };
}

/** Short digest of a manifest's pins, for report columns. */
export function manifestDigest(files: Record<string, string>): string {
  return sha256(
    Object.keys(files)
      .sort()
      .map((name) => `${name}:${files[name]}`)
      .join("\n")
  ).slice(0, 16);
}

const REFRESH_HINT =
  "review the fixture change, then run: bun scripts/sessions-eval-fixtures.ts";

/**
 * Compare a committed manifest (untrusted JSON) with the rebuilt one. Throws
 * on a malformed manifest, a drifted, unpinned or missing file.
 */
export function checkSessionsManifest(
  committed: unknown,
  actual: SessionsFixtureManifest
): SessionsFixtureManifest {
  if (
    !committed ||
    typeof committed !== "object" ||
    Array.isArray(committed) ||
    (committed as { algorithm?: unknown }).algorithm !== "sha256" ||
    typeof (committed as { files?: unknown }).files !== "object" ||
    (committed as { files?: unknown }).files === null
  ) {
    throw new Error(`Sessions fixture manifest is malformed; ${REFRESH_HINT}`);
  }
  const pinned = (committed as { files: Record<string, unknown> }).files;
  const drifted = Object.keys(actual.files).filter(
    (name) => pinned[name] !== actual.files[name]
  );
  const missing = Object.keys(pinned).filter((name) => !(name in actual.files));
  if (drifted.length > 0 || missing.length > 0) {
    throw new Error(
      `Sessions fixtures drifted from manifest.json (changed or unpinned: ${drifted.join(", ") || "-"}; missing: ${missing.join(", ") || "-"}); ${REFRESH_HINT}`
    );
  }
  return { algorithm: "sha256", files: pinned as Record<string, string> };
}

/** Write the rebuilt manifest (callers format it with the repo formatter). */
export async function writeSessionsManifest(): Promise<{
  path: string;
  manifest: SessionsFixtureManifest;
}> {
  const manifest = await buildSessionsManifest();
  const path = join(SESSIONS_FIXTURE_ROOT, SESSIONS_FIXTURE_MANIFEST);
  await Bun.write(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return { path, manifest };
}

let verified: Promise<{ committed: string; rebuilt: string }> | null = null;

/** Verify the committed manifest once per process; returns both digests. */
export function verifySessionsManifest(): Promise<{
  committed: string;
  rebuilt: string;
}> {
  verified ??= (async () => {
    const file = Bun.file(
      join(SESSIONS_FIXTURE_ROOT, SESSIONS_FIXTURE_MANIFEST)
    );
    if (!(await file.exists())) {
      throw new Error(`Sessions fixture manifest missing; ${REFRESH_HINT}`);
    }
    const actual = await buildSessionsManifest();
    const committed = checkSessionsManifest(await file.json(), actual);
    return {
      committed: manifestDigest(committed.files),
      rebuilt: manifestDigest(actual.files),
    };
  })();
  return verified;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loaders (manifest-verified)
// ─────────────────────────────────────────────────────────────────────────────

export async function loadSessionsCases(): Promise<CasesFixture> {
  await verifySessionsManifest();
  return (await Bun.file(
    join(SESSIONS_FIXTURE_ROOT, "cases.json")
  ).json()) as CasesFixture;
}

export async function loadGoldTurns(): Promise<GoldTurn[]> {
  await verifySessionsManifest();
  return flattenGold(
    (await Bun.file(
      join(SESSIONS_FIXTURE_ROOT, "gold/turns.json")
    ).json()) as GoldFixture
  );
}
