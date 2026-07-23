---
satisfies: [R3, R5]
---
# fn-103-capsule-distribution-and-commercial.11 Correct Context Capsule demo public truth and links

## Description
Remediate fn-103.3 hosted evidence links and selection-context copy while preserving the exact measured values.

**Size:** S
**Files:** `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`, `/Users/gordon/work/gno.sh/src/routes/features.$featureSlug.tsx`, `/Users/gordon/work/gno.sh/src/lib/public-truth-content.test.ts`

### Approach
- Pin each public source link to a commit proven to contain the claimed artifact and canonical fingerprint.
- Disclose that the selected task is the sole cold current-GNO-fail / Capsule-success case in the 24-task cohort.
- Disclose that the Capsule lane is an evaluation-only lexical prototype and its latency is not equivalent to the shipped product Context Capsule path.
- Preserve exact task-level measurements, raw receipts, methodology, and one-trial limitations without implying representative or general superiority.

## Acceptance
- [ ] Every immutable public link resolves to content with the displayed canonical fingerprint.
- [ ] Public copy states the task selection rule and its one-of-24 status prominently.
- [ ] Public copy states the Capsule lane is an evaluation-only lexical prototype and its latency is not product-equivalent.
- [ ] Exact measured task values remain unchanged and Verified Ask remains a separate answer-enforcement proof.
- [ ] Hosted truth tests, typecheck, full tests, and production build pass.


## Done summary
Corrected the hosted Context Capsule demo evidence links and public claims.
The demo JSON/Markdown now pin the GNO commit that actually contains fingerprint
bb5c0595; the report and Verified Ask links pin the commit that contains the
claimed ce05f9d8 and 53931a6a fingerprints. The benchmark page and docs now
prominently disclose that t0a1b2c3 is the sole cold current-GNO-failure /
Capsule-success case among 24 tasks, that the Capsule lane is an evaluation-only
lexical prototype, and that its 2.191 ms latency is not shipped-product-equivalent.
All measured lane values remain unchanged.
## Evidence
- Commits: e35d66b561ee5475a3839de636251f5181d71c71, bdbab09
- Tests: curl raw immutable demo/report/Verified Ask artifacts and verify bb5c0595/ce05f9d8/53931a6a fingerprints, gno.sh bun run check, gno.sh bun run typecheck, gno.sh bun test (94 pass, 7 integration skips, 0 fail), gno.sh bun run build (67 prerenders)
- PRs: