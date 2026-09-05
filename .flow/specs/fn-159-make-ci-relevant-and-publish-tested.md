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
