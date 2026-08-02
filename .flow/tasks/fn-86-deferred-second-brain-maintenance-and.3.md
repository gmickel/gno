---
satisfies: [R3, R6]
---
# fn-86-deferred-second-brain-maintenance-and.3 Add provenance completeness and freshness audits

## Description
Implement provenance-completeness and freshness/index-consistency rules. Report only declared metadata requirements and observable drift/age policy; distinguish unreadable, unavailable, inconclusive, and changed-during-run evidence from clean or factual-staleness claims.

**Size:** M
**Files:** `src/core/audit-provenance.ts`, `src/core/audit-freshness.ts`, `src/core/capture.ts`, `src/core/record-metadata.ts`, `src/store/vector/freshness.ts`, `test/audit/provenance-freshness.test.ts`

### Approach
- Derive provenance requirements from supported capture/page metadata rather than heuristics over prose.
- Reuse source/index fingerprints and freshness primitives where available.
- Make age-policy findings explicitly configured signals, not assertions that content is wrong.
- Keep every rule offline and deterministic with bounded evidence.

### Investigation targets
**Required** (read before coding):
- `src/core/capture.ts` — captured note/provenance contract
- `src/core/record-metadata.ts` — bounded record metadata projection
- `src/store/vector/freshness.ts` — existing freshness semantics
- `src/core/browser-clip-provenance.ts` — provenance validation precedent
- `src/cli/commands/status.ts` — source/index status vocabulary

**Optional** (reference as needed):
- `src/core/egress-provenance.ts` — structured provenance type patterns
- `.flow/specs/fn-82-second-brain-capture-and-provenance.md` — completed foundation intent

### Key context
Missing provenance is a completeness finding, not a truth verdict. Age is a signal only under explicit policy. Unreadable or missing evidence is unavailable/inconclusive, never pass.

## Acceptance
- [ ] Provenance rules evaluate only documented required fields for supported capture/page types and report exact missing/invalid evidence.
- [ ] Freshness rules distinguish source/index drift, unreadable/missing source, stale indexed revision, configured age signal, and changed-during-run.
- [ ] No result equates age/missing provenance with factual falsity; unavailable/inconclusive checks never count as pass.
- [ ] Large-fixture scans are deterministic, batched/bounded, and expose truthful timing/examined counts.
- [ ] No-write unit/store fixtures and lint pass.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
