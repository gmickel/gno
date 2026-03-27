# fn-52-desktop-beta-signed-distribution.1 Scaffold desktop distribution readiness and rollout docs

## Description

Build the first signed-distribution/readiness slice for desktop beta rollout.

Initial slice:

- inventory current release/publish/install automation and identify what is missing for desktop distribution
- add repo-owned rollout/checklist docs for beta channel, rollback, and support handoff
- scaffold distribution metadata or placeholders in the shell package where signing/update channels will attach later
- keep user-data/update/defaults behavior explicit in docs instead of implicit tribal knowledge

## Acceptance

- [ ] Repo contains explicit rollout/rollback/support docs for desktop beta distribution
- [ ] Desktop shell package has a documented place for release-channel/signing metadata to attach
- [ ] Distribution assumptions and missing credentials/infra are called out clearly, not hidden

## Done summary

Shipped the first desktop distribution readiness slice.

Highlights:

- added desktop beta rollout docs with explicit signing/notarization/update prerequisites and rollback/support checklists
- added shell-side distribution placeholders for channels and macOS signing steps
- linked the distribution scaffolding from the shell README and CI/release docs
- kept missing credentials/hosting assumptions explicit instead of implying signed rollout is already ready

## Evidence

- Commits:
- Tests: bun test test/desktop/distribution-scaffold.test.ts, bun run lint:check, bun run typecheck, bun test, bun run docs:verify
- PRs:
