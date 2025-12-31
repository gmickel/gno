/**
 * Sync service - orchestrates file ingestion.
 * Walks collections, converts files, chunks content, updates store.
 *
 * @module src/ingestion/sync
 */

import type { Collection } from '../config/types';
import { getDefaultMimeDetector, type MimeDetector } from '../converters/mime';
import {
  type ConversionPipeline,
  getDefaultPipeline,
} from '../converters/pipeline';
import { DEFAULT_LIMITS } from '../converters/types';
import type {
  ChunkInput,
  DocumentRow,
  IngestErrorInput,
  StorePort,
  StoreResult,
} from '../store/types';
import { defaultChunker } from './chunker';
import type {
  ChunkerPort,
  CollectionSyncResult,
  FileSyncResult,
  ProcessDecision,
  SyncOptions,
  SyncResult,
  WalkEntry,
  WalkerPort,
} from './types';
import { collectionToWalkConfig, DEFAULT_CHUNK_PARAMS } from './types';
import { defaultWalker } from './walker';

/** Default concurrency for file processing */
const DEFAULT_CONCURRENCY = 1;

/** Batch size for grouping writes into single transaction (Windows perf) */
const TX_BATCH_SIZE = 50;

/** Max concurrency to prevent resource exhaustion */
const MAX_CONCURRENCY = 16;

/**
 * Decide whether to process a file or skip it.
 * Handles repair cases where sourceHash matches but content is incomplete.
 */
function decideAction(
  existing: DocumentRow | null,
  sourceHash: string
): ProcessDecision {
  // No existing doc - must process
  if (!existing) {
    return { kind: 'process', reason: 'new file' };
  }

  // Source hash changed - must process
  if (existing.sourceHash !== sourceHash) {
    return { kind: 'process', reason: 'content changed' };
  }

  // Source unchanged, but check for repair cases:

  // 1. Previous conversion failed (mirrorHash is null)
  if (!existing.mirrorHash) {
    return { kind: 'repair', reason: 'previous conversion failed' };
  }

  // 2. Document has error recorded
  if (existing.lastErrorCode) {
    return { kind: 'repair', reason: 'previous error recorded' };
  }

  // All good - skip
  return { kind: 'skip', reason: 'unchanged' };
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
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: file processing with multiple extraction and embedding paths
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
      // 1. Read file bytes
      const bytes = await Bun.file(entry.absPath).bytes();

      // 2. Compute sourceHash
      const hasher = new Bun.CryptoHasher('sha256');
      hasher.update(bytes);
      const sourceHash = hasher.digest('hex');

      // 3. Check existing doc for skip/repair decision
      const existingResult = await store.getDocument(
        collection.name,
        entry.relPath
      );
      const existing = existingResult.ok ? existingResult.value : null;
      const decision = decideAction(existing, sourceHash);

      if (decision.kind === 'skip') {
        return { relPath: entry.relPath, status: 'unchanged' };
      }

      // 4. Detect MIME (bytes is already Uint8Array from Bun.file().bytes())
      const mime = this.mimeDetector.detect(entry.absPath, bytes);

      // 5. Convert via pipeline
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
          sourceSize: entry.size,
          sourceMtime: entry.mtime,
          lastErrorCode: convertResult.error.code,
          lastErrorMessage: convertResult.error.message,
          // mirrorHash intentionally omitted (will be null)
        });

        if (!upsertResult.ok) {
          return {
            relPath: entry.relPath,
            status: 'error',
            errorCode: 'STORE_ERROR',
            errorMessage: upsertResult.error.message,
          };
        }

        return {
          relPath: entry.relPath,
          status: 'error',
          errorCode: convertResult.error.code,
          errorMessage: convertResult.error.message,
        };
      }

      const artifact = convertResult.value;

      // 6. Upsert document - EXPLICITLY clear error fields on success
      const docidResult = await store.upsertDocument({
        collection: collection.name,
        relPath: entry.relPath,
        sourceHash,
        sourceMime: mime.mime,
        sourceExt: mime.ext,
        sourceSize: entry.size,
        sourceMtime: entry.mtime,
        title: artifact.title,
        mirrorHash: artifact.mirrorHash,
        converterId: artifact.meta.converterId,
        converterVersion: artifact.meta.converterVersion,
        languageHint: artifact.languageHint ?? collection.languageHint,
        // Clear error fields on success (requires store to handle undefined → null)
        lastErrorCode: undefined,
        lastErrorMessage: undefined,
      });

      const docid = mustOk(docidResult, 'upsertDocument', {
        collection: collection.name,
        relPath: entry.relPath,
      });

      // 7. Upsert content (content-addressed dedupe) - CHECKED
      const contentResult = await store.upsertContent(
        artifact.mirrorHash,
        artifact.markdown
      );
      mustOk(contentResult, 'upsertContent', {
        mirrorHash: artifact.mirrorHash,
      });

      // 8. Chunk content
      const chunks = this.chunker.chunk(
        artifact.markdown,
        DEFAULT_CHUNK_PARAMS,
        artifact.languageHint ?? collection.languageHint
      );

      // 9. Convert to ChunkInput for store
      const chunkInputs: ChunkInput[] = chunks.map((c) => ({
        seq: c.seq,
        pos: c.pos,
        text: c.text,
        startLine: c.startLine,
        endLine: c.endLine,
        language: c.language ?? undefined,
        tokenCount: c.tokenCount ?? undefined,
      }));

      // 10. Upsert chunks - CHECKED
      const chunksResult = await store.upsertChunks(
        artifact.mirrorHash,
        chunkInputs
      );
      mustOk(chunksResult, 'upsertChunks', {
        mirrorHash: artifact.mirrorHash,
        chunkCount: chunkInputs.length,
      });

      // 11. Rebuild FTS for this hash - CHECKED
      const ftsResult = await store.rebuildFtsForHash(artifact.mirrorHash);
      mustOk(ftsResult, 'rebuildFtsForHash', {
        mirrorHash: artifact.mirrorHash,
      });

      const status = existing ? 'updated' : 'added';
      return {
        relPath: entry.relPath,
        status,
        docid,
        mirrorHash: artifact.mirrorHash,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      // Distinguish store errors from other internal errors
      const isStoreError =
        message.startsWith('Store operation failed:') ||
        (error instanceof Error &&
          (error as Error & { context?: unknown }).context !== undefined);
      const code = isStoreError ? 'STORE_ERROR' : 'INTERNAL';

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
            lastErrorCode: code,
            lastErrorMessage: message,
          });
        }
      } catch {
        // Best-effort error recording
      }

      return {
        relPath: entry.relPath,
        status: 'error',
        errorCode: code,
        errorMessage: message,
      };
    }
  }

  /**
   * Sync a single collection.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: sync orchestration with git integration and progress tracking
  async syncCollection(
    collection: Collection,
    store: StorePort,
    options: SyncOptions = {}
  ): Promise<CollectionSyncResult> {
    const startTime = Date.now();
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
      if (skip.reason === 'TOO_LARGE') {
        seenPaths.add(skip.relPath);
      }
    }

    // 3. Record TOO_LARGE errors and track in seenPaths
    for (const skip of skipped) {
      if (skip.reason === 'TOO_LARGE') {
        const recordResult = await store.recordError({
          collection: collection.name,
          relPath: skip.relPath,
          code: 'TOO_LARGE',
          message: `File size ${skip.size} exceeds limit ${maxBytes}`,
        });
        // Log failure but continue
        if (!recordResult.ok) {
          errors.push({
            relPath: skip.relPath,
            code: 'STORE_ERROR',
            message: `Failed to record error: ${recordResult.error.message}`,
          });
        }
        errors.push({
          relPath: skip.relPath,
          code: 'TOO_LARGE',
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
              options
            );
            switch (result.status) {
              case 'added':
                added += 1;
                break;
              case 'updated':
                updated += 1;
                break;
              case 'unchanged':
                unchanged += 1;
                break;
              case 'error':
                errored += 1;
                if (result.errorCode && result.errorMessage) {
                  errors.push({
                    relPath: result.relPath,
                    code: result.errorCode,
                    message: result.errorMessage,
                  });
                }
                break;
              default:
                // 'skipped' status - already counted in filesSkipped
                break;
            }
          }
        };

        // Wrap batch in single transaction when supported (reduces commits)
        if (store.withTransaction) {
          const txResult = await store.withTransaction(runBatch);
          if (!txResult.ok) {
            errors.push({
              relPath: '(transaction batch)',
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
              options
            );
            results.push(result);
          } finally {
            semaphore.release();
          }
        })
      );

      // Aggregate results
      for (const result of results) {
        switch (result.status) {
          case 'added':
            added += 1;
            break;
          case 'updated':
            updated += 1;
            break;
          case 'unchanged':
            unchanged += 1;
            break;
          case 'error':
            errored += 1;
            if (result.errorCode && result.errorMessage) {
              errors.push({
                relPath: result.relPath,
                code: result.errorCode,
                message: result.errorMessage,
              });
            }
            break;
          default:
            // 'skipped' status - already counted in filesSkipped
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

    return {
      collection: collection.name,
      filesProcessed: entries.length,
      filesAdded: added,
      filesUpdated: updated,
      filesUnchanged: unchanged,
      filesErrored: errored,
      filesSkipped: skipped.length,
      filesMarkedInactive: markedInactive,
      durationMs: Date.now() - startTime,
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

    for (const collection of collections) {
      const result = await this.syncCollection(collection, store, options);
      results.push(result);
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
