import type { Migration } from "./runner";

export const migration: Migration = {
  version: 30,
  name: "typed_metadata",
  up(db): void {
    db.exec("ALTER TABLE documents ADD COLUMN typed_metadata TEXT");
    db.exec("ALTER TABLE documents ADD COLUMN metadata_error TEXT");
  },
  down(): void {
    // Derived columns are retained; SQLite rollback must not rewrite source rows.
  },
};
