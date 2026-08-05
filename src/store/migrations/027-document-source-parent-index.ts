/** Index the parent directory of each active document's effective source path. */
import type { Migration } from "./runner";

import {
  CREATE_SOURCE_PARENT_INDEX_SQL,
  DROP_SOURCE_PARENT_INDEX_SQL,
} from "../source-path-sql";

export const migration: Migration = {
  version: 27,
  name: "document_source_parent_index",

  up(db): void {
    db.exec(CREATE_SOURCE_PARENT_INDEX_SQL);
  },

  down(db): void {
    db.exec(DROP_SOURCE_PARENT_INDEX_SQL);
  },
};
