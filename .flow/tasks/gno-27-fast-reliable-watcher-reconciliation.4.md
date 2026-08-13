---
satisfies: [R7]
---
# gno-27-fast-reliable-watcher-reconciliation.4 Reconcile watcher documentation, credit, and final evidence

## Description
Bring public/developer documentation, contributor credit, hosted-site truth, and release evidence in line with the proven watcher behavior (R7 and the spec Boundaries). No public flag, REST, MCP, status, or output-schema shape changes are introduced.

**Size:** M
**Files:** `CHANGELOG.md`, `README.md`, `docs/ARCHITECTURE.md`, `docs/DAEMON.md`, `docs/CLI.md`, `docs/WEB-UI.md`, `docs/TROUBLESHOOTING.md`, `spec/cli.md`, `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`, `/Users/gordon/work/gno.sh/src/lib/product-pages.ts`
**Touches:** [CHANGELOG.md, README.md, docs/ARCHITECTURE.md, docs/DAEMON.md, docs/CLI.md, docs/WEB-UI.md, docs/TROUBLESHOOTING.md, spec/cli.md, /Users/gordon/work/gno.sh/src/lib/gno-docs.tsx, /Users/gordon/work/gno.sh/src/lib/product-pages.ts]

### Approach
- Document the exact-vs-ambiguous event contract, bounded watcher-owned snapshot, failure-safe disk/index fallback, finite churn behavior, and shared serve/daemon ownership without exposing fingerprints as a public API.
- State tested local-filesystem guarantees precisely; preserve `--no-sync-on-start`, status schemas, Capsule settlement, and full-sync exact-reconciliation wording. Describe the 5,000-file proof as candidate discovery, not a production full reconciliation: macOS/Linux use native-anchored measurement, while Windows uses the path-backed filesystem adapter and must retain that label.
- Add an Unreleased `Fixed` entry crediting `@DanielKillenberger` for the original report/core direction and explicitly note the fresh maintainer implementation.
- Update the canonical hosted `gno.sh` daemon/docs/product/FAQ copies required by repo policy and live-drive affected pages; do not treat this repo's legacy `website/` directory as production.
- Run docs verification, full repo gates, the live watcher smoke, and the plan-required skill autoresearch only if CLI/MCP behavior or agent guidance actually changed.

### Investigation targets
**Required** (read before coding):
- `docs/ARCHITECTURE.md:177-182` — current path-scoped/full-reconciliation contract
- `docs/DAEMON.md:9-75` — headless continuous-indexing behavior
- `docs/CLI.md:1667-1695` — daemon command reference and shared watcher statement
- `docs/TROUBLESHOOTING.md:386-430` — watcher troubleshooting surface
- `CHANGELOG.md:1-45` — Unreleased format and contributor-credit style

**Optional** (reference as needed):
- `docs/WEB-UI.md:516-530` — background reliability wording
- `spec/cli.md:3334-3380` — daemon public contract verification
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx:1726` — hosted docs duplicate
- `/Users/gordon/work/gno.sh/src/lib/product-pages.ts:825` — hosted product/FAQ duplicate

### Key context
- Do not claim universal network/removable/coarse-timestamp behavior.
- Production ambiguous-event reconciliation uses bounded native-anchored snapshot and disk/index classification where supported. Unsupported handles or bounded overflows escalate durably to full collection sync; neither path should be described as the 5,000-file candidate-discovery benchmark.
- <!-- Updated by plan-sync: gno-27.3 used a Windows path-backed candidate-discovery benchmark, not production full reconciliation -->
- No API/OpenAPI/MCP/schema changes are expected unless implementation evidence contradicts the current contract.

### Acceptance
- [ ] User and developer docs accurately distinguish exact hashing from bounded ambiguous reconciliation and state tested filesystem limits.
- [ ] `CHANGELOG.md` credits `@DanielKillenberger`; no stale or contradictory changed-path/full-reconcile claim remains.
- [ ] README, CLI/spec, status/API, Capsule, and glossary truth are explicitly checked; unchanged artifacts have recorded no-change evidence. Documentation distinguishes the production disk/index fallback from the 5,000-file candidate-discovery proof and retains the Windows path-backed benchmark label.
- [ ] Hosted `gno.sh` copies are updated and locally/live QA-verified according to its repo instructions.
- [ ] `bun run lint:check`, `bun test`, docs verification, the 5,000-file candidate-discovery benchmark, and live watcher smoke pass; remaining evidence is attached to the task/PR.
## Acceptance
- [ ] TBD
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
