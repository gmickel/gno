---
satisfies: [R2, R3, R5]
---
# fn-97-agentic-retrieval-outcome-benchmark.5 Add fail-closed revision-pinned qmd comparator

## Description
Integrate qmd as an immutable external comparator without trusting PATH, modifying a developer checkout, or silently skipping requested runs.

**Size:** M
**Files:** `evals/agentic/adapters/qmd.ts`, `evals/agentic/qmd-preflight.ts`, `evals/fixtures/agentic-retrieval/qmd.lock.json`, `test/eval/agentic/qmd-adapter.test.ts`, `test/eval/agentic/qmd-lock.test.ts`, `spec/evals-agentic.md`

### Approach
- Add `qmd.lock.json` with exact repository URL, full commit `e428df76bc0274d9e93eb7ca3e95673315c42e90`, package name/version, repository-relative entrypoint, normalized tool-schema hashes, and model IDs/checksums. Preflight every field and reject missing, dirty, mismatched, placeholder, or ambiguous inputs before a trial starts.
- Resolve only the locked checkout entrypoint and invoke it with isolated `QMD_CONFIG_DIR`, `XDG_CONFIG_HOME`, and `XDG_CACHE_HOME` plus isolated data paths. Never use PATH/global qmd, `git checkout`, `git pull`, dependency installation, or writes inside the supplied repository.
- Build qmd's native immutable index from the common corpus snapshot only inside those temporary QMD/XDG/data roots during unmeasured preparation. Record its index fingerprint/build observations; cold and warm qmd cohorts reuse that identical prepared qmd index.
- Hash exact returned content in the harness and label it `harness_observed`. Preserve backend-provided source/span hashes only when actually present; otherwise store null plus reason. Never pass hidden oracle data to qmd or synthesize backend hashes from it.
- Map qmd capabilities/results/errors into the normalized adapter contract and disclose unsupported tool, span, token, lifecycle, and backend-hash measurements explicitly.
- Make a requested qmd run fail as a harness error on preflight/contract failure; qmd remains optional for ordinary tests and non-qmd adapter runs.

### Investigation targets
**Required** (read before coding):
- `/Users/gordon/repos/qmd/README.md`
- qmd commit `e428df76bc0274d9e93eb7ca3e95673315c42e90`
- Planned task 2 outputs: `evals/agentic/adapter.ts`, `evals/agentic/runner.ts`

## Acceptance
- [ ] Preflight verifies every `qmd.lock.json` repository/package/version/entrypoint/tool-schema/model field and accepts only a clean exact checkout; no PATH/global fallback.
- [ ] Adapter execution does not mutate the qmd checkout or global qmd/config/data state; `QMD_CONFIG_DIR`, both XDG directories, and data paths are isolated and fingerprinted.
- [ ] Missing path, dirty tree, revision mismatch, missing command, malformed output, or unsupported requested contract fails closed and remains visible as a harness error.
- [ ] qmd receipts distinguish `harness_observed` returned-content hashes from nullable backend hashes and declare every unavailable capability/measurement rather than imputing calls, spans, hashes, tokens, or lifecycle parity.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
