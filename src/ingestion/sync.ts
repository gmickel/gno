/**
 * Sync service - orchestrates file ingestion.
 * Walks collections, converts files, chunks content, updates store.
 *
 * @module src/ingestion/sync
 */

// node:fs - Stats type for the no-follow leaf stat handed back by the walker seam
import type { Stats } from "node:fs";

// node:fs/promises for realpath/stat (no Bun equivalent for canonical paths or file stats)
import { realpath, stat } from "node:fs/promises";
// node:path for join (no Bun path utils)
import { isAbsolute, join, relative, sep } from "node:path";

import type { NormalizedContentTypeRule } from "../config";
import type { Collection } from "../config/types";
import type {
  ChunkInput,
  DocEdgeInput,
  DocLinkInput,
  DocumentInput,
  DocumentRow,
  IngestErrorInput,
  StorePort,
  StoreResult,
} from "../store/types";
import type {
  ChunkerPort,
  CollectionSyncResult,
  ContentTypeSource,
  FileSyncResult,
  ProcessDecision,
  SyncOptions,
  SyncResult,
  WalkEntry,
  WalkerPort,
} from "./types";

import {
  fingerprintContentTypeMetadataRules,
  resolveContentTypeRule,
} from "../config";
import { createJsonlAdapter } from "../converters/adapters/jsonl/adapter";
import { createTranscriptAdapter } from "../converters/adapters/transcript/adapter";
import { getDefaultMimeDetector, type MimeDetector } from "../converters/mime";
import {
  type ConversionPipeline,
  getDefaultPipeline,
} from "../converters/pipeline";
import { DEFAULT_LIMITS, type RecordAdapter } from "../converters/types";
import {
  diffDocumentStructure,
  extractDocumentStructure,
  isRelationMap,
  normalizeRelationEdgeType,
  normalizeRelationTarget,
} from "../core/change-diff";
import { enforceCollectionEgress } from "../core/egress-enforcement";
import {
  normalizeMarkdownPath,
  normalizeWikiName,
  parseLinks,
  parseTargetParts,
} from "../core/links";
import { normalizeCollectionDirRelPath } from "../core/path-rules";
import { normalizeTag, validateTag } from "../core/tags";
import { defaultChunker } from "./chunker";
import {
  extractHashtags,
  parseFrontmatter,
  stripFrontmatter,
} from "./frontmatter";
import { buildLineOffsets } from "./position";
import { processRecordContainer } from "./record-container";
import { getExcludedRanges } from "./strip";
import { collectionToWalkConfig, DEFAULT_CHUNK_PARAMS } from "./types";
import { checkWalkPathVisibility, defaultWalker } from "./walker";

/**
 * `stat` errnos that mean "this path does not exist", so the indexed documents
 * for it are deactivated rather than reported as a failed stat.
 *
 * `ENOENT` is the ordinary deletion. `ENOTDIR` is the same structural fact
 * reached differently: a component of the path is not a directory, which is
 * exactly what an indexed directory replaced by a regular file produces for
 * every path formerly beneath it (`dir1` becomes a file, so `dir1/a.md` stats
 * `ENOTDIR`). `src/ingestion/directory-children.ts` already classifies both as
 * "missing" and hands the indexed descendants to `syncPaths`; treating
 * `ENOTDIR` as a stat failure here made those documents undeactivatable - they
 * stayed active and searchable forever.
 *
 * Every OTHER errno stays on the fail-closed `STAT_FAILED` path: a permission
 * or I/O error is a transient inability to observe the file, never evidence
 * that it is gone.
 */
const MISSING_FILE_ERROR_CODES = new Set(["ENOENT", "ENOTDIR"]);

/** What one `syncPaths` candidate turned out to be on disk. */
type SyncPathResolution =
  /** A regular file the walker can reach. `stats` is its no-follow `lstat`. */
  | { kind: "file"; stats: Stats }
  /**
   * The walker cannot reach this path, so nothing may stay indexed under it.
   *
   * Two structurally different causes, deliberately ONE outcome:
   *
   * - it is absent (`ENOENT`), or a component of it is not a directory
   *   (`ENOTDIR` - an indexed `dir1` replaced by a regular file makes every
   *   `dir1/*.md` reach here);
   * - it, or a component above it, is a SYMLINK. `FileWalker.walk` scans with
   *   `followSymlinks: false` and emits neither symlinked directories nor
   *   symlinked files, so a full `gno update` indexes nothing through one and
   *   deactivates whatever it previously had there.
   *
   * The second used to be invisible here, because the question asked was a
   * FOLLOWING `stat`: an indexed `dir/note.md` whose `dir` had become
   * `dir -> real/` statted alive and stayed active, while a full update
   * deactivated it. That divergence between the watcher and the walker is the
   * entire reason the policy is enforced here, at the one seam every write path
   * goes through, rather than in whichever caller happened to notice.
   */
  | { kind: "unreachable" }
  /** Reachable, but not a regular file (a real directory, a socket, a fifo). */
  | { kind: "notFile" }
  /** The path escapes the collection root and must never be resolved at all. */
  | { kind: "escaped" }
  /** Unreadable, not absent: infer nothing, fail closed. */
  | { kind: "failed"; message: string };

/**
 * Resolve one candidate under `FileWalker.walk`'s no-follow policy.
 *
 * This replaces the following `stat` that used to open the loop body, and the
 * replacement is the point: the walker's reachability rule and the sync's
 * existence rule are now the same rule, read from the same place
 * (`checkWalkPathVisibility`), so the watcher cannot converge on a set of active
 * documents that a full `gno update` disagrees with.
 *
 * The `lstat` it already performs on the leaf is returned rather than thrown
 * away, so a reachable file is not statted twice.
 */
async function resolveSyncPath(
  collectionPath: string,
  relPath: string
): Promise<SyncPathResolution> {
  const normalized = normalizeCollectionDirRelPath(relPath);
  if (normalized === null || normalized === "") {
    return { kind: "escaped" };
  }
  const visibility = await checkWalkPathVisibility(collectionPath, normalized);
  if (visibility.status === "symlink" || visibility.status === "missing") {
    return { kind: "unreachable" };
  }
  if (visibility.status === "error") {
    const { cause } = visibility;
    const code = (cause as { code?: unknown } | null)?.code;
    // Preserved verbatim from the old `stat` branch: a code in the missing set
    // could only arrive here from a hook-free path, but the classification is
    // the file's, not the syscall's, so it stays with the file.
    if (typeof code === "string" && MISSING_FILE_ERROR_CODES.has(code)) {
      return { kind: "unreachable" };
    }
    return {
      kind: "failed",
      message: cause instanceof Error ? cause.message : "Failed to stat file",
    };
  }
  return visibility.leaf?.isFile()
    ? { kind: "file", stats: visibility.leaf }
    : { kind: "notFile" };
}

/** Default concurrency for file processing */
const DEFAULT_CONCURRENCY = 1;

/** Batch size for grouping writes into single transaction (Windows perf) */
const TX_BATCH_SIZE = 50;

/** Max concurrency to prevent resource exhaustion */
const MAX_CONCURRENCY = 16;

/**
 * Current ingest schema version.
 * Increment when ingestion adds new derived data (tags, metadata, etc.)
 * Documents with ingestVersion < INGEST_VERSION will be re-processed.
 */
export const INGEST_VERSION = 6;
const EMPTY_CONTENT_TYPE_RULES_FINGERPRINT =
  fingerprintContentTypeMetadataRules([]);
const RELATION_EDGE_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;
const PROJECTION_YIELD_INTERVAL = 25;
const NON_RETRYABLE_CONVERSION_ERROR_CODES = new Set([
  "CORRUPT",
  "PERMISSION",
  "TOO_LARGE",
  "UNSUPPORTED",
]);

function findDocByWikiRef(
  docs: DocumentRow[],
  targetRef: string,
  collection?: string
): DocumentRow | undefined {
  const normalized = normalizeWikiName(targetRef);
  const candidates = collection
    ? docs.filter((doc) => doc.collection === collection)
    : docs;

  return candidates.find((doc) => {
    const title = doc.title ?? doc.relPath.split("/").pop() ?? doc.relPath;
    const relStem = doc.relPath.replace(/\.[^/.]+$/, "");
    return (
      normalizeWikiName(title) === normalized ||
      normalizeWikiName(doc.relPath) === normalized ||
      normalizeWikiName(relStem) === normalized
    );
  });
}

function resolveRelationTarget(
  docs: DocumentRow[],
  sourceDoc: DocumentRow,
  rawTarget: string
): DocumentRow | undefined {
  const target = normalizeRelationTarget(rawTarget);
  if (!target) {
    return undefined;
  }

  if (target.startsWith("#")) {
    return docs.find((doc) => doc.docid === target);
  }

  if (target.startsWith("gno://")) {
    return docs.find((doc) => doc.uri === target);
  }

  const parts = parseTargetParts(target);
  const targetCollection = parts.collection;
  const targetRef = parts.ref;
  if (!targetRef) {
    return undefined;
  }

  if (targetCollection) {
    const exact = docs.find(
      (doc) => doc.collection === targetCollection && doc.relPath === targetRef
    );
    return exact ?? findDocByWikiRef(docs, targetRef, targetCollection);
  }

  const sameCollectionPath = normalizeMarkdownPath(
    targetRef,
    sourceDoc.relPath
  );
  if (sameCollectionPath) {
    const exact = docs.find(
      (doc) =>
        doc.collection === sourceDoc.collection &&
        doc.relPath === sameCollectionPath
    );
    if (exact) {
      return exact;
    }
  }

  const explicitCollPath = docs.find(
    (doc) => `${doc.collection}/${doc.relPath}` === targetRef
  );
  if (explicitCollPath) {
    return explicitCollPath;
  }

  return (
    findDocByWikiRef(docs, targetRef, sourceDoc.collection) ??
    findDocByWikiRef(docs, targetRef)
  );
}

function getPrimaryGraphHint(
  contentType: string | null | undefined,
  rules: NormalizedContentTypeRule[]
): string | undefined {
  if (!contentType) {
    return undefined;
  }
  const rule = rules.find((candidate) => candidate.id === contentType);
  return rule?.graphHints?.[0];
}

/**
 * Decide whether to process a file or skip it.
 * Handles repair cases where sourceHash matches but content is incomplete.
 * Also triggers re-processing for documents with outdated ingest version.
 */
function decideAction(
  existing: DocumentRow | null,
  sourceHash: string,
  contentTypeRulesFingerprint: string
): ProcessDecision {
  // No existing doc - must process
  if (!existing) {
    return { kind: "process", reason: "new file" };
  }

  // Source hash changed - must process
  if (existing.sourceHash !== sourceHash) {
    return { kind: "process", reason: "content changed" };
  }

  // Source unchanged, but check for repair cases:

  // Preserve non-retryable conversion failures until the source or ingest
  // version changes. Re-running an unchanged corrupt/protected file on every
  // sync only repeats expensive work and noisy diagnostics.
  if (
    existing.lastErrorCode &&
    NON_RETRYABLE_CONVERSION_ERROR_CODES.has(existing.lastErrorCode) &&
    existing.ingestVersion === INGEST_VERSION
  ) {
    return {
      kind: "skip",
      reason: "unchanged non-retryable conversion failure",
    };
  }

  // 1. Previous conversion failed (mirrorHash is null)
  if (!existing.mirrorHash) {
    return { kind: "repair", reason: "previous conversion failed" };
  }

  // 2. Document has error recorded
  if (existing.lastErrorCode) {
    return { kind: "repair", reason: "previous error recorded" };
  }

  // 3. Ingest version is outdated (new derived data available)
  if (
    existing.ingestVersion === null ||
    existing.ingestVersion < INGEST_VERSION
  ) {
    return { kind: "repair", reason: "ingest version outdated" };
  }

  const hasLegacyEmptyRulesFingerprint =
    existing.contentTypeRulesFingerprint === null &&
    contentTypeRulesFingerprint === EMPTY_CONTENT_TYPE_RULES_FINGERPRINT;
  if (
    existing.contentTypeRulesFingerprint !== contentTypeRulesFingerprint &&
    !hasLegacyEmptyRulesFingerprint
  ) {
    return { kind: "repair", reason: "content type rules changed" };
  }

  // All good - skip
  return { kind: "skip", reason: "unchanged" };
}

/**
 * Extract tags from markdown content.
 * Combines frontmatter tags and inline hashtags, normalized and validated.
 */
function extractTags(markdown: string): string[] {
  const tags = new Set<string>();

  // 1. Extract from frontmatter
  const frontmatter = parseFrontmatter(markdown);
  for (const tag of frontmatter.tags) {
    const normalized = normalizeTag(tag);
    if (validateTag(normalized)) {
      tags.add(normalized);
    }
  }

  // 2. Extract hashtags from body (after stripping frontmatter)
  const body = stripFrontmatter(markdown);
  const hashtags = extractHashtags(body);
  for (const tag of hashtags) {
    const normalized = normalizeTag(tag);
    if (validateTag(normalized)) {
      tags.add(normalized);
    }
  }

  return [...tags];
}

interface DocumentMetadata {
  contentType?: string;
  contentTypeSource: ContentTypeSource;
  categories?: string[];
  author?: string;
  frontmatterDate?: string;
  dateFields?: Record<string, string>;
}

const CODE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".go",
  ".java",
  ".js",
  ".jsx",
  ".m",
  ".mm",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".swift",
  ".ts",
  ".tsx",
]);

const AUTHOR_KEYS = ["author", "by", "owner", "creator"] as const;
const DATE_KEYS = [
  "date",
  "published",
  "published_at",
  "created",
  "created_at",
  "updated",
  "updated_at",
] as const;
const DATE_FIELD_KEY_REGEX =
  /(^|_)(date|time|created|updated|published|modified|deadline|expires|expiry|start|end)(_|$)/;

function normalizeMetadataKey(rawKey: string): string {
  return rawKey
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function normalizeDate(value: unknown): string | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const normalizedValue =
    typeof value === "string"
      ? value.trim().replace(/^["'](.*)["']$/, "$1")
      : value;
  const parsed = new Date(normalizedValue);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed.toISOString();
}

function inferPathContentType(
  relPath: string,
  ext: string
): {
  contentType: string;
  source: ContentTypeSource;
} {
  const lowerPath = relPath.toLowerCase();
  if (CODE_EXTENSIONS.has(ext.toLowerCase())) {
    return { contentType: "code", source: "path-ext" };
  }
  if (/(meeting|standup|retro|minutes)/.test(lowerPath)) {
    return { contentType: "meeting", source: "path-ext" };
  }
  if (/(spec|rfc|adr|design)/.test(lowerPath)) {
    return { contentType: "spec", source: "path-ext" };
  }
  if (/(notes|journal|log)/.test(lowerPath)) {
    return { contentType: "notes", source: "path-ext" };
  }
  return { contentType: "prose", source: "fallback" };
}

function normalizeFrontmatterScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const first = trimmed[0];
  const last = trimmed.at(-1);
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseCategories(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input
      .filter((v): v is string => typeof v === "string")
      .map((v) => normalizeFrontmatterScalar(v).toLowerCase())
      .filter((v) => v.length > 0);
  }
  if (typeof input === "string") {
    return input
      .split(",")
      .map((v) => normalizeFrontmatterScalar(v).toLowerCase())
      .filter((v) => v.length > 0);
  }
  return [];
}

export function extractDocumentMetadata(
  markdown: string,
  relPath: string,
  ext: string,
  contentTypeRules: NormalizedContentTypeRule[] = []
): DocumentMetadata {
  const parsed = parseFrontmatter(markdown);
  const metadata = parsed.metadata;
  const rawFrontmatterType =
    typeof metadata.type === "string"
      ? normalizeFrontmatterScalar(metadata.type)
      : "";
  const configuredRule = resolveContentTypeRule(
    rawFrontmatterType,
    relPath,
    contentTypeRules
  );
  const inferred = inferPathContentType(relPath, ext);
  const contentType = configuredRule?.rule.id ?? inferred.contentType;
  const contentTypeSource: ContentTypeSource =
    configuredRule?.source === "configured-id"
      ? "frontmatter-type"
      : configuredRule?.source === "prefix"
        ? "prefix"
        : inferred.source;
  const categories = new Set<string>([contentType]);

  const fmCategories = parseCategories(
    metadata.category ?? metadata.categories ?? metadata.type
  );
  for (const category of fmCategories) {
    categories.add(category);
  }

  let author: string | undefined;
  for (const key of AUTHOR_KEYS) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim().length > 0) {
      author = value.trim();
      break;
    }
  }

  const normalizedMetadata = new Map<string, unknown>();
  for (const [rawKey, value] of Object.entries(metadata)) {
    const key = normalizeMetadataKey(rawKey);
    if (key.length > 0 && !normalizedMetadata.has(key)) {
      normalizedMetadata.set(key, value);
    }
  }

  let frontmatterDate: string | undefined;
  for (const key of DATE_KEYS) {
    const normalized = normalizeDate(normalizedMetadata.get(key));
    if (normalized) {
      frontmatterDate = normalized;
      break;
    }
  }

  const dateFields: Record<string, string> = {};
  for (const [key, value] of normalizedMetadata.entries()) {
    if (!DATE_FIELD_KEY_REGEX.test(key)) {
      continue;
    }
    const normalized = normalizeDate(value);
    if (normalized) {
      dateFields[key] = normalized;
    }
  }

  return {
    contentType,
    contentTypeSource,
    categories: [...categories],
    author,
    frontmatterDate,
    dateFields: Object.keys(dateFields).length > 0 ? dateFields : undefined,
  };
}

/**
 * Check if path is a git repository (supports worktrees and submodules).
 * Uses git rev-parse which handles all git directory layouts.
 */
async function isGitRepo(path: string): Promise<boolean> {
  try {
    const result = await Bun.$`git -C ${path} rev-parse --is-inside-work-tree`
      .quiet()
      .nothrow();
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Run git pull in directory (best effort).
 */
async function gitPull(path: string): Promise<void> {
  try {
    await Bun.$`git -C ${path} pull`.quiet().nothrow();
  } catch {
    // Ignore git pull failures
  }
}

/**
 * Run collection update command (best effort).
 */
async function runUpdateCmd(path: string, cmd: string): Promise<void> {
  try {
    await Bun.$`sh -c ${cmd}`.cwd(path).quiet().nothrow();
  } catch {
    // Ignore update command failures
  }
}

/**
 * Helper to unwrap Result and throw on error.
 * Provides consistent error handling for store operations.
 */
function mustOk<T>(
  result: StoreResult<T>,
  operation: string,
  context: Record<string, unknown>
): T {
  if (!result.ok) {
    const error = new Error(
      `Store operation failed: ${operation} - ${result.error.message}`
    );
    (error as Error & { context: unknown }).context = context;
    throw error;
  }
  return result.value;
}

const preserveDocumentWithError = (
  existing: DocumentRow,
  code: string,
  message: string
): DocumentInput => ({
  collection: existing.collection,
  relPath: existing.relPath,
  sourceHash: existing.sourceHash,
  sourceMime: existing.sourceMime,
  sourceExt: existing.sourceExt,
  sourceSize: existing.sourceSize,
  sourceMtime: existing.sourceMtime,
  sourceCtime: existing.sourceCtime ?? existing.sourceMtime,
  title: existing.title ?? undefined,
  mirrorHash: existing.mirrorHash ?? undefined,
  converterId: existing.converterId ?? undefined,
  converterVersion: existing.converterVersion ?? undefined,
  languageHint: existing.languageHint ?? undefined,
  contentType: existing.contentType ?? undefined,
  contentTypeSource: existing.contentTypeSource ?? undefined,
  categories: existing.categories ?? undefined,
  author: existing.author ?? undefined,
  frontmatterDate: existing.frontmatterDate ?? undefined,
  dateFields: existing.dateFields ?? undefined,
  recordKey: existing.recordKey ?? undefined,
  recordSourcePath: existing.recordSourcePath ?? undefined,
  recordSourceLocator: existing.recordSourceLocator ?? undefined,
  recordMetadata: existing.recordMetadata ?? undefined,
  recordAnchors: existing.recordAnchors ?? undefined,
  recordAdapterFingerprint: existing.recordAdapterFingerprint ?? undefined,
  lastErrorCode: code,
  lastErrorMessage: message,
  ingestVersion: existing.ingestVersion ?? undefined,
  contentTypeRulesFingerprint:
    existing.contentTypeRulesFingerprint ?? undefined,
  changeJournal: false,
});

/**
 * Simple semaphore for bounded concurrency.
 */
class Semaphore {
  private permits: number;
  private readonly waiting: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.permits += 1;
    }
  }
}

/**
 * Sync service implementation.
 */
export class SyncService {
  private readonly walker: WalkerPort;
  private readonly chunker: ChunkerPort;
  private readonly mimeDetector: MimeDetector;
  private readonly pipeline: ConversionPipeline;

  constructor(
    walker?: WalkerPort,
    chunker?: ChunkerPort,
    mimeDetector?: MimeDetector,
    pipeline?: ConversionPipeline
  ) {
    this.walker = walker ?? defaultWalker;
    this.chunker = chunker ?? defaultChunker;
    this.mimeDetector = mimeDetector ?? getDefaultMimeDetector();
    this.pipeline = pipeline ?? getDefaultPipeline();
  }

  private async selectRecordAdapter(
    collection: Collection,
    mime: string,
    ext: string
  ): Promise<RecordAdapter | undefined> {
    const transcriptConfig = collection.recordAdapters?.transcript;
    if (transcriptConfig) {
      const adapter = createTranscriptAdapter(transcriptConfig);
      if (adapter.canHandle(mime, ext)) return adapter;
    }
    const jsonlConfig = collection.recordAdapters?.jsonl;
    if (jsonlConfig) {
      const adapter = createJsonlAdapter(jsonlConfig.fieldMapping);
      if (adapter.canHandle(mime, ext)) return adapter;
    }
    const selectDefault = (
      this.pipeline as ConversionPipeline & {
        selectRecordAdapter?: ConversionPipeline["selectRecordAdapter"];
      }
    ).selectRecordAdapter;
    if (!selectDefault) return undefined;
    return selectDefault.call(this.pipeline, mime, ext);
  }

  /**
   * Process a single file through the ingestion pipeline.
   * All store operations are checked and errors are propagated.
   */
  // oxlint-disable-next-line max-lines-per-function -- file processing with multiple extraction paths
  private async processFile(
    collection: Collection,
    entry: WalkEntry,
    store: StorePort,
    options: SyncOptions
  ): Promise<FileSyncResult> {
    const limits = {
      maxBytes: options.limits?.maxBytes ?? DEFAULT_LIMITS.maxBytes,
      timeoutMs: options.limits?.timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
      maxOutputChars:
        options.limits?.maxOutputChars ?? DEFAULT_LIMITS.maxOutputChars,
    };

    try {
      // 1. Re-stat before read to enforce maxBytes on current file size
      let sourceSize = entry.size;
      let sourceMtime = entry.mtime;
      let sourceCtime = entry.ctime;
      try {
        const sourceStat = await stat(entry.absPath);
        if (!sourceStat.isFile()) {
          return {
            relPath: entry.relPath,
            status: "error",
            errorCode: "NOT_FILE",
            errorMessage: "Path is not a file",
          };
        }
        sourceSize = sourceStat.size;
        sourceMtime = sourceStat.mtime.toISOString();
        sourceCtime = (
          sourceStat.birthtime ??
          sourceStat.ctime ??
          sourceStat.mtime
        ).toISOString();
      } catch {
        return {
          relPath: entry.relPath,
          status: "error",
          errorCode: "NOT_FOUND",
          errorMessage: "File not found",
        };
      }

      if (sourceSize > limits.maxBytes) {
        const message = `File size ${sourceSize} exceeds limit ${limits.maxBytes}`;
        await store
          .recordError({
            collection: collection.name,
            relPath: entry.relPath,
            code: "TOO_LARGE",
            message,
          })
          .catch(() => undefined);
        return {
          relPath: entry.relPath,
          status: "skipped",
          errorCode: "TOO_LARGE",
          errorMessage: message,
        };
      }

      const extensionMime = this.mimeDetector.detect(
        entry.relPath,
        new Uint8Array()
      );
      const recordAdapter = await this.selectRecordAdapter(
        collection,
        extensionMime.mime,
        extensionMime.ext
      );
      const contentTypeRules = options.contentTypeRules ?? [];
      const contentTypeRulesFingerprint =
        options.contentTypeRulesFingerprint ??
        fingerprintContentTypeMetadataRules(contentTypeRules);
      if (recordAdapter) {
        return await processRecordContainer({
          adapter: recordAdapter,
          chunker: this.chunker,
          collection,
          contentTypeRules,
          contentTypeRulesFingerprint,
          entry,
          ext: extensionMime.ext,
          extractMetadata: extractDocumentMetadata,
          ingestVersion: INGEST_VERSION,
          mime: extensionMime.mime,
          options,
          sourceCtime,
          sourceMtime,
          sourceSize,
          store,
        });
      }

      const sniffBytes = new Uint8Array(
        await Bun.file(entry.absPath).slice(0, 512).arrayBuffer()
      );
      const mime = this.mimeDetector.detect(entry.relPath, sniffBytes);

      const priorRecordDocuments = mustOk(
        await store.listRecordDocuments(collection.name, entry.relPath),
        "listRecordDocuments",
        { collection: collection.name, relPath: entry.relPath }
      );

      // 2. Read byte-oriented files only after record-adapter selection.
      const bytes = await Bun.file(entry.absPath).bytes();

      // 3. Compute sourceHash
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(bytes);
      const sourceHash = hasher.digest("hex");

      // 4. Check existing doc for skip/repair decision
      const existingResult = await store.getDocument(
        collection.name,
        entry.relPath
      );
      const existing = existingResult.ok ? existingResult.value : null;
      const decision = decideAction(
        existing,
        sourceHash,
        contentTypeRulesFingerprint
      );

      if (decision.kind === "skip") {
        const activeRecordPaths = priorRecordDocuments
          .filter((document) => document.active)
          .map((document) => document.relPath);
        if (activeRecordPaths.length > 0) {
          mustOk(
            await store.markInactive(collection.name, activeRecordPaths),
            "markInactive",
            { collection: collection.name, relPath: entry.relPath }
          );
          return { relPath: entry.relPath, status: "updated" };
        }
        return { relPath: entry.relPath, status: "unchanged" };
      }

      // 6. Convert via pipeline
      const convertResult = await this.pipeline.convert({
        sourcePath: entry.absPath,
        relativePath: entry.relPath,
        collection: collection.name,
        bytes,
        mime: mime.mime,
        ext: mime.ext,
        limits,
      });

      if (!convertResult.ok) {
        // Record error (checked)
        const errorInput: IngestErrorInput = {
          collection: collection.name,
          relPath: entry.relPath,
          code: convertResult.error.code,
          message: convertResult.error.message,
          details: convertResult.error.details,
        };
        const recordResult = await store.recordError(errorInput);
        if (!recordResult.ok) {
          // Log but continue - error recording is best-effort
        }

        const hadRetrievableEvidence = Boolean(existing?.mirrorHash);
        const structureDelta = hadRetrievableEvidence
          ? diffDocumentStructure(
              await this.readPreviousStructure(store, existing),
              {
                headings: [],
                links: [],
                typedEdges: [],
                dates: {},
              }
            ).delta
          : undefined;

        // Upsert document with error info, explicitly clear mirrorHash. This
        // transition is journaled only when retrievable evidence previously
        // existed; initial/repeated error placeholders are not evidence
        // creates. Real evidence disappearance stays in the same transaction
        // so saved Capsule freshness checks cannot miss it.
        const upsertResult = await store.upsertDocument({
          collection: collection.name,
          relPath: entry.relPath,
          sourceHash,
          sourceMime: mime.mime,
          sourceExt: mime.ext,
          sourceSize,
          sourceMtime,
          sourceCtime,
          lastErrorCode: convertResult.error.code,
          lastErrorMessage: convertResult.error.message,
          ingestVersion: INGEST_VERSION,
          contentTypeRulesFingerprint,
          changeJournal: structureDelta ? { structureDelta } : false,
          // mirrorHash intentionally omitted (will be null)
        });

        if (!upsertResult.ok) {
          return {
            relPath: entry.relPath,
            status: "error",
            errorCode: "STORE_ERROR",
            errorMessage: upsertResult.error.message,
          };
        }

        return {
          relPath: entry.relPath,
          status: "error",
          errorCode: convertResult.error.code,
          errorMessage: convertResult.error.message,
        };
      }

      const artifact = convertResult.value;
      const extractedMetadata = extractDocumentMetadata(
        artifact.markdown,
        entry.relPath,
        mime.ext,
        contentTypeRules
      );
      const previousStructure = await this.readPreviousStructure(
        store,
        existing
      );
      const nextStructure = extractDocumentStructure(
        artifact.markdown,
        entry.relPath,
        extractedMetadata.dateFields
      );
      const structureDelta = diffDocumentStructure(
        previousStructure,
        nextStructure
      ).delta;

      const persistSuccessfulFile = async (): Promise<FileSyncResult> => {
        // 7. Upsert document - EXPLICITLY clear error fields on success
        const docidResult = await store.upsertDocument({
          collection: collection.name,
          relPath: entry.relPath,
          sourceHash,
          sourceMime: mime.mime,
          sourceExt: mime.ext,
          sourceSize,
          sourceMtime,
          sourceCtime,
          title: artifact.title,
          mirrorHash: artifact.mirrorHash,
          converterId: artifact.meta.converterId,
          converterVersion: artifact.meta.converterVersion,
          languageHint: artifact.languageHint ?? collection.languageHint,
          contentType: extractedMetadata.contentType,
          contentTypeSource: extractedMetadata.contentTypeSource,
          categories: extractedMetadata.categories,
          author: extractedMetadata.author,
          frontmatterDate: extractedMetadata.frontmatterDate,
          dateFields: extractedMetadata.dateFields,
          contentTypeRulesFingerprint,
          // Clear error fields on success (requires store to handle undefined → null)
          lastErrorCode: undefined,
          lastErrorMessage: undefined,
          ingestVersion: INGEST_VERSION,
          changeJournal: { structureDelta },
        });

        const { id: docId, docid } = mustOk(docidResult, "upsertDocument", {
          collection: collection.name,
          relPath: entry.relPath,
        });

        // 8. Upsert content (content-addressed dedupe) - CHECKED
        const contentResult = await store.upsertContent(
          artifact.mirrorHash,
          artifact.markdown
        );
        mustOk(contentResult, "upsertContent", {
          mirrorHash: artifact.mirrorHash,
        });

        // 9. Chunk content
        const chunks = this.chunker.chunk(
          artifact.markdown,
          DEFAULT_CHUNK_PARAMS,
          artifact.languageHint ?? collection.languageHint,
          entry.relPath
        );

        // 10. Convert to ChunkInput for store
        const chunkInputs: ChunkInput[] = chunks.map((c) => ({
          seq: c.seq,
          pos: c.pos,
          text: c.text,
          startLine: c.startLine,
          endLine: c.endLine,
          language: c.language ?? undefined,
          tokenCount: c.tokenCount ?? undefined,
        }));

        // 11. Upsert chunks - CHECKED
        const chunksResult = await store.upsertChunks(
          artifact.mirrorHash,
          chunkInputs
        );
        mustOk(chunksResult, "upsertChunks", {
          mirrorHash: artifact.mirrorHash,
          chunkCount: chunkInputs.length,
        });

        // 12. Rebuild FTS for this hash - CHECKED
        const ftsResult = await store.rebuildFtsForHash(artifact.mirrorHash);
        mustOk(ftsResult, "rebuildFtsForHash", {
          mirrorHash: artifact.mirrorHash,
        });

        // 13. Extract and store tags from frontmatter and body hashtags
        // Always call setDocTags to clear removed tags on re-sync
        const extractedTags = extractTags(artifact.markdown);
        const tagsResult = await store.setDocTags(
          docId,
          extractedTags,
          "frontmatter"
        );
        mustOk(tagsResult, "setDocTags", {
          docId,
          tagCount: extractedTags.length,
        });

        // 14. Extract and store links (wiki and markdown links)
        const excludedRanges = getExcludedRanges(artifact.markdown);
        const lineOffsets = buildLineOffsets(artifact.markdown);
        const parsedLinks = parseLinks(
          artifact.markdown,
          lineOffsets,
          excludedRanges
        );

        const linkInputs: DocLinkInput[] = [];
        for (const link of parsedLinks) {
          // Compute target_ref_norm based on link type
          let targetRefNorm: string;
          if (link.kind === "wiki") {
            targetRefNorm = normalizeWikiName(link.targetRef);
          } else {
            // Markdown links with collection prefix are not supported
            // (use wiki links for cross-collection references)
            if (link.targetCollection) {
              continue;
            }
            const resolved = normalizeMarkdownPath(
              link.targetRef,
              entry.relPath
            );
            if (!resolved) {
              // Link escapes collection root - skip silently
              continue;
            }
            targetRefNorm = resolved;
          }

          linkInputs.push({
            targetRef: link.targetRef,
            targetRefNorm,
            targetAnchor: link.targetAnchor,
            targetCollection: link.targetCollection,
            linkType: link.kind,
            linkText: link.displayText,
            startLine: link.startLine,
            startCol: link.startCol,
            endLine: link.endLine,
            endCol: link.endCol,
          });
        }

        const linksResult = await store.setDocLinks(
          docId,
          linkInputs,
          "parsed"
        );
        mustOk(linksResult, "setDocLinks", {
          docId,
          linkCount: linkInputs.length,
        });

        const activeRecordPaths = priorRecordDocuments
          .filter((document) => document.active)
          .map((document) => document.relPath);
        if (activeRecordPaths.length > 0) {
          mustOk(
            await store.markInactive(collection.name, activeRecordPaths),
            "markInactive",
            { collection: collection.name, relPath: entry.relPath }
          );
        }

        const status =
          existing || priorRecordDocuments.length > 0 ? "updated" : "added";
        return {
          relPath: entry.relPath,
          status,
          docid,
          mirrorHash: artifact.mirrorHash,
          contentType: extractedMetadata.contentType,
          contentTypeSource: extractedMetadata.contentTypeSource,
        };
      };
      if (!store.withTransaction) {
        return await persistSuccessfulFile();
      }
      const persisted = await store.withTransaction(persistSuccessfulFile);
      return mustOk(persisted, "persistSuccessfulFile", {
        collection: collection.name,
        relPath: entry.relPath,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      // Distinguish store errors from other internal errors
      const isStoreError =
        message.startsWith("Store operation failed:") ||
        (error instanceof Error &&
          (error as Error & { context?: unknown }).context !== undefined);
      const code = isStoreError ? "STORE_ERROR" : "INTERNAL";

      // Record internal error to store (best-effort)
      try {
        await store.recordError({
          collection: collection.name,
          relPath: entry.relPath,
          code,
          message,
          details: {
            stack: error instanceof Error ? error.stack : undefined,
          },
        });

        // Also update document with error info if it exists
        const existingResult = await store.getDocument(
          collection.name,
          entry.relPath
        );
        if (existingResult.ok && existingResult.value?.active) {
          await store.upsertDocument(
            preserveDocumentWithError(existingResult.value, code, message)
          );
        }
      } catch {
        // Best-effort error recording
      }

      return {
        relPath: entry.relPath,
        status: "error",
        errorCode: code,
        errorMessage: message,
      };
    }
  }

  private async readPreviousStructure(
    store: StorePort,
    existing: DocumentRow | null
  ): Promise<ReturnType<typeof extractDocumentStructure> | null | undefined> {
    if (!existing) return null;
    if (!existing.mirrorHash) return undefined;

    const content = await store.getContent(existing.mirrorHash);
    if (!content.ok) {
      throw new Error(`Store operation failed: ${content.error.message}`, {
        cause: content.error,
      });
    }
    if (content.value === null) return undefined;
    return extractDocumentStructure(
      content.value,
      existing.relPath,
      existing.dateFields
    );
  }

  /**
   * Sync a specific set of files within a collection.
   */
  async syncFiles(
    collection: Collection,
    store: StorePort,
    relPaths: string[],
    options: SyncOptions = {}
  ): Promise<FileSyncResult[]> {
    const result = await this.syncPaths(collection, store, relPaths, options);
    return result.files ?? [];
  }

  /**
   * Sync an explicit set of collection-relative paths, without walking.
   *
   * Each path is resolved under `FileWalker.walk`'s no-follow policy
   * (`resolveSyncPath`), so what this indexes and what a full `gno update`
   * indexes cannot diverge: a path the walker cannot reach - absent, or standing
   * at or under a symlink - is deactivated exactly as a deleted one is.
   */
  async syncPaths(
    collection: Collection,
    store: StorePort,
    relPaths: string[],
    options: SyncOptions = {}
  ): Promise<CollectionSyncResult> {
    const startedAt = Date.now();
    const syncOptions: SyncOptions = {
      ...options,
      contentTypeRules: options.contentTypeRules ?? [],
      contentTypeRulesFingerprint:
        options.contentTypeRulesFingerprint ??
        fingerprintContentTypeMetadataRules(options.contentTypeRules ?? []),
    };
    const results: FileSyncResult[] = [];
    const projectionSourceIds = new Set<number>();
    let markedInactive = 0;

    for (const relPath of relPaths) {
      const recordDocumentsResult = await store.listRecordDocuments(
        collection.name,
        relPath
      );
      if (!recordDocumentsResult.ok) {
        results.push({
          relPath,
          status: "error",
          errorCode: recordDocumentsResult.error.code,
          errorMessage: recordDocumentsResult.error.message,
        });
        continue;
      }
      const recordDocuments = recordDocumentsResult.value;
      const existingResult = await store.getDocument(collection.name, relPath);
      const existingDoc = existingResult.ok ? existingResult.value : null;
      if (existingDoc) {
        await this.collectProjectionSourceIds(
          store,
          existingDoc.id,
          projectionSourceIds
        );
      }
      for (const recordDocument of recordDocuments) {
        await this.collectProjectionSourceIds(
          store,
          recordDocument.id,
          projectionSourceIds
        );
      }

      const absPath = join(collection.path, relPath);
      const resolution = await resolveSyncPath(collection.path, relPath);

      if (resolution.kind === "failed") {
        results.push({
          relPath,
          status: "error",
          errorCode: "STAT_FAILED",
          errorMessage: resolution.message,
        });
        continue;
      }
      if (resolution.kind === "escaped") {
        results.push({
          relPath,
          status: "error",
          errorCode: "PATH_OUTSIDE_COLLECTION",
          errorMessage: "Source path resolves outside the collection root.",
        });
        continue;
      }
      if (resolution.kind === "notFile") {
        results.push({
          relPath,
          status: "error",
          errorCode: "NOT_FILE",
          errorMessage: "Path is not a file",
        });
        continue;
      }
      if (resolution.kind === "unreachable") {
        // Absent, or out of the walker's no-follow reach - the same conclusion
        // either way, and the same one a full `gno update` reaches. Deactivation
        // happens HERE rather than in any caller, so it inherits everything this
        // batch already provides: the flush's generation revalidation around it,
        // this per-path `markInactive` (which is what keeps a large subtree from
        // exceeding SQLite's variable limit in one statement), the sync result's
        // `filesMarkedInactive` count, the document-change events and scheduler
        // notification the flush derives from it, and typed-edge projection over
        // `projectionSourceIds`.
        const activePaths = [
          ...(existingDoc?.active ? [relPath] : []),
          ...recordDocuments
            .filter((document) => document.active)
            .map((document) => document.relPath),
        ];
        if (activePaths.length > 0) {
          const inactiveResult = await store.markInactive(
            collection.name,
            activePaths
          );
          if (!inactiveResult.ok) {
            results.push({
              relPath,
              status: "error",
              errorCode: inactiveResult.error.code,
              errorMessage: inactiveResult.error.message,
            });
            continue;
          }
          markedInactive += inactiveResult.value;
          results.push({
            relPath,
            status: "updated",
            docid: existingDoc?.docid,
          });
          continue;
        }
        results.push({
          relPath,
          status: existingDoc ? "unchanged" : "skipped",
          docid: existingDoc?.docid,
        });
        continue;
      }

      const stats = resolution.stats;

      let canonicalSourcePath: string;
      try {
        const [collectionRoot, sourcePath] = await Promise.all([
          realpath(collection.path),
          realpath(absPath),
        ]);
        const sourceRelative = relative(collectionRoot, sourcePath);
        if (
          sourceRelative === ".." ||
          sourceRelative.startsWith(`..${sep}`) ||
          isAbsolute(sourceRelative)
        ) {
          results.push({
            relPath,
            status: "error",
            errorCode: "PATH_OUTSIDE_COLLECTION",
            errorMessage: "Source path resolves outside the collection root.",
          });
          continue;
        }
        canonicalSourcePath = sourcePath;
      } catch {
        results.push({
          relPath,
          status: "error",
          errorCode: "PATH_UNRESOLVED",
          errorMessage: "Source path could not be resolved safely.",
        });
        continue;
      }

      const entry: WalkEntry = {
        absPath: canonicalSourcePath,
        relPath,
        size: stats.size,
        mtime: stats.mtime.toISOString(),
        ctime: (stats.birthtime ?? stats.ctime ?? stats.mtime).toISOString(),
      };

      const result = await this.processFile(
        collection,
        entry,
        store,
        syncOptions
      );
      results.push(result);
      const currentResult = await store.getDocument(collection.name, relPath);
      const currentDoc = currentResult.ok ? currentResult.value : null;
      if (currentDoc?.active) {
        await this.collectProjectionSourceIds(
          store,
          currentDoc.id,
          projectionSourceIds
        );
      }
      const currentDocuments = await store.listRecordDocuments(
        collection.name,
        relPath
      );
      if (currentDocuments.ok) {
        for (const recordDocument of currentDocuments.value) {
          if (recordDocument.active) {
            await this.collectProjectionSourceIds(
              store,
              recordDocument.id,
              projectionSourceIds
            );
          }
        }
      }
    }

    const errors =
      syncOptions.projectTypedEdges === false
        ? []
        : await this.projectTypedEdges(store, syncOptions, projectionSourceIds);
    const added = results.filter((result) => result.status === "added").length;
    const updated = results.filter(
      (result) => result.status === "updated"
    ).length;
    const unchanged = results.filter(
      (result) => result.status === "unchanged"
    ).length;
    const errored = results.filter(
      (result) => result.status === "error"
    ).length;
    const skipped = results.filter(
      (result) => result.status === "skipped"
    ).length;

    return {
      collection: collection.name,
      filesProcessed: results.length,
      filesAdded: added,
      filesUpdated: updated,
      filesUnchanged: unchanged,
      filesErrored: errored,
      filesSkipped: skipped,
      filesMarkedInactive: markedInactive,
      durationMs: Date.now() - startedAt,
      files: results,
      errors,
    };
  }

  private async collectProjectionSourceIds(
    store: StorePort,
    documentId: number,
    sourceIds: Set<number>
  ): Promise<void> {
    sourceIds.add(documentId);
    const [linkBacklinks, edgeBacklinks] = await Promise.all([
      store.getBacklinksForDoc(documentId),
      store.getEdgeBacklinksForDoc(documentId),
    ]);
    if (linkBacklinks.ok) {
      for (const backlink of linkBacklinks.value) {
        sourceIds.add(backlink.sourceDocId);
      }
    }
    if (edgeBacklinks.ok) {
      for (const backlink of edgeBacklinks.value) {
        sourceIds.add(backlink.sourceDocId);
      }
    }
  }

  private async projectTypedEdges(
    store: StorePort,
    options: SyncOptions,
    sourceDocumentIds?: Set<number>
  ): Promise<Array<{ relPath: string; code: string; message: string }>> {
    const errors: Array<{ relPath: string; code: string; message: string }> =
      [];

    const selectedSourceIds = sourceDocumentIds
      ? [...sourceDocumentIds]
      : undefined;
    const backfillResult = await store.backfillDocEdges(selectedSourceIds);
    if (!backfillResult.ok) {
      return [
        {
          relPath: "(typed edge backfill)",
          code: backfillResult.error.code,
          message: backfillResult.error.message,
        },
      ];
    }

    const docsResult = await store.listDocuments();
    if (!docsResult.ok) {
      return [
        {
          relPath: "(typed edge projection)",
          code: docsResult.error.code,
          message: docsResult.error.message,
        },
      ];
    }

    const activeDocs = docsResult.value.filter((doc) => doc.active);
    const activeIds = new Set(activeDocs.map((doc) => doc.id));
    if (selectedSourceIds) {
      for (const documentId of selectedSourceIds) {
        if (!activeIds.has(documentId)) {
          await store.setDocEdges(documentId, [], "frontmatter-relation");
        }
      }
    }
    const projectedDocs = sourceDocumentIds
      ? activeDocs.filter((doc) => sourceDocumentIds.has(doc.id))
      : activeDocs;

    for (const [docIndex, doc] of projectedDocs.entries()) {
      if (docIndex > 0 && docIndex % PROJECTION_YIELD_INTERVAL === 0) {
        await Bun.sleep(0);
      }
      if (!doc.mirrorHash) {
        continue;
      }

      const contentResult = await store.getContent(doc.mirrorHash);
      if (!contentResult.ok || contentResult.value === null) {
        continue;
      }

      const relationsValue = parseFrontmatter(contentResult.value).metadata
        .relations;
      const relationEdges: DocEdgeInput[] = [];

      if (isRelationMap(relationsValue)) {
        for (const [rawEdgeType, targets] of Object.entries(relationsValue)) {
          const edgeType = normalizeRelationEdgeType(rawEdgeType);
          if (!RELATION_EDGE_TYPE_PATTERN.test(edgeType)) {
            continue;
          }
          for (const target of targets) {
            const targetDoc = resolveRelationTarget(activeDocs, doc, target);
            if (targetDoc) {
              relationEdges.push({
                targetDocId: targetDoc.id,
                edgeType,
                confidence: "manual",
              });
            }
          }
        }
      }
      const relationTargetIds = new Set(
        relationEdges.map((edge) => edge.targetDocId)
      );

      const relationsResult = await store.setDocEdges(
        doc.id,
        relationEdges,
        "frontmatter-relation"
      );
      if (!relationsResult.ok) {
        errors.push({
          relPath: doc.relPath,
          code: relationsResult.error.code,
          message: relationsResult.error.message,
        });
      }

      const primaryHint = getPrimaryGraphHint(
        doc.contentType,
        options.contentTypeRules ?? []
      );
      if (!primaryHint || !RELATION_EDGE_TYPE_PATTERN.test(primaryHint)) {
        continue;
      }

      const linksResult = await store.getLinksForDoc(doc.id);
      if (!linksResult.ok) {
        errors.push({
          relPath: doc.relPath,
          code: linksResult.error.code,
          message: linksResult.error.message,
        });
        continue;
      }

      const wikiEdges: DocEdgeInput[] = [];
      const markdownEdges: DocEdgeInput[] = [];
      for (const link of linksResult.value) {
        const targetRef =
          link.linkType === "markdown"
            ? `${doc.collection}/${link.targetRefNorm}`
            : link.targetCollection
              ? `${link.targetCollection}:${link.targetRef}`
              : link.targetRefNorm;
        const targetDoc = resolveRelationTarget(activeDocs, doc, targetRef);
        if (!targetDoc || relationTargetIds.has(targetDoc.id)) {
          continue;
        }
        const edge = {
          targetDocId: targetDoc.id,
          edgeType: primaryHint,
          confidence: "configured" as const,
        };
        if (link.linkType === "wiki") {
          wikiEdges.push(edge);
        } else {
          markdownEdges.push(edge);
        }
      }

      const wikiResult = await store.setDocEdges(doc.id, wikiEdges, "wikilink");
      if (!wikiResult.ok) {
        errors.push({
          relPath: doc.relPath,
          code: wikiResult.error.code,
          message: wikiResult.error.message,
        });
      }
      const markdownResult = await store.setDocEdges(
        doc.id,
        markdownEdges,
        "markdown-link"
      );
      if (!markdownResult.ok) {
        errors.push({
          relPath: doc.relPath,
          code: markdownResult.error.code,
          message: markdownResult.error.message,
        });
      }
    }

    return errors;
  }

  /** Run an exact global typed-edge reconciliation with cooperative yields. */
  reconcileTypedEdges(
    store: StorePort,
    options: SyncOptions = {}
  ): Promise<Array<{ relPath: string; code: string; message: string }>> {
    return this.projectTypedEdges(store, options);
  }

  /**
   * Sync a single collection.
   */
  // oxlint-disable-next-line max-lines-per-function -- sync orchestration with git and progress
  async syncCollection(
    collection: Collection,
    store: StorePort,
    options: SyncOptions = {}
  ): Promise<CollectionSyncResult> {
    const startTime = Date.now();
    const syncOptions: SyncOptions = {
      ...options,
      contentTypeRules: options.contentTypeRules ?? [],
      contentTypeRulesFingerprint:
        options.contentTypeRulesFingerprint ??
        fingerprintContentTypeMetadataRules(options.contentTypeRules ?? []),
    };
    const errors: Array<{ relPath: string; code: string; message: string }> =
      [];

    // 1. Run preflight commands
    if (options.runUpdateCmd !== false && collection.updateCmd) {
      enforceCollectionEgress({
        collections: [collection],
        action: "export",
        destinationZone: "remote",
        caller: { authenticated: true, operationAuthorized: true },
        contentClass: "source",
      });
      await runUpdateCmd(collection.path, collection.updateCmd);
    }

    if (options.gitPull && (await isGitRepo(collection.path))) {
      enforceCollectionEgress({
        collections: [collection],
        action: "export",
        destinationZone: "remote",
        caller: { authenticated: true, operationAuthorized: true },
        contentClass: "metadata",
      });
      await gitPull(collection.path);
    }

    // 2. Walk collection
    const maxBytes = options.limits?.maxBytes ?? DEFAULT_LIMITS.maxBytes;
    const walkConfig = collectionToWalkConfig(collection, maxBytes);
    const { entries, skipped } = await this.walker.walk(walkConfig);

    // Track seen paths for marking inactive
    // Only include TOO_LARGE files (they exist but are unprocessable)
    // EXCLUDED files should NOT be in seenPaths - if config changes to exclude
    // a previously-included file, that doc SHOULD be marked inactive
    const seenPaths = new Set<string>();
    for (const skip of skipped) {
      if (skip.reason === "TOO_LARGE") {
        seenPaths.add(skip.relPath);
      }
    }

    // 3. Record TOO_LARGE errors and track in seenPaths
    for (const skip of skipped) {
      if (skip.reason === "TOO_LARGE") {
        const recordResult = await store.recordError({
          collection: collection.name,
          relPath: skip.relPath,
          code: "TOO_LARGE",
          message: `File size ${skip.size} exceeds limit ${maxBytes}`,
        });
        // Log failure but continue
        if (!recordResult.ok) {
          errors.push({
            relPath: skip.relPath,
            code: "STORE_ERROR",
            message: `Failed to record error: ${recordResult.error.message}`,
          });
        }
        errors.push({
          relPath: skip.relPath,
          code: "TOO_LARGE",
          message: `File size ${skip.size} exceeds limit ${maxBytes}`,
        });
      }
    }

    // 4. Process files with bounded concurrency
    const concurrency = Math.max(
      1,
      Math.min(MAX_CONCURRENCY, options.concurrency ?? DEFAULT_CONCURRENCY)
    );

    let added = 0;
    let updated = 0;
    let unchanged = 0;
    let errored = 0;
    let dynamicSkipped = 0;
    const fileResults: FileSyncResult[] = [];

    if (concurrency === 1) {
      // Sequential processing with batched transactions (Windows perf)
      for (let i = 0; i < entries.length; i += TX_BATCH_SIZE) {
        const batch = entries.slice(i, i + TX_BATCH_SIZE);

        const runBatch = async (): Promise<void> => {
          for (const entry of batch) {
            seenPaths.add(entry.relPath);
            const result = await this.processFile(
              collection,
              entry,
              store,
              syncOptions
            );
            fileResults.push(result);
            switch (result.status) {
              case "added":
                added += 1;
                break;
              case "updated":
                updated += 1;
                break;
              case "unchanged":
                unchanged += 1;
                break;
              case "error":
                errored += 1;
                if (result.errorCode && result.errorMessage) {
                  errors.push({
                    relPath: result.relPath,
                    code: result.errorCode,
                    message: result.errorMessage,
                  });
                }
                break;
              case "skipped":
                dynamicSkipped += 1;
                if (result.errorCode && result.errorMessage) {
                  errors.push({
                    relPath: result.relPath,
                    code: result.errorCode,
                    message: result.errorMessage,
                  });
                }
                break;
            }
          }
        };

        // Wrap batch in single transaction when supported (reduces commits)
        if (store.withTransaction) {
          const txResult = await store.withTransaction(runBatch);
          if (!txResult.ok) {
            errors.push({
              relPath: "(transaction batch)",
              code: txResult.error.code,
              message: txResult.error.message,
            });
            break; // Abort on transaction failure
          }
        } else {
          await runBatch();
        }
      }
    } else {
      // Concurrent processing with semaphore
      const semaphore = new Semaphore(concurrency);
      const results: FileSyncResult[] = [];

      await Promise.all(
        entries.map(async (entry) => {
          seenPaths.add(entry.relPath);
          await semaphore.acquire();
          try {
            const result = await this.processFile(
              collection,
              entry,
              store,
              syncOptions
            );
            fileResults.push(result);
            results.push(result);
          } finally {
            semaphore.release();
          }
        })
      );

      // Aggregate results
      for (const result of results) {
        switch (result.status) {
          case "added":
            added += 1;
            break;
          case "updated":
            updated += 1;
            break;
          case "unchanged":
            unchanged += 1;
            break;
          case "error":
            errored += 1;
            if (result.errorCode && result.errorMessage) {
              errors.push({
                relPath: result.relPath,
                code: result.errorCode,
                message: result.errorMessage,
              });
            }
            break;
          case "skipped":
            dynamicSkipped += 1;
            if (result.errorCode && result.errorMessage) {
              errors.push({
                relPath: result.relPath,
                code: result.errorCode,
                message: result.errorMessage,
              });
            }
            break;
        }
      }
    }

    // 5. Mark missing files as inactive
    let markedInactive = 0;
    const existingDocsResult = await store.listDocuments(collection.name);
    if (existingDocsResult.ok) {
      const missingPaths = existingDocsResult.value
        .filter(
          (document) =>
            document.active &&
            !seenPaths.has(document.recordSourcePath ?? document.relPath)
        )
        .map((d) => d.relPath);

      if (missingPaths.length > 0) {
        const markResult = await store.markInactive(
          collection.name,
          missingPaths
        );
        if (markResult.ok) {
          markedInactive = markResult.value;
        }
      }
    }

    if (syncOptions.projectTypedEdges !== false) {
      errors.push(...(await this.projectTypedEdges(store, syncOptions)));
    }

    return {
      collection: collection.name,
      filesProcessed: entries.length,
      filesAdded: added,
      filesUpdated: updated,
      filesUnchanged: unchanged,
      filesErrored: errored,
      filesSkipped: skipped.length + dynamicSkipped,
      filesMarkedInactive: markedInactive,
      durationMs: Date.now() - startTime,
      files: fileResults,
      errors,
    };
  }

  /**
   * Sync all collections.
   */
  async syncAll(
    collections: Collection[],
    store: StorePort,
    options: SyncOptions = {}
  ): Promise<SyncResult> {
    const startTime = Date.now();
    const results: CollectionSyncResult[] = [];
    const deferredProjectionOptions: SyncOptions = {
      ...options,
      projectTypedEdges: false,
    };

    for (const collection of collections) {
      const result = await this.syncCollection(
        collection,
        store,
        deferredProjectionOptions
      );
      results.push(result);
    }

    if (results.length > 0) {
      const projectionErrors = await this.projectTypedEdges(store, options);
      results.at(-1)?.errors.push(...projectionErrors);
    }

    // Aggregate totals
    const totals = results.reduce(
      (acc, r) => ({
        processed: acc.processed + r.filesProcessed,
        added: acc.added + r.filesAdded,
        updated: acc.updated + r.filesUpdated,
        errored: acc.errored + r.filesErrored,
        skipped: acc.skipped + r.filesSkipped,
      }),
      { processed: 0, added: 0, updated: 0, errored: 0, skipped: 0 }
    );

    return {
      collections: results,
      totalDurationMs: Date.now() - startTime,
      totalFilesProcessed: totals.processed,
      totalFilesAdded: totals.added,
      totalFilesUpdated: totals.updated,
      totalFilesErrored: totals.errored,
      totalFilesSkipped: totals.skipped,
    };
  }
}

/**
 * Default sync service instance.
 */
export const defaultSyncService = new SyncService();
