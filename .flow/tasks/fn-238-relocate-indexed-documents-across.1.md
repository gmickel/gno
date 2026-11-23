---
satisfies: [R1, R2, R3, R4, R5, R6, R7]
---
# fn-238-relocate-indexed-documents-across.1 Implement Relocate indexed documents across collections

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
`gno collection move` relocates indexed documents to another collection and/or path without re-ingestion: a store operation (`relocateDocument`) moves the row by id after an optimistic match, updates collection/path/URI/FTS filepath and journals a `rename` in both collections under the stricter egress lineage; the ingestion layer (`SyncService.relocateDocuments`) refuses anything `gno update` would not treat as unchanged (bytes, conversion, chunk policy, language, records, memory collections, aliases, copies, collisions, ambiguity, unproven availability), re-derives path-dependent metadata and links from the stored mirror, reconverts only when the filename changes (title-change invalidates owners), batches writes 50 per transaction and re-projects the graph once. CLI supports a document, a folder prefix or a `--from-file` TSV map, `--dry-run`, `--json` (`collection-move@1.0`), and the write lease. Docs, spec, skill reference, completion, changelog and `bun run bench:relocation` added.

Bench (synthetic, constant vectors): 100 converted .xlsx + 1 doc: ingest 97.27 s and 23,302 vectors pending, relocate 0.20 s and 0 pending. 10,000 Markdown docs without links: 12.99 s vs 10.57 s (0 vs 20,000 pending). With chained links, both arms are dominated by the existing graph projection (5,000 docs: 116.9 s vs 96.5 s).

Decisions: `OVERRIDDEN:` not applicable; round-2 findings #1 (language) and #2 (local root listing) fixed after the terminal re-review, #3 fixed for missing indexes and declined for migrations on open (every GNO command migrates on open). Not re-reviewed after those fixes.

stage: impl-review - ran [round 1 NEEDS_WORK (3 draws, 7 kept findings, all fixed) .. round 2 NEEDS_WORK (3 findings; fixed after review, not re-reviewed)] (model: gpt-6.2-sol)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 90c010cc5aa92324c27ed9868e1ad67e983f3319, da7a528c715c614a3d42ec9376049847a83edc61, 8e1d22a1437f5c5e16896ed2195ba270abba857b, 094b0dabb09a40979a1ae98b3b3df7bae60d5669, ba9d12caf440e326ff0d5114960f3f1d44b208b7
- Tests: bun run test:tmp-check (6572 pass, 0 fail); bun test test/ingestion test/cli/collection-move.test.ts test/spec/schemas; bun run lint:check; bun run typecheck; bun run docs:verify
- PRs: