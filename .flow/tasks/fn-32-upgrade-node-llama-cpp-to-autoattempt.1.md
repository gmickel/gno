# fn-32-upgrade-node-llama-cpp-to-autoattempt.1 Upgrade node-llama-cpp and adopt autoAttempt build

## Description

TBD

## Acceptance

- Upgrade node-llama-cpp to a version supporting `build: "autoAttempt"`.
- Switch `getLlama()` initialization to `build: "autoAttempt"`.
- Verify embedding, generation, rerank, and server startup still work.
- Update docs/changelog if user-visible GPU/init behavior changed.
- Run lint, full tests, evals, package smoke, and model-backed CLI/API smoke.
- Include current local skill/agent files in the commit as requested.

## Done summary

Upgraded node-llama-cpp from 3.14.5 to 3.17.1, switched `getLlama()` to `build: "autoAttempt"`, refreshed the Bun lockfile, and verified lint, full tests, evals, docs verification, package smoke, and live model-backed CLI retrieval still work.

## Evidence

- Commits:
- Tests: bun install, bun pm trust node-llama-cpp, bun run lint:check, bun test, bun run eval, bun scripts/docs-verify.ts, npm pack, bun /Users/gordon/work/gno/src/index.ts query "performance" --intent "web performance and latency" --candidate-limit 8 --limit 3 --json, bun /Users/gordon/work/gno/src/index.ts ask "performance" --intent "web performance and latency" --candidate-limit 8 --limit 3 --no-answer --json, bun /Users/gordon/work/gno/src/index.ts models list --json
- PRs:
