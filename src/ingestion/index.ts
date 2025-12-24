/**
 * Ingestion subsystem - public exports.
 *
 * @module src/ingestion
 */

// Chunker
export { defaultChunker, MarkdownChunker } from './chunker';
// Language detection
export { defaultLanguageDetector, SimpleLanguageDetector } from './language';
// Sync service
export { defaultSyncService, SyncService } from './sync';
// Types
export type {
  ChunkerPort,
  ChunkOutput,
  ChunkParams,
  CollectionSyncResult,
  FileSyncResult,
  FileSyncStatus,
  LanguageDetectorPort,
  ProcessDecision,
  SkippedEntry,
  SyncOptions,
  SyncResult,
  WalkConfig,
  WalkEntry,
  WalkerPort,
} from './types';
export { collectionToWalkConfig, DEFAULT_CHUNK_PARAMS } from './types';
// Walker
export { defaultWalker, FileWalker } from './walker';
