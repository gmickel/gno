---
satisfies: [R2, R3, R4, R5, R6]
---
# fn-104-project-aware-retrieval-affinity.4 Gate affinity with agentic evals schemas and documentation

## Description
Deliver gate affinity with agentic evals schemas and documentation as one implementation-sized increment.

**Size:** M
**Files:** `evals/fixtures/agentic-retrieval`, `spec/output-schemas`, `test/project-affinity/parity.test.ts`, `docs/HOW-SEARCH-WORKS.md`, `docs/CONFIGURATION.md`, `assets/skill/SKILL.md`, `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

### Approach
- Add project-scoped collection-choice tasks plus irrelevant-project adversarial cases to fn-97.
- Require improved correct collection choice with no evidence-accuracy regression and publish raw auxiliary-score receipts.
- Extend the shipped parity seam for CLI `--project-root`/`--no-project-affinity` and SDK/REST/MCP `projectHints`; keep remote hints opaque, bounded to 16, and absent from reflected output.
- Update specs/schemas/docs/skill/hosted guidance only with measured, transparent behavior.
<!-- Updated by plan-sync: fn-104-project-aware-retrieval-affinity.3 shipped projectHints plus CLI --project-root/--no-project-affinity through test/project-affinity/parity.test.ts -->

### Investigation targets
**Required** (read before coding):
- `spec/output-schemas/query-diagnose.schema.json`
- `test/project-affinity/parity.test.ts`
- `docs/HOW-SEARCH-WORKS.md`
- `assets/skill/SKILL.md`

**Optional** (reference as needed):
- `docs/API.md`
- `docs/MCP.md`
- `docs/SDK.md`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `evals/agentic/types.ts`
- `src/core/project-affinity-surface.ts`

## Acceptance
- [ ] fn-97 project tasks improve correct collection choice without overall evidence-accuracy regression.
- [ ] Schema and parity tests cover CLI `--project-root`/`--no-project-affinity`, SDK/REST/MCP `projectHints`, and redacted explain metadata without reflecting opaque hints or unrelated absolute roots.
- [ ] Docs/skill/gno.sh state soft-signal, caller trust, disable/override, cap, and privacy behavior accurately.


## Done summary
# fn-104.4 completion summary

Status: implementation review `SHIP`

### Commits

- GNO `446b8e0` — `fix: harden project affinity contracts`
- GNO `9952a3e` — `test: regenerate project affinity receipts`
- gno.sh `bf2332a` — `docs: clarify diagnose affinity versions`

All three commits are pushed to `origin/feat/project-retrieval-affinity`.

### Review findings resolved

1. Structural budget enforcement now uses a closed `StorePort` call map, rejects
   unexpected/hidden calls, bounds every allowed method, and requires each
   vector candidate request and result set to stay at or below `3 * limit`.
2. Promotion validation is independent of the producer. It binds fixture,
   case, implementation, runtime, and raw receipt provenance; derives gates
   from raw receipts; recomputes fingerprints; compares committed output with a
   fresh deterministic production-path run; and rejects forged gates,
   fingerprints, rankings, structural receipts, and hidden calls.
3. Diagnose compatibility is explicit. Absent, disabled, and untrusted hints
   preserve exact schema-v1.0 bytes with no affinity member. Trusted local
   affinity emits schema v1.1, including trusted unmatched diagnoses.

### Promotion artifact

- Canonical fingerprint:
  `c038d0453efd005a7474cc134fe10bea84cfbce0e15a98ffef8c132402b68f7b`
- Implementation fingerprint:
  `8c331d285247f4bca1226dbd8ff57460dd92fd6c40f83109101088853c28defa`
- Raw regression receipts: 48
- Structural receipts: 57
- Auxiliary receipts: 5
- Zero-lane receipts: 4
- All promotion gates pass.

The six pre-existing agentic benchmark siblings remained byte-identical after
regeneration:

- `canonical.json`: `c465e96f9fb2626b20656a5ec7f4522130336f760024fb46cba8ce67297fdb2e`
- `observations.json`: `6894fd2ecf0e27a5221f8a79e3a87dd4f89199ba4fce0193b378463311119bca`
- `report.json`: `ad18b04e9ded389831591db3fd41d4f1adcff0d2b8770a534b6248c803ce4acf`
- `report.md`: `ab6f6ffb23f1213a18821402d5f83aa82eaa53ad572719d03cd08ccbc8403358`
- `verified-ask-promotion.json`: `0db7ea28dbc7b97b006fe9c838be4ae79cafcd85649be71e7a60462feae6cb77`
- `verified-ask-promotion.md`: `652720c5345673d0084be1e023ddeb1edd62ba4b875d059e502283facd324f54`

### Verification

- `bun run lint:check` — pass, 0 warnings/errors
- `bun run typecheck` — pass
- `bun run docs:truth` — pass
- `bun run docs:verify` — 13 pass, 0 fail, 2 model-cache skips
- `bun test` — 2,902 pass, 1 expected Windows skip, 0 fail; 361 files
- `bun run eval:agentic -- --write` — pass; affinity artifacts regenerated
- Focused baseline/promotion tests — 10 pass, 0 fail
- GNO skill autoresearch — 48/48, 100%; source copied and user skill reinstalled
- `.flow/bin/flowctl validate --spec fn-104-project-aware-retrieval-affinity --json`
  — valid, 0 errors, 0 warnings
- gno.sh `bun run check` — pass
- gno.sh `bun run typecheck` — pass
- gno.sh public-truth test — 10 pass, 0 fail
- gno.sh `bun run build` — pass

`uv` was unavailable; the repository's existing `.venv/bin/python` ran the
same autoresearch evaluator successfully.

### Fresh review

- Verdict: `SHIP`
- No remaining P1/P2 findings.
- Reviewed GNO head:
  `9952a3e743265a4fd9a34e03dc761eca8da22458`
- Reviewed hosted head:
  `bf2332af6b1518907d4826f0c811abd5c6a638ca`
- Reviewer independently reran 24 focused GNO checks and 10 hosted truth
  checks, and confirmed the three prior P2 findings are resolved.
## Evidence
- Commits: 446b8e0, 9952a3e, gno.sh:bf2332a
- Tests: bun run lint:check (pass: 0 warnings, 0 errors), bun run typecheck (pass), bun run docs:truth (pass), bun run docs:verify (13 pass, 0 fail, 2 model-cache skips), bun test (2902 pass, 1 expected Windows skip, 0 fail; 361 files), bun run eval:agentic -- --write (pass), bun test test/eval/agentic/baseline.test.ts test/eval/agentic/project-affinity-promotion.test.ts (10 pass, 0 fail), autoresearch .venv/bin/python eval.py (48/48, 100%), .flow/bin/flowctl validate --spec fn-104-project-aware-retrieval-affinity --json (valid; 0 errors; 0 warnings), gno.sh bun run check (pass), gno.sh bun run typecheck (pass), gno.sh bun run test -- src/lib/public-truth-content.test.ts (10 pass, 0 fail), gno.sh bun run build (pass)
- PRs: