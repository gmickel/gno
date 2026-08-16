/**
 * Source-availability policy and guarded content-read boundary.
 *
 * @module src/ingestion/source-availability
 */

export {
  DARWIN_EACCES,
  DARWIN_EDEADLK,
  DARWIN_ENOENT,
  DARWIN_ELOOP,
  DARWIN_EPERM,
  DARWIN_STAT_BUF_SIZE,
  DARWIN_ST_FLAGS_OFFSET,
  classifyGuardedReadErrno,
  IOPOL_MATERIALIZE_DATALESS_FILES_OFF,
  IOPOL_SCOPE_PROCESS,
  IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES,
  loadDarwinIo,
  resetDarwinIoCachesForTests,
  SF_DATALESS,
  withNoMaterializePolicy,
} from "./darwin-io";
export type {
  DarwinFileIoPort,
  DarwinIoBundle,
  DarwinIoPolicyPort,
  DarwinStatPort,
} from "./darwin-io";
export { classifyDarwinFileProviderPath } from "./darwin-path";
export type { DarwinFileProviderPathSupport } from "./darwin-path";
export {
  AnyDirectoryAvailability,
  createDirectoryAvailability,
  findUnprovenAvailabilityPrefix,
  isUnprovenDirectoryResult,
  LocalDirectoryAvailability,
  memoizeDirectoryAvailability,
  parentRelDir,
  posixRelUnderRoot,
  relPathUnderAnyPrefix,
  relPathUnderPrefix,
} from "./directory";
export type { LocalDirectoryDeps } from "./directory";
export {
  AnySourceContentReader,
  bytesAsAsyncIterable,
  createSourceContentReader,
  LocalSourceContentReader,
} from "./readers";
export type { LocalReaderDeps } from "./readers";
export { resolveSourceAvailability } from "./resolve";
export {
  DEFAULT_SOURCE_AVAILABILITY,
  isSourceAvailabilitySkip,
  isUnprovenAbsenceCode,
  SOURCE_AVAILABILITY_CODES,
  SOURCE_AVAILABILITY_MODES,
  SOURCE_AVAILABILITY_SKIP_CODES,
  SOURCE_AVAILABILITY_UNPROVEN_PREFIX_CODES,
  sourceAvailabilityMessage,
} from "./types";
export type {
  DirectoryAvailabilityPort,
  DirectoryAvailabilityResult,
  DirectoryReadResult,
  SourceAvailabilityCode,
  SourceAvailabilityMode,
  SourceContentReaderPort,
  SourceReadFailure,
  SourceReadResult,
  SourceReadSuccess,
  SynchronousDirectoryRead,
} from "./types";
