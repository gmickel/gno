---
satisfies: [R1, R2, R3, R4]
---
# fn-159-make-ci-relevant-and-publish-tested.1 Implement relevant CI and exact-artifact release gates

## Description
# CI relevance and tested release artifacts

### Requirements
- R1: Cancel superseded PR runs, classify changes conservatively, retain stable required checks with fail-closed aggregate.
- R2: Keep pinned Linux/macOS suites and three-platform watcher coverage. Latest runtime compatibility weekly/manual, relevant Windows and clipper checks, single lint job.
- R3: Publish the exact tested tarball with integrity checks only after coordinated desktop artifacts pass. Preserve signing and physical acceptance boundaries.
- R4: Fix observed asynchronous PDF lifecycle assertion without weakening behavior; update contributor docs and patch version.

### Acceptance
- Focused classifier and workflow tests, lint/typecheck, full Bun tests green.
- Remote PR CI passes including macOS, required check names preserved; no release tags or publication performed.
## Acceptance
- [ ] R1-R4 implemented and meaningful local plus remote checks pass.

**Touches:** .github/**, test/scripts/ci*, test/serve/public/pages/DocView.dom.test.tsx, package.json, CHANGELOG.md, README.md

Quick: `bun run lint:check`; `bun test`; actionlint on changed workflows.

## Done summary
Implemented R1-R4. CI now classifies conservatively, retains stable Linux/macOS names, reports fail-closed CI result, cancels superseded PR runs, and selects latest Bun watcher compatibility only weekly/manual. Windows and clipper work follow relevant paths and label events. Release publication consumes the checksummed smoke-tested tarball and waits for both desktop artifacts; signing and launch checks are unchanged. Fixed the PDF navigation test's passive-effect race with waitFor, retaining its mount assertion. Source version is 2.0.1; no tag or publication performed.

Validation: full Bun1.4.2 suite 5223 pass, 2 skip, 0 fail (282s), followed by 9 new focused CI/workflow tests (36 assertions), lint/typecheck green (26 existing warnings), actionlint1.7.12 green for all three changed workflows, docs:verify15pass/2model-dependent skips, git diff --check. Executed the actual publication verification shell against a valid tarball; wrong-tag and tampered-artifact cases were rejected. Initial direct-redirect native package subprocess panicked; documented piped full-suite command and isolated package test both passed without code changes.

Fresh in-harness read-only reviewer: SHIP, no blockers, checked classifier/aggregate, publication dependencies, signing preservation and cancellation semantics. Hosted PR checks remain the merge gate; physical platform acceptance remains local.

stage: impl-review - skipped(config: review.backend=none; repository forbids external review subprocesses)
stage: code-review - ran (fresh in-harness reviewer returned SHIP)
stage: completion-review - skipped(config: review.backend=none)
stage: plan-sync - skipped(empty: single task with no downstream task)
stage: QA - skipped(policy: CI/release configuration change; hosted CI verifies workflow execution)

Implementation routing fallback: Cursor bridge made no edits before owned-process termination after about5min; Grok CLI timed out at360s (exit124), no edits. Active harness implemented and validated the change.
## Evidence
- Commits: 0b6555c9
- Tests: Bun1.4.2 full suite:5223pass/2skip/0fail,282s, bun test test/scripts/ci.test.ts:9pass,36assertions, bun run lint:check:pass,26existing warnings, actionlint1.7.12 changed workflows:pass, bun run docs:verify:15pass/2skip, publication verification shell:valid pass,wrong tag/tamper fail
- PRs: