## Goal & Context

`src/ingestion/sync.ts` `decideAction` compares content hashes but never checks `existing.active`. A document that was deleted (row deactivated) and later restored at the same path with identical content is classified "unchanged" and stays inactive, so it never returns in search. Found during fn-135.3 in the OpenClaw sandbox (repro `/tmp/fn-135.3-e2e/11c-rename-back.json`); any content change reactivates it. Documented as a known gap in `integrations/openclaw-gno-memory/README.md` and `docs/MEMORY.md`.

## What

- Treat an inactive existing row as needing reactivation when the file is present again, regardless of hash equality.
- Journal the reactivation as a change event so `gno changes --follow` consumers see it.

## Acceptance Criteria

- R1: Delete a file, sync, restore the identical file, sync: the document is active and searchable again.
- R2: A regression test in `test/ingestion/` covers delete, restore-identical, sync.
- R3: The known-gap notes in the OpenClaw README and docs/MEMORY.md are removed.
