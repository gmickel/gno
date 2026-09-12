---
satisfies: [R1, R6, R7]
---
# fn-166-configurable-index-chunking.4 Documentation and reproducible compatibility evidence

## Description
Complete R1/R6/R7 documentation and retained verification across GNO and its hosted docs. The host owns documentation reconciliation, final tests, QA, commits, publication, and release decisions.

**Size:** M
**Files:** docs/CONFIGURATION.md, docs/CLI.md, docs/API.md, docs/MCP.md, docs/SDK.md, docs/ARCHITECTURE.md if needed, CHANGELOG.md, assets/skill references if eval requires them, /home/gordon/work/gno.sh/src/lib/gno-docs.tsx in its isolated feature worktree; temporary compatibility/QA scripts and receipts.
**Touches:** [docs/**, CHANGELOG.md, assets/skill/**, test/ingestion/**, test/config/**, test/spec/**, scripts/**, .flow/artifacts/fn-166-configurable-index-chunking/**]

### Approach
- Document actual config bounds and fraction units, optional/partial defaults, no-work upgrade, index-wide cached rechunking even during targeted source refresh, source freshness distinction, sync-only embedding backlog, stale-client reopen guidance, and index/config isolation. Preserve historical ADR-003 and the retired website directory.
- Put a reproducible two-index/two-config example in the configuration guide. Hold corpus/model/query/type-boost inputs fixed and report observed differences without a quality promise. Use a small synthetic Markdown corpus for runnable evidence.
- Update hosted config/CLI/API/MCP/SDK docs in /home/gordon/work/gno.sh/.worktrees/fn-166-configurable-index-chunking/src/lib/gno-docs.tsx. No new page is needed. Use existing semantic JSX so Markdown twins remain correct.
- Re-run the existing skill autoresearch evaluation from ~/repos/autoresearch-gno-skill under repository instructions; host reviews any winning skill reconciliation before installation. Do not edit behavioral global guidance.
- Host compares retained pre-feature artifacts in /tmp/gno-fn166-compatibility against this branch: exact document/chunk/timestamp hashes, four search result sets, seven repeat-sync timings. Preserve original baseline files. Add meaningful permanent regression coverage only for missed behavior.
- Run full required GNO gates plus relevant hybrid eval and packed real-model smoke; then Flow live QA on CLI/SDK/MCP/REST policy transitions. Run site check/typecheck/test/build plus local desktop/mobile navigation and copy-button checks. Reverify hosted changed pages after authorized merge/deploy.

### Investigation targets
**Required:**
- docs/CONFIGURATION.md
- docs/CLI.md
- spec/output-schemas/status.schema.json
- .github/CONTRIBUTING.md
- assets/skill/SKILL.md
**Optional:**
- /home/gordon/work/gno.sh/AGENTS.md
- /home/gordon/work/gno.sh/src/lib/gno-docs.tsx

### Quick commands
GNO: bun run lint:check; bun test; bun run docs:verify; bun run verify:clipper-package; bun run test:package; bun run eval:hybrid. Hosted site: bun run check; bun run typecheck; bun run test; bun run build. Use Bun 1.4.2 and isolated data/config/cache roots.

## Acceptance
- [ ] Documentation and hosted Markdown/HTML twins describe the shipped behavior and verified commands.
- [ ] Default-upgrade evidence preserves the recorded 75 documents/289 chunks and search results, with no unnecessary embedding work or unexplained material indexing overhead.
- [ ] Separate-policy comparison has retained inputs/configs/results and repeatability evidence.
- [ ] Required tests, packed smoke, skill eval and driven CLI/MCP/REST/SDK/site QA have honest receipts; blockers are explicit and no source-only QA claim is made.
- [ ] CHANGELOG records the general feature and no-change default guarantee without research-outcome claims.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
