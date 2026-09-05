# GNO 2.0 release dependency sweep

User-authorized follow-on to fn-143 through fn-152, on the same branch and PR 217. PR 183 and superseded fn-138/fn-141 remain untouched. No plan or implementation review. All agents gpt-6-astra medium.

## Requirements

- R1: Audit all open Dependabot PRs and direct/runtime/development dependency freshness, scripts, compatibility and advisories; record adopt/defer decisions.
- R2: Apply worthwhile pinned updates and compatible transitive security fixes. Preserve retrieval semantics and native ownership/lifetime guarantees.
- R3: Run frozen install, lint, typecheck, tests, docs, package, retrieval and affected live surfaces; validate native changes on CUDA and CI. Fresh physical CUDA and Heimdall QA required after the core dependency upgrade, per the latest user instruction. Retain actual results and residual advisory exposure.
- R4: Reconcile aggregate PR and queued hosted docs with final versions/evidence. Release only if gates establish readiness.

## Boundaries

One aggregate release branch/PR; no unrelated contributor PR changes. Larger unsupported SDK/compiler/linter migrations may be deferred with evidence. No weakened fixtures or thresholds.
