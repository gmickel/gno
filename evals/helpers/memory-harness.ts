/**
 * Memory eval harness: one temp SDK client per run, seeding helpers, the
 * path-free end-state snapshot, and a line diff for golden mismatches.
 *
 * The client runs offline with no embedding model, so matching and recall are
 * lexical (BM25 + Jaccard) and byte-deterministic; the whole suite is meant
 * to be reproducible without any network or model download.
 *
 * @module evals/helpers/memory-harness
 */

// node:fs/promises for mkdir/mkdtemp/readdir (filesystem structure ops)
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
// node:os provides the temporary root
import { tmpdir } from "node:os";
// node:path has no Bun path utilities
import { join, relative } from "node:path";

import type { Collection } from "../../src/config/types";
import type {
  MemoryFact,
  RecallResult,
  RememberInput,
  RememberResult,
} from "../../src/core/memory";
import type { GnoClient } from "../../src/sdk/types";
import type { NormalizedRecord } from "./memory-fixtures";

import { createDefaultConfig } from "../../src/config/defaults";
import {
  extractMemoryScopes,
  validateMemoryRecord,
} from "../../src/core/memory-record";
import { createGnoClient } from "../../src/sdk/client";
import { safeRm } from "../../test/helpers/cleanup";

/** Every suite writes to its own memory-managed collection. */
export const MEMORY_EVAL_COLLECTIONS = [
  "mem-upsert",
  "mem-supersede",
  "mem-recall",
  "mem-fence",
  "mem-scope",
  "mem-day",
  "mem-latency",
] as const;

export type MemoryEvalCollection = (typeof MEMORY_EVAL_COLLECTIONS)[number];

export const MEMORY_EVAL_IDENTITY = {
  caller: "memory-eval",
  session: "run-1",
} as const;

export interface MemoryEvalContext {
  client: GnoClient;
  root: string;
}

async function setupMemoryEvalClient(): Promise<MemoryEvalContext> {
  const root = await mkdtemp(join(tmpdir(), "gno-memory-eval-"));
  const collections: Collection[] = [];
  for (const name of MEMORY_EVAL_COLLECTIONS) {
    const path = join(root, "vault", name);
    await mkdir(path, { recursive: true });
    collections.push({
      name,
      path,
      pattern: "**/*.md",
      include: [],
      exclude: [],
      memoryManaged: true,
    });
  }
  // Keep the SDK's config/data/cache lookups inside the temp root.
  process.env.GNO_CONFIG_DIR = join(root, "config");
  process.env.GNO_DATA_DIR = join(root, "data");
  process.env.GNO_CACHE_DIR = join(root, "cache");
  const config = { ...createDefaultConfig(), collections };
  const client = await createGnoClient({
    config,
    dbPath: join(root, "data", "index.sqlite"),
    cacheDir: join(root, "cache"),
    downloadPolicy: { offline: true, allowDownload: false },
  });
  return { client, root };
}

let sharedContext: Promise<MemoryEvalContext> | null = null;

/**
 * Shared per-run client (promise-cached so concurrent suites share one).
 * Nothing tears it down implicitly: the eval file's `afterAll` and the
 * fixture script call `cleanupMemoryEvalClient()` explicitly, because vitest
 * workers (which evalite runs in) never fire `beforeExit`.
 */
export function getMemoryEvalClient(): Promise<MemoryEvalContext> {
  if (!sharedContext) {
    sharedContext = setupMemoryEvalClient();
  }
  return sharedContext;
}

/** Close the shared client and remove its temp root (idempotent). */
export async function cleanupMemoryEvalClient(): Promise<void> {
  if (!sharedContext) return;
  const pending = sharedContext;
  sharedContext = null;
  const ctx = await pending;
  await ctx.client.close();
  await safeRm(ctx.root);
}

// ─────────────────────────────────────────────────────────────────────────────
// Calls
// ─────────────────────────────────────────────────────────────────────────────

/** Memory error code carried on an SDK error (`details.code`), else null. */
export function memoryErrorCode(error: unknown): string | null {
  const details = (error as { details?: { code?: unknown } } | null)?.details;
  return typeof details?.code === "string" ? details.code : null;
}

export type RememberAttempt =
  | {
      kind: "result";
      outcome: RememberResult["outcome"];
      result: RememberResult;
    }
  | { kind: "error"; outcome: string; error: unknown };

/** remember() that reports a memory error code as an outcome instead of throwing. */
export async function tryRemember(
  client: GnoClient,
  input: Omit<RememberInput, "caller" | "session"> &
    Partial<Pick<RememberInput, "caller" | "session">>
): Promise<RememberAttempt> {
  try {
    const result = await client.remember({ ...MEMORY_EVAL_IDENTITY, ...input });
    return { kind: "result", outcome: result.outcome, result };
  } catch (error) {
    const code = memoryErrorCode(error);
    if (!code) throw error;
    return { kind: "error", outcome: code, error };
  }
}

