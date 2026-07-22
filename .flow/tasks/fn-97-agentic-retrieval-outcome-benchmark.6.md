---
satisfies: [R2, R3, R4, R5, R6]
---
# fn-97-agentic-retrieval-outcome-benchmark.6 Register adapters publish baselines reports and Capsule promotion gates

## Description
Compose all adapters, generate reviewable evidence, and enforce the exact paired Capsule promotion decision.

**Size:** M
**Files:** `evals/agentic/registry.ts`, `evals/agentic/report.ts`, `evals/agentic/cli.ts`, `evals/fixtures/agentic-retrieval/baseline/**`, `test/eval/agentic/report.test.ts`, `test/eval/agentic/promotion.test.ts`, `evals/README.md`, `spec/evals-agentic.md`, `package.json`

### Approach
- Register `gno-mcp`, `lexical`, `capsule`, and `qmd` adapters behind one CLI with task/adapter/lifecycle/agent filters and explicit `--write` behavior.
- Generate stable-key canonical JSON receipts, separate observations, and readable Markdown reports with environment, fingerprints, cohorts, every attempted pair/exclusion, methodology, and limitations.
- Report the shared corpus-snapshot fingerprint plus every adapter-native index fingerprint/build observation; never imply cross-adapter index identity.
- Enforce R6 on identical non-harness-failed task/trial pairs only: every pair has Capsule success ≥ GNO success; aggregate accuracy has no loss; sum-ratio outer-agent `agentCalls` reduction ≥25%; sum-ratio model-visible UTF-8 byte reduction ≥35%; micro claim linkage ≥95%; non-zero denominators; and byte-identical unchanged-input Capsule payloads. Report `backendInvocations` separately and never use them for the call gate.
- Commit deterministic fixture-agent baselines. Keep cached-local-model and qmd observations separate, opt-in, and non-authoritative for the deterministic gate.

### Investigation targets
**Required** (read before coding):
- Planned task 1–5 outputs under `evals/agentic/`
- `evals/README.md`
- `package.json`
- `src/bench/metrics.ts`

## Acceptance
- [ ] One command runs filtered identical tasks through registered adapters; requested unavailable adapters fail closed rather than disappearing from reports.
- [ ] Committed baselines include schema-valid canonical receipts, separate observations, exact environment/fingerprints, every pair/exclusion, methodology, and known limitations.
- [ ] Machine tests fail for any pair mismatch, hidden harness exclusion, pairwise success regression, aggregate accuracy loss, `agentCalls` reduction below 25%, byte reduction below 35%, claim linkage below 95%, zero denominator, or Capsule canonical-payload nondeterminism.
- [ ] Reports distinguish `agentCalls` from `backendInvocations` and split preparation/startup/model/tool/driver/e2e timings across adapters, using null plus reason when unavailable.
- [ ] `bun test` covers fixtures/schemas/scorers/report/gates; heavyweight `eval:agentic`, qmd, and cached-local-model runs remain explicit opt-in commands.
- [ ] `spec/evals-agentic.md`, `spec/evals.md`, and `evals/README.md` agree with the shipped benchmark contract and commands.

## Done summary
Implemented the complete fn-97 agentic benchmark reporting and promotion layer.

- Registered lazy adapter selection with authoritative gno-mcp, lexical, and Capsule defaults; qmd remains explicit and fail-closed.
- Added strict CLI filtering, exit semantics, deterministic report assembly, atomic artifact writing, canonical and observation projections, environment/methodology/limitation records, and human-readable Markdown tables.
- Added identity-bearing scores, exact requested-matrix validation, deterministic Capsule replay records, actual evidence-bundle byte/SHA binding, and strict gno-mcp versus Capsule promotion gates.
- Published the authoritative 24-task x 3-adapter x 2-lifecycle fixture baseline: 144 attempted/scored receipts and 48 unchanged-input Capsule replays.
- Preserved requested unavailable-qmd attempts as a complete harness-error report with canonical failure reasons and exit 2.
- Preserved failed and budget-rejected outer tool choices in canonical accounting, sanitized qmd child environments, and enforced raw qmd lock/model cache identity.
- Added contract, CLI, report, promotion, baseline, runner-failure, artifact-writer, failure-accounting, and qmd identity regressions; updated eval specifications and documentation.
- Independent completion review: SHIP, no remaining P0-P2 findings.

Authoritative result: Capsule maintained/improved task accuracy, reduced agent calls by 48.94%, and linked 100% of substantive claims, but used 65.70% more model-visible bytes. Promotion truthfully fails only the 35% context-byte-reduction gate. Canonical fingerprint: 1c1ce409aef4a0b21e4412cf57017bda55ff6265bc1c8bdd3373fd5a49033217. Baseline provenance: 64d2e47fff29a32ac4edc8c49d63f38752c8bdea, dirty=false. Baseline artifact commit: 249271a.
## Evidence
- Commits: 9298c60e273cf1ab24e99968644f87271c4f7819, 3ec2615be3c8ec331a53e0dacb4dc41aeb05c3d0, 9cb55795dd346a6fe63d233fabcef8fdf2b68f1b, a8bc43ed2f832a432654a6a4c555c166ea2ed161, cbe671742beb0f643b48646efee7e0f099024c01, 76a3d4d29ff5da13057cdcd31be1730c02f583fe, 0efcbb791c98bc7802c3fc0949ae4bb177856bd3, 1fd32c49090aa4e61131aea83a1c645290a859aa, cdaf4725130e9b0770a6e4d64a456ddf7cf2a041, 331a249107085cb251bcac33e5383b8e4d584cbe, 64d2e47fff29a32ac4edc8c49d63f38752c8bdea, 249271a, ca4a74a
- Tests: bun run lint:check: 0 warnings, 0 errors, formatting clean, bun test: 2470 passed, 1 Windows-only skip, 0 failed, 16066 assertions, bun run docs:verify: 13 passed, 0 failed, 2 model-cache skips, bun test test/eval/agentic: 135 passed, 0 failed, 2355 assertions, authoritative baseline: 144 receipts/scores, 48 replays, schema/canonical parity green, promotion truthfully fails only context-byte reduction
- PRs: