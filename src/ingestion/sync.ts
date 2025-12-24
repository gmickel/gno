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

/**
 * Decide whether to process a file or skip it.
 * Handles repair cases where sourceHash matches but content is incomplete.
 */
function decideAction(
  existing: DocumentRow | null,
  sourceHash: string,
  _store: StorePort
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
 * Check if path is a git repository.
 */
async function isGitRepo(path: string): Promise<boolean> {
  const gitDir = Bun.file(`${path}/.git`);
  return await gitDir.exists();
}

/**
 * Run git pull in directory (best effort).
 */
async function gitPull(path: string): Promise<void> {
  try {
    await Bun.$`git -C ${path} pull`.quiet();
  } catch {
    // Ignore git pull failures
  }
}

/**
 * Run collection update command (best effort).
 */
async function runUpdateCmd(path: string, cmd: string): Promise<void> {
  try {
    await Bun.$`sh -c ${cmd}`.cwd(path).quiet();
  } catch {
    // Ignore update command failures
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
   */
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
      const decision = decideAction(existing, sourceHash, store);

      if (decision.kind === 'skip') {
        return { relPath: entry.relPath, status: 'unchanged' };
      }

      // 4. Detect MIME
      const mime = this.mimeDetector.detect(
        entry.absPath,
        new Uint8Array(bytes)
      );

      // 5. Convert via pipeline
      const convertResult = await this.pipeline.convert({
        sourcePath: entry.absPath,
        relativePath: entry.relPath,
        collection: collection.name,
        bytes: new Uint8Array(bytes),
        mime: mime.mime,
        ext: mime.ext,
        limits,
      });

      if (!convertResult.ok) {
        // Record error
        const errorInput: IngestErrorInput = {
          collection: collection.name,
          relPath: entry.relPath,
          code: convertResult.error.code,
          message: convertResult.error.message,
          details: convertResult.error.details,
        };
        await store.recordError(errorInput);

        // Upsert document with error info (no mirrorHash)
        await store.upsertDocument({
          collection: collection.name,
          relPath: entry.relPath,
          sourceHash,
          sourceMime: mime.mime,
          sourceExt: mime.ext,
          sourceSize: entry.size,
          sourceMtime: entry.mtime,
          lastErrorCode: convertResult.error.code,
          lastErrorMessage: convertResult.error.message,
          // mirrorHash intentionally omitted (null)
        });

        return {
          relPath: entry.relPath,
          status: 'error',
          errorCode: convertResult.error.code,
          errorMessage: convertResult.error.message,
        };
      }

      const artifact = convertResult.value;

      // 6. Upsert document
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
      });

      if (!docidResult.ok) {
        return {
          relPath: entry.relPath,
          status: 'error',
          errorCode: 'STORE_ERROR',
          errorMessage: docidResult.error.message,
        };
      }

      // 7. Upsert content (content-addressed dedupe)
      await store.upsertContent(artifact.mirrorHash, artifact.markdown);

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

      // 10. Upsert chunks
      await store.upsertChunks(artifact.mirrorHash, chunkInputs);

      // 11. Rebuild FTS for this hash
      await store.rebuildFtsForHash(artifact.mirrorHash);

      const status = existing ? 'updated' : 'added';
      return {
        relPath: entry.relPath,
        status,
        docid: docidResult.value,
        mirrorHash: artifact.mirrorHash,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        relPath: entry.relPath,
        status: 'error',
        errorCode: 'INTERNAL',
        errorMessage: message,
      };
    }
  }

  /**
   * Sync a single collection.
   */
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
    const seenPaths = new Set<string>();

    // 3. Record TOO_LARGE errors
    for (const skip of skipped) {
      if (skip.reason === 'TOO_LARGE') {
        await store.recordError({
          collection: collection.name,
          relPath: skip.relPath,
          code: 'TOO_LARGE',
          message: `File size ${skip.size} exceeds limit ${maxBytes}`,
        });
        errors.push({
          relPath: skip.relPath,
          code: 'TOO_LARGE',
          message: `File size ${skip.size} exceeds limit ${maxBytes}`,
        });
      }
    }

    // 4. Process each file
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    let errored = 0;

    for (const entry of entries) {
      seenPaths.add(entry.relPath);

      const result = await this.processFile(collection, entry, store, options);

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
          // Exhaustive check - should never reach here
          break;
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
