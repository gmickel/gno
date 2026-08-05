# Watcher indexes dotfiles that a full update refuses

## Overview

Writing a dot-prefixed markdown file into a watched collection makes it searchable.
The next `gno index` / `gno update` removes it again. The watcher and the full walk
disagree about whether dotfiles are eligible, so a document can appear in search
results and then silently vanish.

**Pre-existing — not introduced by `fn-114-reliable-watcher-reconciliation-for`.**
Confirmed: `src/ingestion/walker.ts` is unmodified by that branch, and fn-114 preserved
the exact-path watcher flow byte-for-byte under its R1. Found by the fn-114 live QA pass.

## Live evidence (captured, not inferred)

Isolated index, `gno serve` on port 3411, collection `pattern: "**/*"`, `include: []`.

```bash
# write a dotfile and an ordinary sibling, both containing "viboranium"
printf '# Hidden\n\nhidden viboranium marker.\n'   > notes/.hidden.md
printf '# Sibling\n\nsibling viboranium marker.\n' > notes/sibling.md.tmp
mv notes/sibling.md.tmp notes/sibling.md

# after the watcher settles (2s):
POST /api/search {"query":"viboranium"}
-> {"n":2,"uri":["gno://notes/.hidden.md","gno://notes/sibling.md"]}

# then a full walk:
gno index --yes        ->  Total: 0 added, 0 updated
POST /api/search {"query":"viboranium"}
-> {"n":1,"uri":["gno://notes/sibling.md"]}
```

The dotfile was indexed by the watcher and deactivated by the full walk.

## Root cause

Two different eligibility authorities:

- `matchesWalkPath` (`src/ingestion/walker.ts:187-219`) is a pure predicate and its
  `Bun.Glob(pattern).match()` **accepts** a leading dot. The watcher's exact-path branch
  (`src/serve/watch-service.ts`) consults only this, so a dotfile event is queued and synced.
- `FileWalker.walk` (`walker.ts:227-318`) discovers candidates with `Bun.Glob.scan`, which
  **never yields** dot-prefixed entries. A full sync therefore never sees the file, and
  because it is absent from the walk it is treated as missing and marked inactive.

So the predicate and the discovery mechanism disagree, and which one applies depends only
on how the file arrived.

Note: fn-114's directory-reconciliation enumeration
(`src/ingestion/directory-children.ts`) deliberately skips dot-prefixed entries precisely
to match walk discovery, so **reconciliation is already consistent**. Only the
pre-existing exact-path flow is not.

## Boundaries / non-goals

- Not a change to fn-114's reconciliation enumeration, which already behaves correctly
- Not a decision to start indexing dotfiles by default — see Open questions
- Not a change to `pattern` / `include` / `exclude` semantics

## Acceptance Criteria

- **R1:** A dot-prefixed file is treated identically by the watcher and by a full
  `gno index` for the same collection configuration — either both index it or neither does.
- **R2:** The chosen behavior is expressed in ONE place, so the predicate and the
  discovery mechanism cannot drift apart again.
- **R3:** A regression test writes a dotfile through the watcher path, runs a full sync,
  and asserts the document's active state is unchanged by the full sync.
- **R4:** If the resolution is "never index dotfiles", any user who currently relies on a
  watcher-indexed dotfile sees it disappear — decide whether that needs a release note.

## Open questions

- Which way should it resolve? Excluding dotfiles matches the full walk and current
  documented behavior, and is the smaller change. Including them would need `Bun.Glob.scan`
  to be given a dot-aware option and would change what `gno update` indexes for everyone.
- Do reserved GNO paths (`.gno/`) already depend on dot exclusion in the walk? Check
  `isRecordVirtualPath` and the reserved-path rules before flipping anything.

## References

- `src/ingestion/walker.ts:187-219` (`matchesWalkPath`, dot-accepting predicate)
- `src/ingestion/walker.ts:227-318` (`FileWalker.walk`, dot-skipping discovery)
- `src/ingestion/directory-children.ts` (fn-114 enumeration, already dot-consistent)
- Discovered by the live QA pass for `fn-114-reliable-watcher-reconciliation-for`
