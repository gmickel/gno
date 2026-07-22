---
satisfies: [R2, R3, R5]
---
# fn-97-agentic-retrieval-outcome-benchmark.5 Add fail-closed revision-pinned qmd comparator

## Description
Integrate qmd as an immutable external comparator without trusting PATH, modifying a developer checkout, or silently skipping requested runs.

**Size:** M
**Files:** `evals/agentic/adapters/qmd.ts`, `evals/agentic/qmd-preflight.ts`, `test/evals/agentic/qmd-adapter.test.ts`, `spec/evals-agentic.md`

### Approach
- Require `QMD_REPO` to resolve to a dedicated checkout at exact `HEAD` `e428df76bc0274d9e93eb7ca3e95673315c42e90`; reject missing, dirty, mismatched, or ambiguous paths before a trial starts.
- Resolve qmd commands only from that checkout and invoke its documented local interface with isolated config/data paths. Never use PATH/global qmd, `git checkout`, `git pull`, dependency installation, or writes inside the supplied repository.
- Map qmd capabilities/results/errors into the normalized adapter contract and disclose unsupported tool, span, token, and lifecycle measurements explicitly.
- Make a requested qmd run fail as a harness error on preflight/contract failure; qmd remains optional for ordinary tests and non-qmd adapter runs.

### Investigation targets
**Required** (read before coding):
- `/Users/gordon/repos/qmd/README.md`
- qmd commit `e428df76bc0274d9e93eb7ca3e95673315c42e90`
- Planned task 2 outputs: `evals/agentic/adapter.ts`, `evals/agentic/runner.ts`

## Acceptance
- [ ] Preflight accepts only a clean `QMD_REPO` checkout at the exact pinned revision and never falls back to PATH/global resolution.
- [ ] Adapter execution does not mutate the qmd checkout or global qmd/config/data state; isolated runtime paths are fingerprinted.
- [ ] Missing path, dirty tree, revision mismatch, missing command, malformed output, or unsupported requested contract fails closed and remains visible as a harness error.
- [ ] qmd receipts declare every unavailable capability/measurement rather than imputing calls, spans, tokens, or lifecycle parity.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
