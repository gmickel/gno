## Goal & Context

After a collection is removed from the config while its documents still exist as inactive rows, `gno status --json` keeps listing the collection name (with 0 documents). Observed during fn-135.3 after an un-isolated sandbox run registered and then removed `openclaw-memory` in the operator's global index.

## What

- Make `gno status` derive its collection list from the config plus active rows only, or purge inactive rows of collections no longer configured.
- Decide and document which (status is read-only today; a purge belongs in `gno index --prune` or the existing cleanup path).

## Acceptance Criteria

- R1: Removing a collection from the config and running `gno status --json` no longer lists it once no active rows remain.
- R2: Regression test covering the removed-collection case.

## Triage (2026-09-27, v2.8.0)

Still real and wider than filed: `gno status` lists a collection removed with `gno collection remove` until the next `gno update`, whether its rows are inactive (`documentCount: 0`) or still active (`documentCount: 1`), because status reads the DB `collections` table while `collection remove` only edits the config. Also: the text status chunk total counts chunks of deleted documents (`Total: 1 documents, 3 chunks` with one live chunk). Fix both; cover the active-row and inactive-row cases.