/** remember() with decision supersede against a known predecessor record. */
export function supersede(
  client: GnoClient,
  collection: string,
  scopes: string[],
  predecessor: MemoryFact,
  text: string
): Promise<RememberAttempt> {
  return tryRemember(client, {
    collection,
    scopes,
    text,
    decision: "supersede",
    predecessorUri: predecessor.uri,
    predecessorHash: predecessor.contentHash,
  });
}

export function recall(
  client: GnoClient,
  input: { query: string; collection: string; scopes: string[] }
): Promise<RecallResult> {
  return client.recall({ ...MEMORY_EVAL_IDENTITY, ...input });
}

/** Store facts in order with decision add; returns id -> written record. */
export async function seedFacts(
  client: GnoClient,
  collection: string,
  facts: ReadonlyArray<{ id: string; text: string; scopes: string[] }>
): Promise<Map<string, MemoryFact>> {
  const records = new Map<string, MemoryFact>();
  for (const fact of facts) {
    const result = await client.remember({
      ...MEMORY_EVAL_IDENTITY,
      collection,
      scopes: fact.scopes,
      text: fact.text,
      decision: "add",
    });
    if (result.outcome !== "added") {
      throw new Error(
        `seed ${fact.id} in ${collection}: expected added, got ${result.outcome}`
      );
    }
    records.set(fact.id, result.record);
  }
  return records;
}

// ─────────────────────────────────────────────────────────────────────────────
// End state
// ─────────────────────────────────────────────────────────────────────────────

async function listFactFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/** Fact files in a collection; with `scope`, only those carrying that scope. */
export async function countFactFiles(
  ctx: MemoryEvalContext,
  collection: MemoryEvalCollection,
  scope?: string
): Promise<number> {
  const files = await listFactFiles(join(ctx.root, "vault", collection));
  if (scope === undefined) return files.length;
  let count = 0;
  for (const file of files) {
    const scopes = extractMemoryScopes(await Bun.file(file).text());
    if (scopes.includes(scope)) count += 1;
  }
  return count;
}

/**
 * Read every fact file in a collection and strip the run-specific identity
 * (record ids, dates, paths). Supersedes URIs become predecessor texts.
 */
export async function snapshotCollection(
  ctx: MemoryEvalContext,
  collection: MemoryEvalCollection
): Promise<NormalizedRecord[]> {
  const dir = join(ctx.root, "vault", collection);
  const parsed: Array<{
    uri: string;
    text: string;
    scopes: string[];
    supersedes: string[];
  }> = [];
  for (const file of await listFactFiles(dir)) {
    const validation = validateMemoryRecord(await Bun.file(file).text());
    if (!validation.ok) {
      throw new Error(`malformed memory record at ${file}`);
    }
    const relPath = relative(dir, file).split("\\").join("/");
    parsed.push({
      uri: `gno://${collection}/${relPath}`,
      text: validation.record.text,
      scopes: [...validation.record.frontmatter.scopes].sort(),
      supersedes: validation.record.supersedes,
    });
  }
  const textByUri = new Map(parsed.map((record) => [record.uri, record.text]));
  const superseded = new Set(parsed.flatMap((record) => record.supersedes));
  return parsed
    .map((record) => ({
      text: record.text,
      scopes: record.scopes,
      current: !superseded.has(record.uri),
      supersedes: record.supersedes
        .map((uri) => textByUri.get(uri) ?? `<unresolved ${uri}>`)
        .sort(),
    }))
    .sort((left, right) =>
      left.text < right.text ? -1 : left.text > right.text ? 1 : 0
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Diff and stats
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal line diff (LCS) rendered as `-expected` / `+actual` lines with context. */
export function renderLineDiff(expected: string, actual: string): string {
  const left = expected.split("\n");
  const right = actual.split("\n");
  const rows = left.length;
  const cols = right.length;
  const lcs: number[][] = Array.from({ length: rows + 1 }, () =>
    Array.from({ length: cols + 1 }, () => 0)
  );
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      lcs[i]![j] =
        left[i] === right[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < rows || j < cols) {
    if (i < rows && j < cols && left[i] === right[j]) {
      out.push(`  ${left[i]}`);
      i++;
      j++;
    } else if (j < cols && (i >= rows || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      out.push(`+ ${right[j]}`);
      j++;
    } else {
      out.push(`- ${left[i]}`);
      i++;
    }
  }
  // Keep only changed lines plus two lines of context around each.
  const keep = new Set<number>();
  for (const [index, line] of out.entries()) {
    if (line.startsWith("  ")) continue;
    for (let k = index - 2; k <= index + 2; k++) keep.add(k);
  }
  const rendered: string[] = [];
  let lastKept = -1;
  for (const [index, line] of out.entries()) {
    if (!keep.has(index)) continue;
    if (lastKept !== -1 && index !== lastKept + 1) rendered.push("  ...");
    rendered.push(line);
    lastKept = index;
  }
  return rendered.join("\n");
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Nearest-rank percentile over samples (p in 0..1). */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1)
  );
  return sorted[rank]!;
}
