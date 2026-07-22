/**
 * Store layer exports.
 * Provides StorePort interface and SQLite implementation.
 *
 * @module src/store
 */

export type { Migration } from "./migrations";
// Migrations
export {
  getDbFtsTokenizer,
  getSchemaVersion,
  migrations,
  needsFtsRebuild,
  runMigrations,
} from "./migrations";

// SQLite adapter
export { SqliteAdapter } from "./sqlite";
// Types and interfaces
export type {
  ActivationIndexDocument,
  ActivationIndexIdentity,
  ActivationIndexSnapshot,
  ActivationStageName,
  ActivationStageReceipt,
  ActivationStageStatus,
  ActivationVerificationCode,
  ActivationVerificationReceipt,
  ChunkInput,
  ChunkRow,
  CleanupStats,
  CollectionRow,
  CollectionStatus,
  ContextRow,
  DocumentInput,
  DocumentRow,
  FtsResult,
  FtsSearchOptions,
  IndexStatus,
  IngestErrorInput,
  IngestErrorRow,
  MigrationResult,
  StoreError,
  StoreErrorCode,
  StorePort,
  StoreResult,
} from "./types";
export { err, ok } from "./types";
