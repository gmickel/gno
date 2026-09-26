---
satisfies: [R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13]
---
# fn-178-workspace-wide-wikilink-resolution.1 Implement Workspace-wide wikilink resolution across collections sharing a vault root

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Plain wiki links now resolve across collections that share one link workspace (nearest `.obsidian/` ancestor or a per-collection `workspaceRoot`, `false` to opt out), with Obsidian ranking. Every link consumer (neighbours, backlinks, links, impact, graph export, edge projection, audit) uses one shared resolver. Scope and egress are checked on the resolved identities of every edge. `gno audit --max-findings` accepts `all` or up to 100000, and a SIGINT during piped output no longer truncates JSON.

stage: impl-review - skipped(config: REVIEW_MODE=none; repo and dispatch instructions skip all review stages)

Coverage by requirement:
- R1: test/store/link-workspace-resolution.test.ts covers membership, configured and opted-out collections, and validation errors that name the collection.
- R2 and R3: the same file covers vault-root path links, relative and escaping targets, same-folder and depth tie-breaks, ties that create no edge, and SQL/bulk and insertion-order parity.
- R4: explicit and unknown prefixes and non-workspace collections are tested; the pre-existing link, graph and audit suites pass unchanged.
- R5 and R6: test/store/link-workspace-scope.test.ts covers singleton, plural and empty allowlists, capsule partitioning, backlinks, graph export, the impact bridge case, HTTP MCP egress denial, and explicit partial output.
- R7: test/audit/link-workspace-audit.test.ts.
- R8: test/ingestion/link-workspace-reconciliation.test.ts covers incremental/full parity for add, delete, rename and move, the referrer query, and the reported full rebuild.
- R9: test/cli/piped-audit-output.test.ts, plus a fix for concurrent exit flushes.
- R10: test/audit/report.test.ts and test/cli/commands/audit.test.ts.
- R11: fixture in test/fixtures/link-workspace/.
- R12: repo docs, specs, schemas, skill and gno.sh.

A14 benchmark (25 collections, 50k links, same generated vault; baseline from the base commit):
- Audit snapshot: 176 to 212 ms (1.20x).
- Graph export: about 175 to about 231 ms (1.32x, with about twice as many links now resolving).
- Full projection: 76 s to 0.9 s.
- Peak RSS: 1.21 to 1.31x on snapshot and export; 2.3x on projection.
- Event-loop stall: 76 s to about 330 ms on projection. Snapshot and export stall about 200 to 215 ms, against a baseline of about 160 ms.

Deviations from the A14 budget: graph export exceeds 1.25x; projection memory exceeds 1.25x; the 100 ms stall target is not met by the synchronous snapshot, export and projection paths, and the baseline already missed it.

Maintainer checklist (R13). The spec stays open until the maintainer confirms each item:
- [ ] (a) Update your own agent instructions and retrieval guidance that describe link and graph behaviour (plain links now resolve across collections of one vault; scoped calls stay scoped).
- [ ] (b) Retire local link-hygiene workarounds that compensate for collection-scoped resolution, and point link-integrity routines at `gno audit links --json --max-findings all`.
- [ ] (c) Re-run a full `gno audit links` on your multi-collection vault after the first post-upgrade `gno update`, and compare it against the pre-release baseline.
- [ ] (d) Publish the public docs site changes and the packaged agent skill text (re-run the skill evaluation; its harness was not available in this environment).
## Evidence
- Commits: 550492914a2713fc11eba672aaa5455527a244f2, 53b215ddfb3fcf9c33e795116edf72c5672892a0, 148a614113af8b6f0da3fda0581de61c35f49ff8, 2acbb1fc672f0eceeec91b4fe51a9d507b6487b0, 15d22fb70315599ed5167eceb12b3d9e541b7cf7, b3c46052e7766582b6ee000128b8c1e1a5ce7722, 54fdbe2a59a5f8b6f3cb13ee9c18c60873934b55
- Tests: baseline: green (bun test 5818 pass, 3 skip, 0 fail), TMPDIR=/home/gordon/.cache/gno-test-tmp/fn-178 mise exec bun@1.4.2 -- bun test (5856 pass, 3 skip, 0 fail), mise exec bun@1.4.2 -- bun run lint:check, mise exec bun@1.4.2 -- bun run docs:verify (15 passed, 2 skipped: no embed model), gno.sh: bun run check; bun run typecheck; bun run test (431 passed), live QA: CLI, REST (gno serve), MCP stdio, Web UI 390/1440, gno.sh dev 390/1440; evidence in .flow/tmp/qa-fn-178-workspace-wide-wikilink-resolution/
- PRs: