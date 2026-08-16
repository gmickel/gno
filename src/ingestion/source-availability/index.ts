/**
 * Source-availability policy and guarded content-read boundary.
 *
 * @module src/ingestion/source-availability
 */

export {
  classifyGuardedReadErrno,
  DARWIN_EACCES,
  DARWIN_EDEADLK,
  DARWIN_ENOENT,
  DARWIN_EPERM,
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
} from "./darwin-io";
export { classifyDarwinFileProviderPath } from "./darwin-path";
export type { DarwinFileProviderPathSupport } from "./darwin-path";
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
  SOURCE_AVAILABILITY_CODES,
  SOURCE_AVAILABILITY_MODES,
  SOURCE_AVAILABILITY_SKIP_CODES,
  sourceAvailabilityMessage,
} from "./types";
export type {
  SourceAvailabilityCode,
  SourceAvailabilityMode,
  SourceContentReaderPort,
  SourceReadFailure,
  SourceReadResult,
  SourceReadSuccess,
} from "./types";
