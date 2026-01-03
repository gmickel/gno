/**
 * Eval database setup helper.
 * Creates a temp database and indexes the eval fixture corpus.
 *
 * @module evals/helpers/setup-db
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ChunkInput, StoreResult } from "../../src/store/types";

import { SqliteAdapter } from "../../src/store";

// ESM-compatible __dirname (works in vitest workers + Bun)
const __dirname = dirname(fileURLToPath(import.meta.url));

// Fixtures paths
const CORPUS_DIR = join(__dirname, "../fixtures/corpus");

// Regex patterns (top-level for performance)
const TITLE_REGEX = /^#\s+(.+)$/m;
const PARAGRAPH_SPLIT_REGEX = /\n\n+/;

// Windows transient delete errors to retry on
const RETRYABLE_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"]);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface EvalDoc {
  relPath: string;
  content: string;
  title: string;
  language: string;
}

interface EvalDbContext {
  adapter: SqliteAdapter;
  testDir: string;
  dbPath: string;
  docs: EvalDoc[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unwrap StoreResult or throw with context.
 * Evals should fail loudly for diagnostics.
 */
function mustOk<T>(result: StoreResult<T>, context: string): T {
  if (!result.ok) {
    throw new Error(
      `${context}: ${result.error.code}: ${result.error.message}`
    );
  }
  return result.value;
}

/**
 * Windows-safe cleanup with retry.
 * SQLite file handles may not be released immediately on Windows.
 */
async function safeRm(path: string, retries = 8): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return;
      if (RETRYABLE_CODES.has(err.code ?? "") && i < retries - 1) {
        await new Promise((r) => setTimeout(r, 100 * (i + 1)));
        continue;
      }
      return; // Best effort cleanup
    }
  }
}

/**
 * Load all corpus documents from evals/fixtures/corpus/{de,en,fr,it}/
 */
async function loadCorpus(): Promise<EvalDoc[]> {
  const docs: EvalDoc[] = [];
  const languages = ["de", "en", "fr", "it"];

  for (const lang of languages) {
    const langDir = join(CORPUS_DIR, lang);
    try {
      const files = await readdir(langDir);
      // Sort for determinism across platforms
      const sortedFiles = files.filter((f) => f.endsWith(".md")).sort();
      for (const file of sortedFiles) {
        const content = await Bun.file(join(langDir, file)).text();
        const titleMatch = content.match(TITLE_REGEX);
        docs.push({
          relPath: `${lang}/${file}`,
          content,
          title: titleMatch?.[1] ?? file.replace(".md", ""),
          language: lang,
        });
      }
    } catch (e) {
      // Only swallow ENOENT (missing dir), rethrow other errors
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  return docs;
}

/**
 * Simple chunking for testing.
 * Splits by double newlines, creates ~500 char chunks.
 */
function simpleChunk(content: string): ChunkInput[] {
  const paragraphs = content.split(PARAGRAPH_SPLIT_REGEX);
  const chunks: ChunkInput[] = [];
  let currentChunk = "";
  let startLine = 1;
  let currentLine = 1;

  for (const para of paragraphs) {
    const paraLines = para.split("\n").length;

    if (currentChunk.length + para.length > 500 && currentChunk.length > 0) {
      chunks.push({
        seq: chunks.length,
        pos: chunks.length * 500,
        text: currentChunk.trim(),
        startLine,
        endLine: currentLine - 1,
        tokenCount: Math.ceil(currentChunk.length / 4),
      });
      currentChunk = "";
      startLine = currentLine;
    }

    currentChunk += (currentChunk ? "\n\n" : "") + para;
    currentLine += paraLines + 1;
  }

  if (currentChunk.trim()) {
    chunks.push({
      seq: chunks.length,
      pos: chunks.length * 500,
      text: currentChunk.trim(),
      startLine,
      endLine: currentLine - 1,
      tokenCount: Math.ceil(currentChunk.length / 4),
    });
  }

  return chunks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup & Teardown
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a temp database and index the eval corpus.
 * Returns context with adapter, paths, and loaded docs.
 */
export async function setupEvalDb(): Promise<EvalDbContext> {
  const testDir = await mkdtemp(join(tmpdir(), "gno-eval-"));
  const dbPath = join(testDir, "eval.sqlite");
  const adapter = new SqliteAdapter();

  // Open with snowball stemming for better matching
  mustOk(await adapter.open(dbPath, "snowball english"), "open DB");

  // Sync collection
  mustOk(
    await adapter.syncCollections([
      {
        name: "eval",
        path: CORPUS_DIR,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ]),
    "sync collections"
  );

  // Load and index corpus
  const docs = await loadCorpus();

  // Index all docs (adapter handles transactions internally)
  for (const doc of docs) {
    const sourceHash = Bun.hash(doc.content).toString(16);
    const mirrorHash = sourceHash;

    mustOk(
      await adapter.upsertDocument({
        sourceHash,
        collection: "eval",
        relPath: doc.relPath,
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceMtime: new Date().toISOString(),
        sourceSize: doc.content.length,
        mirrorHash,
        title: doc.title,
      }),
      `upsert doc ${doc.relPath}`
    );

    mustOk(
      await adapter.upsertContent(mirrorHash, doc.content),
      `upsert content ${doc.relPath}`
    );
    mustOk(
      await adapter.syncDocumentFts("eval", doc.relPath),
      `sync FTS ${doc.relPath}`
    );

    const chunks = simpleChunk(doc.content);
    mustOk(
      await adapter.upsertChunks(mirrorHash, chunks),
      `upsert chunks ${doc.relPath}`
    );
  }

  return { adapter, testDir, dbPath, docs };
}

/**
 * Clean up temp database with Windows-safe retry.
 */
export async function teardownEvalDb(ctx: EvalDbContext): Promise<void> {
  await ctx.adapter.close();
  await safeRm(ctx.testDir);
}

/**
 * Get a shared database context.
 * Creates once, reuses across evals in same run.
 * Uses promise caching to prevent race conditions with concurrent tasks.
 */
let sharedContextPromise: Promise<EvalDbContext> | null = null;

export async function getSharedEvalDb(): Promise<EvalDbContext> {
  if (!sharedContextPromise) {
    sharedContextPromise = setupEvalDb();
  }
  return sharedContextPromise;
}

/**
 * Cleanup shared context (call at end of eval run).
 */
export async function cleanupSharedEvalDb(): Promise<void> {
  if (sharedContextPromise) {
    const ctx = await sharedContextPromise;
    await teardownEvalDb(ctx);
    sharedContextPromise = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-cleanup on process exit
// ─────────────────────────────────────────────────────────────────────────────

let cleanupRegistered = false;

function registerCleanup() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  // Best-effort cleanup when evalite exits
  process.on("beforeExit", () => {
    void cleanupSharedEvalDb();
  });

  process.on("SIGINT", () => {
    void cleanupSharedEvalDb().finally(() => process.exit(130));
  });

  process.on("SIGTERM", () => {
    void cleanupSharedEvalDb().finally(() => process.exit(143));
  });
}

// Register cleanup hook immediately on module load
registerCleanup();
