/**
 * Ingestion subsystem - public exports.
 *
 * @module src/ingestion
 */

// Chunker
export { defaultChunker, MarkdownChunker } from "./chunker";
// Language detection
export { defaultLanguageDetector, SimpleLanguageDetector } from "./language";
// Sync service
export { defaultSyncService, SyncService } from "./sync";
export { resolveContentTypeRules, withContentTypeRules } from "./sync-options";
// Source availability (content-boundary guard)
export {
  createDirectoryAvailability,
  createSourceContentReader,
  DEFAULT_SOURCE_AVAILABILITY,
  findUnprovenAvailabilityPrefix,
  isSourceAvailabilitySkip,
  isUnprovenAbsenceCode,
  memoizeDirectoryAvailability,
  relPathUnderAnyPrefix,
  resolveSourceAvailability,
  SOURCE_AVAILABILITY_MODES,
} from "./source-availability";
export type {
  DirectoryAvailabilityPort,
  DirectoryAvailabilityResult,
  SourceAvailabilityCode,
  SourceAvailabilityMode,
  SourceContentReaderPort,
  SourceReadResult,
} from "./source-availability";
// Types
export type {
  ChunkerPort,
  ChunkOutput,
  ChunkParams,
  CollectionSyncResult,
  ContentTypeSource,
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
} from "./types";
export { collectionToWalkConfig, DEFAULT_CHUNK_PARAMS } from "./types";
// Walker
export { defaultWalker, FileWalker, matchesWalkPath } from "./walker";
