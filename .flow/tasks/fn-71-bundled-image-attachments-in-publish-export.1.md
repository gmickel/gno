# fn-71-bundled-image-attachments-in-publish-export.1 Implement the Obsidian attachment resolver

## Description

Add a resolver that maps each `![[filename.ext]]` embed inside a note's
markdown to an absolute path on disk, using the note's collection root as
the vault boundary. This is the pre-requisite for every other task in the
epic: without a reliable resolver there is nothing to bundle.

Start here:

- `src/publish/obsidian-sanitize.ts` (current callsite that already
  recognises the embed syntax and emits `image-embed-dropped` warnings)
- `src/publish/export-service.ts` (has `DocumentRow` in hand; knows the
  note's collection + `relPath`)
- `src/config/types.ts` (`Collection.path` is the absolute vault root)
- `src/store/types.ts` (`DocumentRow` shape)

Requirements:

- New module `src/publish/attachment-resolver.ts` exporting a function
  that takes `(collectionRoot, noteRelPath, embedFilename)` and returns
  an `{ ok: true, absolutePath, resolution: "same-folder" | "attachments-folder" | "vault-search" | "ambiguous" }`
  or `{ ok: false, reason: "not-found" | "path-traversal" }`.
- Resolution order:
  1. `dirname(noteRelPath) / filename`
  2. `dirname(noteRelPath) / "attachments" / filename`
  3. Recursive search under `collectionRoot` for a file with exact
     basename `filename`. If multiple matches, pick the one with the
     shortest path distance to the note's folder; flag `ambiguous`.
- Reject any resolution whose absolute path is not a descendant of
  `collectionRoot` (path-traversal guard).
- Use Bun-native filesystem APIs (`Bun.file`, `fs/promises`). No new
  native dependencies.
- Case handling defers to the filesystem; do not normalize casing
  ourselves.
- Recursive search must exclude `.git`, `node_modules`, and the other
  entries in `DEFAULT_EXCLUDES` from `src/config/types.ts` so resolver
  time stays bounded on large vaults.
- Bounded work: cap the recursive walk at N files (e.g. 10_000 entries).
  On overflow, return `not-found` rather than silently truncating.

Tests / smoke:

- Fixture vault under `test/fixtures/publish/vault/` with:
  - note in root with sibling `cover.png`
  - note in subfolder with `attachments/logo.png`
  - note referencing `shared.png` that lives three folders away
  - note referencing `missing.png` that does not exist
  - note referencing `../outside.png` (path traversal attempt)
  - two notes referencing `common.png` with two files of that name in
    different subfolders (ambiguity)
- Unit tests for each scenario.
- Cross-platform path handling: tests should pass on both POSIX and
  Windows path separators (use `path.join` / `path.sep` consistently).

Important:

- Do not wire the resolver into the export pipeline in this task. That
  happens in task 2. This task is pure resolver + tests.
- Do not read the attachment bytes here. Return the absolute path only.
  Reading bytes is task 2's responsibility.

## Acceptance

- [ ] `src/publish/attachment-resolver.ts` exports a resolver that
      handles the four Obsidian resolution paths listed above.
- [ ] Path-traversal attempts are refused.
- [ ] Recursive vault search is bounded and excludes the same patterns
      as `DEFAULT_EXCLUDES`.
- [ ] Ambiguous matches are flagged and resolved by path distance to the
      note folder.
- [ ] Unit tests cover same-folder, attachments-folder, vault-search,
      ambiguity, missing file, and traversal scenarios.
- [ ] No new runtime dependency added to `package.json`.

## Done summary

(to fill on completion)

## Evidence

- Commits:
- Tests: `bun test test/publish/attachment-resolver.test.ts`
- PRs:
