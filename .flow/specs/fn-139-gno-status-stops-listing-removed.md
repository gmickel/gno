## Goal & Context

After a collection is removed from the config while its documents still exist as inactive rows, `gno status --json` keeps listing the collection name (with 0 documents). Observed during fn-135.3 after an un-isolated sandbox run registered and then removed `openclaw-memory` in the operator's global index.

## What

- Make `gno status` derive its collection list from the config plus active rows only, or purge inactive rows of collections no longer configured.
- Decide and document which (status is read-only today; a purge belongs in `gno index --prune` or the existing cleanup path).

## Acceptance Criteria

- R1: Removing a collection from the config and running `gno status --json` no longer lists it once no active rows remain.
- R2: Regression test covering the removed-collection case.
