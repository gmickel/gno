---
satisfies: [R2, R3, R4, R5, R6]
---
# fn-97-agentic-retrieval-outcome-benchmark.6 Register adapters publish baselines reports and Capsule promotion gates

## Description
Compose all adapters, generate reviewable evidence, and enforce the exact paired Capsule promotion decision.

**Size:** M
**Files:** `evals/agentic/registry.ts`, `evals/agentic/report.ts`, `evals/agentic/cli.ts`, `evals/fixtures/agentic-retrieval/baseline/**`, `test/evals/agentic/report.test.ts`, `test/evals/agentic/promotion.test.ts`, `evals/README.md`, `spec/evals-agentic.md`, `package.json`

### Approach
- Register `gno-mcp`, `lexical`, `capsule`, and `qmd` adapters behind one CLI with task/adapter/lifecycle/agent filters and explicit `--write` behavior.
- Generate stable-key canonical JSON receipts, separate observations, and readable Markdown reports with environment, fingerprints, cohorts, every attempted pair/exclusion, methodology, and limitations.
- Enforce R6 on identical non-harness-failed task/trial pairs only: no accuracy loss; sum-ratio call reduction ≥25%; sum-ratio model-visible UTF-8 byte reduction ≥35%; micro claim linkage ≥95%; non-zero denominators; and byte-identical unchanged-input Capsule payloads.
- Commit deterministic fixture-agent baselines. Keep cached-local-model and qmd observations separate, opt-in, and non-authoritative for the deterministic gate.

### Investigation targets
**Required** (read before coding):
- Planned task 1–5 outputs under `evals/agentic/`
- `evals/README.md`
- `package.json`
- `src/bench/metrics.ts`
- `test/spec/schemas`

## Acceptance
- [ ] One command runs filtered identical tasks through registered adapters; requested unavailable adapters fail closed rather than disappearing from reports.
- [ ] Committed baselines include schema-valid canonical receipts, separate observations, exact environment/fingerprints, every pair/exclusion, methodology, and known limitations.
- [ ] Machine tests fail for any pair mismatch, harness exclusion hidden from the report, accuracy loss, call reduction below 25%, byte reduction below 35%, claim linkage below 95%, zero denominator, or Capsule canonical-payload nondeterminism.
- [ ] `bun test` covers fixtures/schemas/scorers/report/gates; heavyweight `eval:agentic`, qmd, and cached-local-model runs remain explicit opt-in commands.
- [ ] `spec/evals-agentic.md`, `spec/evals.md`, and `evals/README.md` agree with the shipped benchmark contract and commands.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
