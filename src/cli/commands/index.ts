/**
 * CLI commands public API.
 *
 * @module src/cli/commands
 */

export {
  type AskCommandOptions,
  type AskCommandResult,
  ask,
  formatAsk,
} from './ask';
export {
  type CleanupOptions,
  type CleanupResult,
  cleanup,
  formatCleanup,
} from './cleanup';
export {
  type DoctorCheck,
  type DoctorCheckStatus,
  type DoctorOptions,
  type DoctorResult,
  doctor,
  formatDoctor,
} from './doctor';
export {
  type EmbedOptions,
  type EmbedResult,
  embed,
  formatEmbed,
} from './embed';
export {
  formatGet,
  type GetCommandOptions,
  type GetResponse,
  type GetResult,
  get,
} from './get';
export {
  formatIndex,
  type IndexOptions,
  type IndexResult,
  index,
} from './index-cmd';
export { type InitOptions, type InitResult, init } from './init';
export {
  formatLs,
  type LsCommandOptions,
  type LsDocument,
  type LsResponse,
  type LsResult,
  ls,
} from './ls';
export * from './models';
export {
  formatMultiGet,
  type MultiGetCommandOptions,
  type MultiGetDocument,
  type MultiGetResponse,
  type MultiGetResult,
  multiGet,
  type SkippedDoc,
} from './multi-get';
export {
  formatQuery,
  type QueryCommandOptions,
  type QueryResult,
  query,
} from './query';
export {
  isGlobPattern,
  type ParsedRef,
  type ParseRefResult,
  parseRef,
  type RefType,
  splitRefs,
} from './ref-parser';
export {
  formatSearch,
  type SearchCommandOptions,
  type SearchResult,
  search,
} from './search';
export {
  formatStatus,
  type StatusOptions,
  type StatusResult,
  status,
} from './status';
export {
  formatUpdate,
  type UpdateOptions,
  type UpdateResult,
  update,
} from './update';
export {
  formatVsearch,
  type VsearchCommandOptions,
  type VsearchResult,
  vsearch,
} from './vsearch';
