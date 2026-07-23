---
satisfies: [R2, R4, R5, R6, R7]
---
# fn-102-knowledge-delta-and-capsule.5 Complete delta schemas lifecycle tests and documentation

## Description
Deliver complete delta schemas lifecycle tests and documentation as one implementation-sized increment.

**Size:** M
**Files:** `spec/output-schemas`, `test/changes`, `docs/CLI.md`, `docs/API.md`, `docs/MCP.md`, `docs/DAEMON.md`, `assets/skill/SKILL.md`

### Approach
- Add contract, migration, rename/delete/create, no-op/failure, race, retention/purge, cursor-expiry, impact-bound, and reverification suites. Reverification coverage includes ordered fingerprint reasons independent from ranking, partial-truth mirror/chunk hashes, strict canonical metadata with exact evidence bytes, large saved Capsules crossing one SQLite lookup batch, and saved/runtime canonical index mismatches rejected before evidence reads.
- Document journal storage limits, saved-Capsule lifecycle, local notifications, privacy, and no-rewrite/no-autonomous-synthesis boundaries.
- Update skill and hosted evidence-freshness guidance and run full release/autoresearch gates.

### Investigation targets
**Required** (read before coding):
- `test/spec/schemas`
- `docs/CLI.md`
- `docs/DAEMON.md`
- `assets/skill/SKILL.md`

**Optional** (reference as needed):
- `docs/WEB-UI.md`
- `docs/TROUBLESHOOTING.md`
## Acceptance
- [ ] All new change/diff/impact/watch/reverification schemas validate and parity tests pass, including `currentFingerprints`, `fingerprintStatus`, ordered distinct `fingerprintReasons`, and every verifier content classification/current-hash shape.
- [ ] Race/no-op/failure/retention fixtures prove no false deltas or silent history fabrication.
- [ ] Docs/skill/gno.sh explain exact capabilities, limits, privacy, and non-autonomous behavior.
<!-- Updated by plan-sync (cross-spec): fn-98-context-capsule-mvp.4 review fixes expanded the canonical reverification receipt and large-Capsule verification contract -->
<!-- Updated by plan-sync (cross-spec): fn-98-context-capsule-mvp.5 review fixes established saved-Capsule index authority for lifecycle docs and tests -->


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
