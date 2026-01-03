/**
 * Migration registry.
 * Exports all migrations in order.
 *
 * @module src/store/migrations
 */

export type { Migration } from "./runner";
export {
  getDbFtsTokenizer,
  getSchemaVersion,
  needsFtsRebuild,
  runMigrations,
} from "./runner";

// Import all migrations
import { migration as m001 } from "./001-initial";
import { migration as m002 } from "./002-documents-fts";
import { migration as m003 } from "./003-doc-tags";

/** All migrations in order */
export const migrations = [m001, m002, m003];
