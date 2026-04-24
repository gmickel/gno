# fn-74-upstream-freshness-and-code-retrieval.1 Evaluate and upgrade node-llama-cpp

## Description

Evaluate the current `node-llama-cpp` release line against GNO's pinned runtime and upgrade if the supported local smoke matrix passes.

Current observed comparison:

- GNO: `node-llama-cpp` `3.17.1`
- QMD reference: `node-llama-cpp` `3.18.1`

This task is not a blind version bump. Check upstream release notes/changelog, update the lockfile, run targeted local runtime smoke, and verify npm/package behavior. Add a durable repo note so native runtime dependency freshness is checked regularly during release or maintenance work.

## Acceptance

- [ ] Latest stable `node-llama-cpp` release is checked against upstream release notes/changelog.
- [ ] Dependency is upgraded if compatible; if not upgraded, task records the concrete blocker and follow-up.
- [ ] `package.json` and `bun.lock` are consistent after the decision.
- [ ] Local runtime smoke covers model cache path resolution, GGUF validation path, GPU env resolution/fallback, and at least one embedding path using mocks or cached models as appropriate.
- [ ] Full repo gate runs: `bun run lint:check`, `bun test`, and `bun run docs:verify` if docs changed.
- [ ] Package smoke runs when upgraded: `bun run build:css && npm pack`, then verify package contents/install behavior enough to catch missing runtime files.
- [ ] Add/update a maintenance note in `AGENTS.md`, `CLAUDE.md`, or release docs so `node-llama-cpp` freshness is explicitly rechecked in future maintenance/release cycles.
- [ ] Changelog documents upgrade or documented no-op decision.

## Done summary
Upgraded node-llama-cpp to 3.18.1 after freshness check against npm/GitHub, kept it in trustedDependencies, and verified it loads through doctor and tarball install smoke.
## Evidence
- Commits:
- Tests:
- PRs: