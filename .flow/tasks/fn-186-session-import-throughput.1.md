---
satisfies: [R1, R2, R3, R4]
---
# fn-186-session-import-throughput.1 Implement Session import throughput

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Session import (and every record-collection sync) now scales linearly. Four queries on the shared record-sync path scanned the whole index for each record or file, because without sqlite_stat1 statistics SQLite's planner chose idx_documents_active, a collection-wide autoindex walk or a reverse rowid walk. Each query now names its selective index with INDEXED BY: the legacy-vector title lookup and FTS owner lookup use idx_documents_mirror_hash, listRecordDocuments uses idx_documents_record_source_path, and the change-journal age cutoff uses idx_document_changes_retention.

The benchmark is scripts/session-import-benchmark.ts (`bun run bench:session-import`), with synthetic Codex corpora of 30, 90 and 300 threads x 200 turns. 90 threads: 1625.1 s -> 46.8 s (34.7x faster). 30 threads: 172.9 s -> 14.5 s. 300 threads: >900 s (capped) -> 168.2 s. The per-turn cost at 300 threads is 1.16x the 30-thread cost. The full table is in the spec's Completion evidence section.

R3: the eval:sessions gold JSONL arm and pipeline index tables, the import receipts and the state.json checkpoints are identical before and after, and eval:sessions scored 100%. R4: both timer-drift tests pass. The full bun test run is green.

Follow-ups, not built: other `x = ? AND active = 1` queries outside the import path (for example the uri lookup in adapter.ts) hit the same planner trap. Peak RSS grows with index size; it is native SQLite memory, and the JS heap is about 10 MB after the import.

Tier: session (intelligent, performance)

stage: impl-review - failed(codex transport: all 3 fan-out draws got 401 Unauthorized from CODEX_HOME=/home/gordon/.codex-instances/sub2-cli on 2 consecutive attempts; no verdict)

stage: impl-review - ran [codex:gpt-6-astra:medium round 1 NEEDS_WORK (benchmark failure labelling, fixed 61b89b5d), round 2 SHIP]
## Evidence
- Commits: 88885a2c323c00515c5a380a9033907d5297383f, d58b936ffa79ca826b561bdac96a4053294e41b2
- Tests: mise exec bun@1.4.2 -- bun test (5791 pass, 2 skip, 0 fail), mise exec bun@1.4.2 -- bun test test/sessions test/serve/sessions-api.test.ts test/ingestion test/store (813 pass), mise exec bun@1.4.2 -- bun test test/serve/sessions-api.test.ts -t "event loop responsive" (2 pass, R4 timer drift), mise exec bun@1.4.2 -- bun run eval:sessions (35 evals, score 100%, threshold 100%), mise exec bun@1.4.2 -- bun run lint:check (0 errors; 40 pre-existing warnings, none in touched files), bun scripts/session-import-benchmark.ts --threads 30,90,300 --turns 200 (before on base 6dfe4dce: 30=172.9s, 90=1625.1s, 300 capped >900s; after: 30=14.5s 2.42ms/turn 256MB, 90=46.8s 2.60ms/turn 441MB, 300=168.2s 2.80ms/turn 1116MB; per-turn 300/30 = 1.16x; 90-thread speedup 34.7x), R3 digest diff (scratch): eval:sessions gold JSONL arm + pipeline index tables, import receipts and state.json checkpoints identical before vs after
- PRs: