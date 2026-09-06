# CI relevance and tested release artifacts

## Goal & Context

Reduce duplicate and irrelevant CI work while retaining cross-platform evidence, and make publication consume the exact artifact that passed packaging tests.

## Acceptance Criteria
- **R1:** Cancel superseded PR runs, classify changes conservatively, retain stable required checks with fail-closed aggregate.
- **R2:** Keep pinned Linux/macOS suites and three-platform watcher coverage. Latest runtime compatibility weekly/manual, relevant Windows and clipper checks, single lint job.
- **R3:** Publish the exact tested tarball with integrity checks only after coordinated desktop artifacts pass. Preserve signing and physical acceptance boundaries.
- **R4:** Fix observed asynchronous PDF lifecycle assertion without weakening behavior; update contributor docs and patch version.

## Verification
- Focused classifier and workflow tests, lint/typecheck, full Bun tests green.
- Remote PR CI passes including macOS, required check names preserved; no release tags or publication performed.

## Boundaries

No release tags, npm publication, production deployments, or physical File Provider/desktop acceptance substitutions in this change.

## Landing evidence

PR #219 merged as `51a31ea229faa6d77bcdc2f7c596b0540e12ec2a` after all16 hosted checks passed at `65da886416ae96d9ce2fd095e395fdb8e6553f7f`. CI run: https://github.com/gmickel/gno/actions/runs/33977726892 . Linux/macOS full suites and packed gateway checks, Windows full suite and desktop packaging, allthree watcher platforms, clipper E2E, lint, CodeQL/dependency review, Vercel and CI result passed. No unresolved review threads.

Review followed the repository AGENTS.md policy that planning and review stay in-harness. A fresh native read-only reviewer returned SHIP and reconfirmed the exact merged PR head; the only intervening code-host catch-up was unrelated Flow planning metadata. That project policy superseded the generic land skill's hosted-bot signal and associated silence grace. Copilot reported exhausted quota and was not counted as a substantive review or approval. Actual required checks remained enforced.

The source version is2.0.1. No release tag, npm publication or physical acceptance bypass occurred. Tracker sync: n/a (bridge inactive). Release-follow: skipped(user scope excludes publication).
