---
satisfies: [R1, R5]
---
# fn-135-memory-adapters-openclaw-backend-hermes.1 Hermes memory provider (external plugin)

## Description
Hermes memory provider (external plugin). **Size:** M. **Files/Touches:** NEW external plugin artifact per Hermes plugins/memory layout; docs/MEMORY.md gains ONLY the "Hermes provider" subsection (task 2 and 3 own their own doc regions — no shared-file edits outside the named subsection).
Interface facts (from plan review, binding): Hermes calls `sync_turn` after EVERY completed turn to persist conversation — a literal remember-on-sync_turn violates no-ambient-store; therefore: prefetch → gno recall (turn query + scopes from provider config); explicit store ops exposed via `get_tool_schemas()` / `handle_tool_call()` (a remember tool the model invokes deliberately, with add/supersede inputs); sync_turn = no-op for GNO writes (conversation persistence left to Hermes's own store or disabled per config). Identity mapping: provider config declares caller id; session id from Hermes's turn context → fn-130's caller/session fields. Version-pin minimum GNO; subprocess failure/timeout/malformed-JSON handling explicit. PACKAGING (binding): plugin lives in the gno repo under integrations/hermes-gno-memory/ with its own manifest/entry point per Hermes's plugin layout, a README with exact install commands, and deterministic unit tests (faked gno subprocess: output mapping, timeout, malformed JSON, below-min version, default-no-write) runnable via bun test — live ivan checks are the E2E layer on top, not the only evidence. Record fn-134 eval-green evidence at task start (R5).

**Touches:** integrations/hermes-gno-memory/** (new), docs/MEMORY.md (Hermes subsection — this task is the ONLY fn-135 task touching docs/MEMORY.md in its own change; later tasks append via their own dependent changes)

## Acceptance
- [ ] Scripted Hermes session on ivan: prefetch injects recalled facts; explicit tool call stores a fact via remember; a full session with NO explicit call writes NOTHING (ambient-store negative test)
- [ ] Malformed/missing GNO handled: below-min version and gno-not-found produce clear provider errors, session continues without memory
- [ ] add/supersede inputs mapped and live-verified; scopes come from provider config only
- [ ] docs/MEMORY.md Hermes subsection added (only that region touched)

- [ ] Deterministic unit suite green (faked subprocess cases above)
- [ ] fn-134 gate evidence recorded at start

## Done summary
Built the Hermes memory provider as an external plugin at `integrations/hermes-gno-memory/gno/` (verified against Hermes v0.20.5 on ivan): `prefetch` runs `gno recall --json` with the turn query and config scopes, the model-invoked `gno_remember` tool runs `gno remember --json` with propose/add/supersede, and `sync_turn` performs no GNO writes. Caller comes from provider config, session from the Hermes session id; GNO is pinned at 1.41.0 with clear errors for gno-not-found, timeout, malformed JSON, below-min version; a deterministic `bun test` suite (18 cases, faked gno subprocess) and a README with exact install commands ship with it; docs/MEMORY.md gained only the "Hermes provider" subsection.

Live E2E on ivan (gno 1.42.0 >= 1.41.0, no upgrade needed; transcripts at /tmp/fn-135.1-e2e/): session 1 explicit `gno_remember` add wrote one fact (caller `hermes:ivan`, session `20260903_115247_3cabb8`); session 3 with no explicit call wrote nothing (fact count 1 -> 1, recall of the mentioned text returned 0 facts); session 4 live supersede produced a successor carrying `supersedes`; session 2b prefetch injected the fact (`GNO - recalled 1 memory` status line, answer `amber-otter-42`, `<memory-context>` persisted as `api_content`).

Dogfood finding: the first prefetch session injected nothing because recall's BM25 leg is AND-semantics and the collection had no vectors; after `gno embed hermes-memory` hybrid recall returned the fact for question-shaped turns. The provider now logs a one-time warning while recall reports `mode: lexical`, and README/MEMORY.md tell operators to embed the collection. Follow-ups outside this task's Touches: (1) recall's lexical leg should use `anyTerm` so question-shaped queries work without vectors (src/core/memory-recall.ts / searchBm25); (2) docs/MEMORY.md "What memory does not do" still says "No harness adapters" - stale now, outside the permitted subsection; (3) one transient `GGML_ASSERT(buft)` native crash from node-llama-cpp Metal on a direct `gno recall` on ivan (3/3 re-probes clean).

Host changes on ivan (all reversible, recorded): backups `~/.hermes/config.yaml.bak-fn135-20260903T115227` and `~/Library/Application Support/gno/config/index.yml.bak-fn135-20260903T115227`; added memoryManaged collection `hermes-memory` at `~/gno-hermes-memory` (index.yml rewritten block-style by PyYAML, content-equivalent; 2 fact files + embeddings now present); wrote `~/.hermes/gno/config.json` (scopes `hermes-e2e`, caller `hermes:ivan`); installed `~/.hermes/plugins/gno/`; `memory.provider` was set to `gno` for the sessions and restored via `hermes memory off` (config.yaml diff vs backup: empty). SOUL.md untouched. Full revert: `rm -r ~/.hermes/plugins/gno ~/.hermes/gno ~/gno-hermes-memory` and restore index.yml from its backup.

Staging note: committed with explicit paths (`git add integrations docs/MEMORY.md`) instead of `git add -A` because the checkout carries pre-existing untracked `.flow/artifacts/*` directories the conductor forbade touching.

baseline: green (bun test 4699 pass, lint:check clean, eval:memory 100% at threshold 100)
fn-134 gate evidence (R5): `bun run eval:memory` at task start -> Score 100%, Threshold 100% (passed), 19 evals, log /tmp/fn-135.1-e2e/eval-memory-baseline.log

stage: impl-review - skipped(config: REVIEW_MODE=none)
## Evidence
- Commits: c6b64bfddd073d28e1d7c87e05dd73144e80eefd
- Tests: bun run eval:memory (fn-134 gate, R5: score 100% / threshold 100%, 19 evals, passed), bun test integrations/hermes-gno-memory (18 pass, faked gno subprocess), bun test (4717 pass, 2 skip, 0 fail; receipt .flow/tmp/green-receipts/c6b64bfd-unittest.json), bun run lint:check (clean), ivan E2E: hermes chat sessions 20260903_115247_3cabb8 (explicit remember), 20260903_115339_ccedbb (ambient negative, 0 writes), 20260903_115349_5abd1c (live supersede), 20260903_115605_ce5d62 (prefetch injection, api_content <memory-context>); transcripts /tmp/fn-135.1-e2e/
- PRs:
stage: plan-sync - skipped(config: planSync.enabled != true)
