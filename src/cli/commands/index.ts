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
  formatIndex,
  type IndexOptions,
  type IndexResult,
  index,
} from './index-cmd';
export { type InitOptions, type InitResult, init } from './init';
export * from './models';
export {
  formatQuery,
  type QueryCommandOptions,
  type QueryResult,
  query,
} from './query';
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
