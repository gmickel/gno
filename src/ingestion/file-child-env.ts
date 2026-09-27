/**
 * Environment flag that makes a compiled GNO executable serve as the file
 * processor child instead of the CLI (fn-198). Kept in its own module so the
 * CLI entry can check it without loading the ingestion stack.
 *
 * @module src/ingestion/file-child-env
 */

export const FILE_PROCESSOR_CHILD_ENV = "GNO_INTERNAL_FILE_PROCESSOR_CHILD";
