## Goal & Context

`bun run docs:verify` (part of `prerelease`) fails on two public-truth version stamps: `README.md:118` reports 1.36.1 while the current release is 1.45.0, and `website/_config.yml` reports 1.35.0. The README stamp is real drift: the release recipe (`bun run version:minor`, changelog roll, tag) never touches it. The legacy `website/` directory is retired and must not be edited (user decision 2026-08-30), so the check should stop reading it.

## What

- Add the README current-version stamp to the release recipe (a small script or a `version:*` post-step that rewrites the stamp from package.json), and document it in docs/RELEASING.md.
- Drop `website/_config.yml` from the docs-verify public-truth check, or mark it retired.

## Acceptance Criteria

- R1: `bun run docs:verify` public-truth check is green on main at the current tag.
- R2: Bumping the version updates the README stamp without a manual edit.
- R3: docs/RELEASING.md describes the stamp step.
