/**
 * Sync service - orchestrates file ingestion.
 * Walks collections, converts files, chunks content, updates store.
 *
 * @module src/ingestion/sync
 */

// node:fs/promises for stat (no Bun equivalent for file stats)
import { stat } from "node:fs/promises";
// node:path for join (no Bun path utils)
import { join } from "node:path";

import type { NormalizedContentTypeRule } from "../config";
import type { Collection } from "../config/types";
import type {
  ChunkInput,
  DocEdgeInput,
  DocLinkInput,
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

import { fingerprintContentTypeRules } from "../config";
import { getDefaultMimeDetector, type MimeDetector } from "../converters/mime";
import {
  type ConversionPipeline,
  getDefaultPipeline,
} from "../converters/pipeline";
import { DEFAULT_LIMITS } from "../converters/types";
import {
  diffDocumentStructure,
  extractDocumentStructure,
  isRelationMap,
  normalizeRelationEdgeType,
  normalizeRelationTarget,
} from "../core/change-diff";
import {
  normalizeMarkdownPath,
  normalizeWikiName,
  parseLinks,
  parseTargetParts,
} from "../core/links";
import { normalizeTag, validateTag } from "../core/tags";
import { defaultChunker } from "./chunker";
import {
  extractHashtags,
  parseFrontmatter,
  stripFrontmatter,
} from "./frontmatter";
import { buildLineOffsets } from "./position";
import { getExcludedRanges } from "./strip";
import { collectionToWalkConfig, DEFAULT_CHUNK_PARAMS } from "./types";
import { defaultWalker } from "./walker";

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
const EMPTY_CONTENT_TYPE_RULES_FINGERPRINT = fingerprintContentTypeRules([]);
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

function matchPrefixContentType(
  relPath: string,
  rules: NormalizedContentTypeRule[]
): string | undefined {
  for (const rule of rules) {
    if (rule.prefixes.some((prefix) => relPath.startsWith(prefix))) {
      return rule.id;
    }
  }
  return undefined;
}

export function extractDocumentMetadata(
  markdown: string,
  relPath: string,
  ext: string,
  contentTypeRules: NormalizedContentTypeRule[] = []
): DocumentMetadata {
  const parsed = parseFrontmatter(markdown);
  const metadata = parsed.metadata;
  const typedRules = new Map(contentTypeRules.map((rule) => [rule.id, rule]));
  const rawFrontmatterType =
    typeof metadata.type === "string"
      ? normalizeFrontmatterScalar(metadata.type)
      : "";
  const frontmatterType = typedRules.get(rawFrontmatterType)?.id;
  const prefixType =
    frontmatterType === undefined
      ? matchPrefixContentType(relPath, contentTypeRules)
      : undefined;
  const inferred = inferPathContentType(relPath, ext);
  const contentType = frontmatterType ?? prefixType ?? inferred.contentType;
  const contentTypeSource: ContentTypeSource = frontmatterType
    ? "frontmatter-type"
    : prefixType
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

      // 2. Read file bytes
      const bytes = await Bun.file(entry.absPath).bytes();

      // 3. Compute sourceHash
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(bytes);
      const sourceHash = hasher.digest("hex");
      const contentTypeRules = options.contentTypeRules ?? [];
      const contentTypeRulesFingerprint =
        options.contentTypeRulesFingerprint ??
        fingerprintContentTypeRules(contentTypeRules);

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
        return { relPath: entry.relPath, status: "unchanged" };
      }

      // 5. Detect MIME (bytes is already Uint8Array from Bun.file().bytes())
      const mime = this.mimeDetector.detect(entry.absPath, bytes);

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

        // Upsert document with error info, explicitly clear mirrorHash
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
          changeJournal: false,
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

        const status = existing ? "updated" : "added";
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
        if (existingResult.ok && existingResult.value) {
          await store.upsertDocument({
            collection: collection.name,
            relPath: entry.relPath,
            sourceHash: existingResult.value.sourceHash,
            sourceMime: existingResult.value.sourceMime,
            sourceExt: existingResult.value.sourceExt,
            sourceSize: existingResult.value.sourceSize,
            sourceMtime: existingResult.value.sourceMtime,
            sourceCtime:
              existingResult.value.sourceCtime ??
              existingResult.value.sourceMtime,
            lastErrorCode: code,
            lastErrorMessage: message,
            changeJournal: false,
          });
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
        fingerprintContentTypeRules(options.contentTypeRules ?? []),
    };
    const results: FileSyncResult[] = [];
    const projectionSourceIds = new Set<number>();
    let markedInactive = 0;

    for (const relPath of relPaths) {
      const existingResult = await store.getDocument(collection.name, relPath);
      const existingDoc = existingResult.ok ? existingResult.value : null;
      if (existingDoc) {
        await this.collectProjectionSourceIds(
          store,
          existingDoc.id,
          projectionSourceIds
        );
      }

      const absPath = join(collection.path, relPath);
      let stats: Awaited<ReturnType<typeof stat>>;
      try {
        stats = await stat(absPath);
      } catch (error) {
        const errorCode =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : undefined;
        if (errorCode !== "ENOENT") {
          results.push({
            relPath,
            status: "error",
            errorCode: "STAT_FAILED",
            errorMessage:
              error instanceof Error ? error.message : "Failed to stat file",
          });
          continue;
        }
        if (existingDoc?.active) {
          const inactiveResult = await store.markInactive(collection.name, [
            relPath,
          ]);
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
            docid: existingDoc.docid,
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

      if (!stats.isFile()) {
        results.push({
          relPath,
          status: "error",
          errorCode: "NOT_FILE",
          errorMessage: "Path is not a file",
        });
        continue;
      }

      const entry: WalkEntry = {
        absPath,
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
        fingerprintContentTypeRules(options.contentTypeRules ?? []),
    };
    const errors: Array<{ relPath: string; code: string; message: string }> =
      [];

    // 1. Run preflight commands
    if (options.runUpdateCmd !== false && collection.updateCmd) {
      await runUpdateCmd(collection.path, collection.updateCmd);
    }

    if (options.gitPull && (await isGitRepo(collection.path))) {
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
        .filter((d) => d.active && !seenPaths.has(d.relPath))
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
