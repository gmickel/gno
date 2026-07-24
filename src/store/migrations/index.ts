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
import { migration as m014 } from "./014-retrieval-traces";
import { migration as m015 } from "./015-document-change-journal";
import { migration as m016 } from "./016-saved-capsules";
import { migration as m017 } from "./017-document-change-retention-counters";
import { migration as m018 } from "./018-saved-capsule-registration-epoch";
import { migration as m019 } from "./019-saved-capsule-registration-generation";
import { migration as m020 } from "./020-browser-clipper-security";
import { migration as m021 } from "./021-multi-context-identity";

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
  m014,
  m015,
  m016,
  m017,
  m018,
  m019,
  m020,
  m021,
];
