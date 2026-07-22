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
import { migration as m004 } from "./004-doc-links";
import { migration as m005 } from "./005-graph-indexes";
import { migration as m006 } from "./006-document-metadata";
import { migration as m007 } from "./007-document-date-fields";
import { migration as m008 } from "./008-vector-fingerprints";
import { migration as m009 } from "./009-content-type-rule-fingerprint";
import { migration as m010 } from "./010-typed-edges";
import { migration as m011 } from "./011-doc-edge-traversal-indexes";
import { migration as m012 } from "./012-activation-receipts";
import { migration as m013 } from "./013-fts-sync-marker";

/** All migrations in order */
export const migrations = [
  m001,
  m002,
  m003,
  m004,
  m005,
  m006,
  m007,
  m008,
  m009,
  m010,
  m011,
  m012,
  m013,
];
