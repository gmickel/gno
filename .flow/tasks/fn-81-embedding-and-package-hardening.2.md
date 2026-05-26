---
satisfies: [R3, R6]
---

<!-- Updated by plan-sync: fn-81-embedding-and-package-hardening.1 shipped src/store/vector/freshness.ts and src/store/migrations/008-vector-fingerprints.ts, not only the older inline seams -->

## Description

Expose fingerprint freshness through `gno doctor` and update the affected CLI/schema/docs contracts. This task depends on the fingerprint storage contract from task 1 and should keep `gno status` lightweight.

**Size:** M
**Files:** `src/cli/commands/doctor.ts`, `src/embed/fingerprint.ts`, `src/store/vector/freshness.ts`, `src/store/sqlite/adapter.ts`, `spec/output-schemas/doctor.schema.json`, `spec/cli.md`, `docs/CLI.md`, `docs/TROUBLESHOOTING.md`, `docs/INSTALLATION.md`, `README.md`, `CHANGELOG.md`, `test/spec/schemas/*`, `test/cli/*`

## Approach

- Extend the existing doctor result assembly in `src/cli/commands/doctor.ts:314` and terminal/JSON formatters in `src/cli/commands/doctor.ts:370` and `src/cli/commands/doctor.ts:420`.
- Reuse the shipped fingerprint helpers from `src/embed/fingerprint.ts:17` and `src/store/vector/freshness.ts:26`; do not fork a second “current fingerprint” calculation inside doctor.
- Reuse the fingerprint-aware readiness counts already wired into `src/store/sqlite/adapter.ts:3076` so `gno doctor` and `gno status` stay consistent while `gno status` remains lightweight.
- Report stale, legacy, and mixed fingerprint states as `warn` by default, not `error`, unless the implementation finds a true runtime inability to search/embed.
- Keep the JSON shape additive under the current doctor schema unless schema tests prove a version bump is needed.
- Add or extend contract tests for doctor JSON; use the status schema test pattern at `test/spec/schemas/status.test.ts:1`.
- Update docs where behavior changes are visible; do not over-document internals in quickstart-style docs.

## Investigation targets

**Required**

- `src/cli/commands/doctor.ts:314` — doctor assembly.
- `src/cli/commands/doctor.ts:370` — terminal formatting.
- `src/embed/fingerprint.ts:17` — canonical fingerprint helper/shape.
- `src/store/vector/freshness.ts:26` — stored/current fingerprint helper.
- `src/store/sqlite/adapter.ts:3076` — fingerprint-aware status/readiness counts.
- `spec/output-schemas/doctor.schema.json:1` — JSON schema.
- `spec/cli.md:1146` — doctor CLI contract.
- `docs/CLI.md:887` — doctor user docs.
- `docs/TROUBLESHOOTING.md:478` — embed failure/stale-vector guidance.
- `docs/INSTALLATION.md:182` — doctor JSON example.

**Optional**

- `README.md:104` — upgrade/migration summary.
- `docs/ARCHITECTURE.md:159` — storage table overview if it would otherwise drift.

## Key context

Doctor should be the richer diagnostic surface. `gno status` should consume fingerprint-aware readiness from task 1 but should not import native model code or perform device/model probing.

## Acceptance

- [ ] `gno doctor` terminal output includes current fingerprint, stale/pending count, legacy empty-fingerprint count, and mixed fingerprint groups.
- [ ] `gno doctor --json` exposes stable machine-readable fingerprint details and validates against schema tests.
- [ ] Stale/legacy/mixed fingerprint diagnostics are warnings with clear `gno embed` or `gno embed --force` recovery guidance.
- [ ] `gno status` remains lightweight and does not add native model probing.
- [ ] `spec/cli.md`, `spec/output-schemas/doctor.schema.json`, user docs, and changelog/docs release notes match the implemented behavior.

## Done summary

_Not started._

## Evidence

_Not started._
