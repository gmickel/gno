---
satisfies: [R1, R2]
---

## Description

Add per-vector embedding fingerprint metadata to the vector freshness contract. This task owns schema/migration, vector row contracts, vector writes, backlog/readiness SQL, and focused tests. Keep legacy empty-fingerprint rows readable; treat them as not current unless a later task explicitly adopts them.

**Size:** M
**Files:** `src/store/migrations/*`, `src/store/vector/types.ts`, `src/store/vector/stats.ts`, `src/store/vector/sqlite-vec.ts`, `src/store/sqlite/adapter.ts`, `src/embed/backlog.ts`, `src/cli/commands/embed.ts`, `spec/db/schema.sql`, `test/store/vector/*.test.ts`, `test/store/adapter.test.ts`

## Approach

- Extend the existing `content_vectors` table from `src/store/migrations/001-initial.ts:135`; do not add a sidecar vector freshness table unless the migration proves unsafe.
- Add an explicit fingerprint helper/contract near the existing vector or embedding compatibility seams. Signature-level shape only: `getEmbeddingFingerprint(input): string`.
- Include resolved model URI, dimensions when known, embedding compatibility/profile identity, contextual formatting version, and chunking strategy/version in fingerprint inputs.
- Extend `VectorRow` and `VectorStatsPort` from `src/store/vector/types.ts:14` and `src/store/vector/types.ts:108` so callers pass fingerprint explicitly.
- Update backlog SQL in `src/store/vector/stats.ts:66` and status/readiness SQL in `src/store/sqlite/adapter.ts:3100` so CLI/web/SDK/MCP readiness agree.
- Update vector upserts in `src/store/vector/sqlite-vec.ts:118`; preserve current storage-first behavior before vec0 writes.

## Investigation targets

**Required**

- `src/store/migrations/001-initial.ts:135` — current `content_vectors` schema.
- `src/store/vector/types.ts:14` — vector row and stats port contracts.
- `src/store/vector/stats.ts:66` — backlog freshness SQL.
- `src/store/vector/sqlite-vec.ts:118` — current vector upsert path.
- `src/store/sqlite/adapter.ts:3100` — top-level status/readiness counts.
- `test/store/vector/stats.test.ts:159` — stale-vector backlog tests.
- `test/store/adapter.test.ts:1089` — status/backlog count tests.

**Optional**

- `docs/CONFIGURATION.md:262` — existing re-embed semantics for changed model/profile behavior.

## Key context

Current primary key is `(mirror_hash, seq, model)`. If implementation wants multiple same-model fingerprints to coexist, it must explicitly decide whether to change the key or continue replacing same-model rows while using fingerprint for freshness diagnostics. Default preference: avoid PK churn unless tests show it is required.

## Acceptance

- [ ] `content_vectors` stores `embed_fingerprint` for new and migrated databases, with index coverage for freshness queries.
- [ ] Vector writes populate fingerprint without breaking vec0 sync/rebuild behavior.
- [ ] Backlog count/get queries require exact model+fingerprint freshness.
- [ ] Top-level status/readiness counts use the same freshness contract as vector stats.
- [ ] Legacy empty-fingerprint rows remain readable and are treated as not current.
- [ ] `spec/db/schema.sql` matches the implemented schema.
- [ ] Tests cover fresh, stale timestamp, stale fingerprint, mixed fingerprint, and legacy empty-fingerprint cases.

## Done summary

Added vector embedding fingerprints to the DB freshness contract, vector writes, backlog/status counts, and DB spec. Tests cover fresh vectors, stale timestamps, stale/mixed fingerprints, and legacy empty-fingerprint rows.

## Evidence

- Commits: 0fb89eec272d0826f3d3abc39cedd32ee5e0df66
- Tests: bun run lint:check, bun test test/store/vector/stats.test.ts test/store/vector/sqlite-vec.test.ts test/store/adapter.test.ts test/store/migrations.test.ts test/embed/backlog.test.ts test/spec/schemas/status.test.ts, bun test, bun run docs:verify
- PRs:
