/**
 * CLI commands public API.
 *
 * @module src/cli/commands
 */

export {
  type CleanupOptions,
  type CleanupResult,
  cleanup,
  formatCleanup,
} from './cleanup';
export {
  formatIndex,
  type IndexOptions,
  type IndexResult,
  index,
} from './index-cmd';
export { type InitOptions, type InitResult, init } from './init';
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
