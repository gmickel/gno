# fn-71-bundled-image-attachments-in-publish-export.5 End-to-end smoke, docs, and CHANGELOG

## Description

Wrap the epic with an end-to-end smoke path and the user-facing docs. This
is the task that turns "the code works on fixtures" into "a gno user who
reads the docs can publish a note with images".

Start here:

- `scripts/smoke-publish-from-gno.ts` (in `~/work/gno.sh`) — existing smoke
  entrypoint
- `docs/SYNTAX.md` (in `~/work/gno`) — user-facing markdown/Obsidian
  syntax reference
- `README.md` (in `~/work/gno`) — publish section
- `CHANGELOG.md` (in `~/work/gno`)
- `docs/handoffs/gno-publish-artifact-contract.md` (in `~/work/gno.sh`,
  updated in task 4)

Requirements:

### Smoke path

- Fixture vault under `test/fixtures/publish/vault-with-images/` (in
  `~/work/gno`). Contains:
  - `note.md` with `# Title\n\nHero:\n\n![[cover.png]]\n\nInline:
![[logo.png|Our Logo]]\n\nMissing: ![[ghost.png]]\n\nOversize:
![[huge.png]]\n`
  - `cover.png` (real PNG, ~200 KB)
  - `attachments/logo.png` (real PNG, ~40 KB)
  - `huge.png` (PNG over the per-asset cap, to exercise the skip path)
- End-to-end smoke (extend `scripts/smoke-publish-from-gno.ts` on the
  gno.sh side, or add `scripts/smoke-publish-images.ts`) that:
  1. Runs `gno publish export` against the fixture
  2. Asserts the artifact JSON contains `spaces[0].notes[0].assets` with
     exactly two entries (cover + logo)
  3. Asserts `huge.png` was reported as oversize-per-asset and the
     embed was replaced with alt text
  4. Uploads the artifact to a local gno.sh instance
  5. Fetches the rendered reader page
  6. Asserts the DOM contains `<img>` for cover and logo pointing at
     served URLs; no `gno-asset:` references remain; alt text for the
     missing + oversize embeds is present as plain text

### Docs

- Update `docs/SYNTAX.md` (gno) with a new section: "Publishing notes
  with images". Cover:
  - `![[filename.ext]]` and aliased `![[filename.ext|Alt Text]]` syntax
  - resolution order (same folder → `attachments/` → vault search)
  - MIME allowlist
  - per-asset (10 MB) and per-artifact (90 MB) size caps
  - what `--preview` reports
  - explicit note that GNO does not optimize images; users wanting
    smaller files should optimize in Obsidian or their asset pipeline
    before publishing
  - recommended tighter budget for encrypted shares
- Update `README.md` publish section with a one-liner that images now
  travel with the artifact.
- Update gno.sh `docs/handoffs/gno-publish-artifact-contract.md` to
  link to the SYNTAX.md section.

### CHANGELOG

Add an `[Unreleased]` entry to `CHANGELOG.md` (gno):

- `### Added` — `gno publish export` now bundles image attachments
  (`![[image.png]]`, PNG / JPEG / GIF / WebP / SVG) into the artifact,
  so figures render on gno.sh without requiring authors to migrate to
  `![alt](url)` first.
- `### Changed` — `--preview` reports bundled / unresolved / oversize /
  rejected attachment counts.

Leave the version bump itself for a separate release commit.

### Release readiness checks

- `bun run lint:check`
- `bun test`
- `bun run typecheck`
- `scripts/smoke-publish-from-gno.ts` (or equivalent image smoke)

## Acceptance

- [ ] Fixture vault committed with cover / logo / missing / oversize
      scenarios.
- [ ] End-to-end smoke script runs green from `gno publish export` →
      gno.sh upload → rendered reader DOM containing the expected
      `<img>` elements.
- [ ] `docs/SYNTAX.md` documents image publishing in full, including
      the "we do not optimize images" stance.
- [ ] `README.md` mentions bundled images in the publish section.
- [ ] Cross-repo contract doc references the new SYNTAX section.
- [ ] `CHANGELOG.md` has an `[Unreleased]` entry covering the bundler.
- [ ] `bun run lint:check`, `bun test`, `bun run typecheck` all pass.

## Done summary

(to fill on completion)

## Evidence

- Commits:
- Tests: full gate + smoke script
- PRs:
