/**
 * Environment flag a compiled executable sets when it re-runs itself as the
 * session import child. Dependency-free so the CLI entry can check it
 * without loading the sessions service.
 *
 * @module src/sessions/import-child-env
 */
export const IMPORT_CHILD_ENV = "GNO_INTERNAL_SESSION_IMPORT_CHILD";
