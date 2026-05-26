# Embedding and package hardening

## Overview
GNO should make embedding freshness explicit, recover transient embedding failures in the same run, and prove the published package shape before release. The current system already has model-aware vector rows, shared embedding recovery, `gno doctor`, and a publish-workflow package smoke. This plan turns those pieces into durable release hardening.

Stakeholders:
- **End users:** clearer `gno doctor` guidance, hosted docs that match behavior, and fewer rerun-only embed failures.
- **Developers:** a stricter vector freshness contract and package smoke command.
- **Operations:** a local release gate plus hosted docs/deploy verification that mirrors packed install behavior instead of relying only on CI.

## Scope
- Add per-vector embedding fingerprints to `content_vectors` freshness checks.
- Make shared and CLI embedding loops retry transient failed chunks within the same command run.
- Add a deterministic packed-package smoke script and wire it into release verification.
- Update specs/docs for changed CLI, DB, doctor JSON, troubleshooting, and release gates.
- Update and deploy canonical hosted website docs in `/Users/gordon/work/gno.sh` for every user-facing change in this spec.

## Approach
### Vector freshness
Extend the existing vector storage path rather than adding another store. The seam is `content_vectors` in `src/store/migrations/001-initial.ts:135`, `VectorRow` / `VectorStatsPort` in `src/store/vector/types.ts:14`, and backlog SQL in `src/store/vector/stats.ts:66`.

Use a compact fingerprint helper with a signature like:

```ts
getEmbeddingFingerprint(input: EmbeddingFingerprintInput): string
```

The fingerprint should cover resolved model URI, dimensions when known, embedding compatibility/profile identity, contextual formatting version, and chunking strategy/version. Backlog queries should require exact `(model, embed_fingerprint)` freshness while preserving legacy empty-fingerprint rows as reportable/pending until migrated or re-embedded.

Short SQL pattern:

```sql
AND v.model = ?
AND v.embed_fingerprint = ?
AND v.embedded_at >= c.created_at
```

### Retry behavior
Reuse `embedTextsWithRecovery()` in `src/embed/batch.ts:56`. Add bounded retry state around existing cursor loops instead of putting failed rows back into the hot cursor path. The shared path starts at `src/embed/backlog.ts:54`; the CLI still has a separate embed loop around `src/cli/commands/embed.ts:596`, so both must align.

Retry state should be in-memory, capped per chunk, and drained after later progress or at the end of fresh backlog processing. Non-transient failures should still surface as final errors with actionable verbose/debug guidance.

### Doctor and docs
Extend `gno doctor` in `src/cli/commands/doctor.ts:314` with fingerprint diagnostics. Update the JSON contract in `spec/output-schemas/doctor.schema.json:1` and CLI contract in `spec/cli.md:1146`. Keep `gno status` lightweight.

### Package smoke
Create `bun run test:package` as a local tarball-first smoke. Reuse the command-runner/isolation style from `desktop/electrobun-shell/scripts/verify-packaged-runtime.ts:62`, but target the CLI package shape in `package.json:28` and current publish smoke in `.github/workflows/publish.yml:217`.

Use packed installs, isolated `HOME`/`GNO_HOME`/cache dirs, and fatal `gno --version` + `gno doctor --json` checks. Optional model-heavy checks should skip clearly when no cache/runtime is present.

### Hosted website
Hosted docs are a release blocker for this spec, not follow-up polish. Any shipped user-facing behavior, CLI output, troubleshooting flow, install guidance, release gate, or FAQ/product claim changed by this work must be reflected in `/Users/gordon/work/gno.sh` in the same delivery path.

Rules:
- Do not mark the spec complete, release/tag, or hand off as “done” while `/Users/gordon/work/gno.sh` is stale for shipped behavior.
- Do not rely on this repo's legacy `website/` directory as production documentation.
- The website task should compare in-repo docs/spec changes against `gno.sh` pages and update every affected public page, not just obvious reference docs.
- If website changes are not deployed in the same work session, the blocker and exact missing deploy step must remain explicit in task evidence.
- When deployed, verify live `https://gno.sh`, service health, and remote revision.

## Quick commands
```bash
bun test test/store/vector/stats.test.ts test/store/vector/sqlite-vec.test.ts test/embed/backlog.test.ts
bun test test/cli/smoke.test.ts test/spec/schemas/status.test.ts
bun run test:package
bun run docs:verify
bun run lint:check && bun test
cd /Users/gordon/work/gno.sh && bun run build
cd /Users/gordon/work/gno.sh && DEPLOY_HOST=root@178.104.180.89 ./scripts/deploy-prod.sh
curl -fsSI https://gno.sh
ssh root@178.104.180.89 "systemctl is-active gno-sh && cd /srv/gno-sh/repo && git rev-parse --short HEAD"
```

## Boundaries / non-goals
- No default embedding model change.
- No second vector database backend.
- No full desktop packaging smoke in this spec.
- No required model downloads in default package smoke.
- No broad rewrite of `gno doctor`, `gno status`, or embedding commands.
- No stale installed skill-stub work in this spec.

## Decision context
Fingerprinting per vector row is the smallest reliable way to distinguish “same model URI, different embedding semantics” from fresh vectors. Treating mismatches as pending avoids destructive migrations and keeps recovery observable. Retrying failed chunks outside the forward cursor preserves current seek-pagination safety while reducing rerun-only failures. A tarball-first package smoke closes the gap between repo-local tests and what users install. The hosted website task is explicit and blocking because GNO’s production docs live in `/Users/gordon/work/gno.sh`, not this repo's legacy website tree; stale hosted docs create user-visible drift immediately.

Dependencies and overlaps:
- Depends on completed `fn-70-embedding-compatibility-and-query-batching` for embedding profiles, formatter behavior, and batch recovery seams.
- Depends on completed `fn-67-evaluate-qwen3-embedding-06b-gguf-for` for re-embed semantics and collection-scoped vector cleanup precedent.
- Depends on completed `fn-73-gno-runtime-hardening` for doctor/runtime guidance and vector diagnostics precedent.
- Depends on completed `fn-74-upstream-freshness-and-code-retrieval` for dependency/runtime freshness policy.
- `fn-57-mac-and-linux-packaging-matrix-and` can consume `test:package` later for broader packaging proof.

## Acceptance
- **R1:** `content_vectors` has an `embed_fingerprint` column, useful index coverage, migration coverage, and matching updates in `spec/db/schema.sql`.
- **R2:** New vector writes, backlog count/get queries, and embedded-count/status paths use exact model+fingerprint freshness while keeping legacy empty-fingerprint rows readable and non-destructive.
- **R3:** `gno doctor` terminal and JSON output report current fingerprint, stale/pending count, legacy empty-fingerprint count, and mixed fingerprint groups without making `gno status` probe native models.
- **R4:** Shared embedding backlog and CLI embedding both retry transient failed chunks within the same command run, cap retries, and report permanent failures clearly.
- **R5:** `bun run test:package` packs GNO, installs from the tarball in isolated temp layouts, verifies package contents, and treats `gno --version` plus `gno doctor --json` failures as real failures.
- **R6:** User-facing docs, CLI/spec contracts, troubleshooting, packaging/release guidance, and changelog entries are updated when behavior changes.
- **R7:** `/Users/gordon/work/gno.sh` hosted website docs are updated in the same delivery path for all user-facing changes, and the spec is not complete until the hosted site is deployed/verified or the exact blocker is documented in Flow evidence.

## Early proof point
Task `fn-81-embedding-and-package-hardening.1` proves the core model: existing vector rows can carry fingerprint freshness without breaking old DBs or vector search writes. If it fails, reconsider whether fingerprint metadata belongs in `content_vectors` or in a sidecar freshness table before continuing downstream tasks.

## Requirement coverage
| Req | Description | Task(s) | Gap justification |
|-----|-------------|---------|-------------------|
| R1 | Vector schema and DB contract include fingerprints | fn-81-embedding-and-package-hardening.1 | — |
| R2 | Vector writes/backlog/status use exact fingerprint freshness | fn-81-embedding-and-package-hardening.1 | — |
| R3 | Doctor terminal/JSON reports fingerprint health | fn-81-embedding-and-package-hardening.2 | — |
| R4 | Same-run embed retry in shared and CLI paths | fn-81-embedding-and-package-hardening.3 | — |
| R5 | Local packed-package smoke gate exists and fails loudly | fn-81-embedding-and-package-hardening.4 | — |
| R6 | Specs/docs/release guidance match behavior | fn-81-embedding-and-package-hardening.2, fn-81-embedding-and-package-hardening.4 | — |
| R7 | Hosted website docs/deploy match shipped behavior | fn-81-embedding-and-package-hardening.5 | — |

## References
- `src/store/migrations/001-initial.ts:135` — current `content_vectors` schema.
- `src/store/vector/types.ts:14` — vector row and stats port contracts.
- `src/store/vector/stats.ts:66` — current backlog freshness SQL.
- `src/store/vector/sqlite-vec.ts:118` — current vector upsert statement.
- `src/embed/backlog.ts:54` — shared backlog processor.
- `src/cli/commands/embed.ts:596` — CLI embed loop that must align with shared retry behavior.
- `src/embed/batch.ts:56` — existing embedding batch recovery helper.
- `src/cli/commands/doctor.ts:314` — doctor result assembly.
- `spec/output-schemas/doctor.schema.json:1` — doctor JSON contract.
- `.github/workflows/publish.yml:217` — current package smoke baseline.
- `desktop/electrobun-shell/scripts/verify-packaged-runtime.ts:62` — isolated command-runner pattern.
- `docs/PACKAGING.md:170` — verification minimums.
- `AGENTS.md:383` — hosted website docs requirement.
- `AGENTS.md:389` — canonical hosted website repo.
- `/Users/gordon/work/gno.sh` — canonical hosted website repo.
