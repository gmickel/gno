/**
 * Budget-stop conversion error codes.
 * Extracted from src/ingestion/file-processor so read-only CLI modules do not
 * pull in the worker/markdown-parsing graph just to check error codes.
 *
 * @module src/ingestion/budget-error-codes
 */

/** Error codes of a file stopped at its budget. */
export const BUDGET_ERROR_CODES: ReadonlySet<string> = new Set([
  "TIMEOUT",
  "MEMORY_LIMIT",
]);
