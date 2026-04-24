# fn-74-upstream-freshness-and-code-retrieval.2 Evaluate and upgrade sqlite-vec

## Description

Evaluate the current `sqlite-vec` package line against GNO's pinned runtime and upgrade if supported platform/package smoke passes.

Current observed comparison:

- GNO: `sqlite-vec` `0.1.7-alpha.2`
- QMD reference: `sqlite-vec` `0.1.9` with platform optional packages

This task must protect GNO's packaging constraints: Bun runtime, npm package install behavior, macOS Homebrew SQLite guidance, and graceful BM25-only degradation when sqlite-vec is unavailable.

## Acceptance

- [ ] Latest stable `sqlite-vec` package/release is checked; native package/optional dependency changes are understood before bumping.
- [ ] Dependency is upgraded if compatible; if not upgraded, task records concrete blocker and follow-up.
- [ ] `package.json`, `bun.lock`, and `trustedDependencies` / package build-script policy are consistent after the decision.
- [ ] Vector adapter tests cover load success when available, unavailable guidance, `VEC_SEARCH_UNAVAILABLE`, and storage paths that work without sqlite-vec.
- [ ] Smoke validates `gno doctor --json`, `gno vsearch` failure guidance when vec unavailable, and hybrid BM25-only degradation behavior.
- [ ] Package smoke runs when upgraded: `bun run build:css && npm pack`, then inspect tarball/install enough to catch missing native/runtime files.
- [ ] Docs/troubleshooting updated if install, macOS, Windows, or package guidance changes.
- [ ] Changelog documents upgrade or documented no-op decision.

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
