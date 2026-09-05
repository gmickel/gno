# Skill clarification and fresh final evaluation

**47/47 checks, 20/20 scenarios, 100.0%.** The complete unchanged20-scenario evaluator was run against20 newly generated Astra-medium responses after a minimal truthful skill clarification. One response per scenario; no retries or coaching. The earlier46/47 run remains immutable in sibling final-skill-eval/.

## Root cause and change

src/core/peek.ts declares and returns only document and collection counts. It reports backlog/liveness, but no total chunk count. src/cli/commands/status.ts returns totalChunks, per-collection chunkCount, totalDocuments and healthy; MCP status also formats health and chunk counts. The old skill's broad “index counts” and “heavy health” routing made the status scenario ambiguous. Its prior response, gno peek --json, failed the existing uses_status check and did not supply the requested chunk totals. That failure is not reclassified.

Only the snapshot paragraph, MCP decision step and adjacent tool bullets changed: peek serves document/collection counts, backlog, serve liveness and recent files; chunk totals or index health use gno status --json / gno_status. All other guidance remains. Exact repository diff is skill.diff; source inspections and hashes are recorded in clarification-evidence.json. Formatting check passed.

New skill SHA256: b065b43ad65ab83aa4dc90421ad99e65a0ec93694c49f99ad66d61bed4a196d5.
Prior failed-run skill SHA256:78d946003b7ab9ea306aead6784b316b9b6cbbd2572d41f4283a1645b1f4bf3a.
Evaluator SHA256 unchanged:a1f30d1be734e9aee46a4e868b57a691882acb6df48ebcf2d72b8c4b252a35da.

## Generation and scoring

Each fresh default agent used gpt-6-astra, medium reasoning, fork_turns none, maximum4 active children. Each received only the instruction to read its exact prompt and return command blocks without executing them or reading other files. The prompt contains the unchanged original SYSTEM_PROMPT/scenario plus the new complete skill snapshot. Expected checks, other outputs and repository history were not supplied. Native inherited harness instructions/tools remain present, so this is the same declared native-Astra stratum, not standard Haiku transport.

replay.py verifies evaluator hash and exact original main() prompt equality before feeding each fresh final response into original main() and run_checks(). Parser selftests passed; current repository skill matched snapshot. The status response is now gno status --json. Every original scenario/check outcome appears in results.json and score.stderr.log. Responses are transcribed verbatim with a terminal newline. No generated command was executed.

Scoring command: python3 .flow/artifacts/fn-146-cancellation-and-bounded-background/final-skill-eval-status-clarification/replay.py

## Experiment workflow

The existing /home/gordon/work/autoresearch-experiments/gno-skill/skill.md was clean but older than the repository skill. Its complete pre-sync bytes are retained as experiment-prior.skill.md (SHA81b406b6d9678f45943eda70bc4f1d98841b4798a7d6d1cb93e86931866c3e9e). After the fresh100% run, cleanliness and prior hash were rechecked, then the winning snapshot was synced there. Experiment and repository skill bytes now match exactly. Evaluator/scenarios/checks were never edited. Git commits, pushes, and global skill installation remain host-owned and were not performed.

All48 checksum targets in the prior failed-run subtree still match; its46/47 result remains intact. This sibling stores the new snapshot, exact20 prompts, fresh20 responses, generation ledger, original aggregate/per-check output, replay adapter, source/diff evidence and SHA256SUMS.json.

## Limits

This measures the existing command-generation scenarios, mostly regex checks. It does not execute generated commands or prove cancellation, native correctness, full CLI/MCP coverage, or final2.0 acceptance. The two single-response sets are not a statistical reliability estimate. A later skill change requires a new snapshot evaluation.

## All scenario results

| Scenario | Passed / checks |
| --- | --- |
| basic_keyword_search | 3 / 3 |
| semantic_search | 2 / 2 |
| best_quality_search | 2 / 2 |
| search_no_results_retry | 2 / 2 |
| collection_filtered_search | 3 / 3 |
| tag_filtered_search | 2 / 2 |
| get_document_by_uri | 2 / 2 |
| get_document_lines | 3 / 3 |
| search_then_get_pipeline | 3 / 3 |
| index_new_folder | 3 / 3 |
| ask_with_answer | 3 / 3 |
| find_backlinks | 2 / 2 |
| find_similar_docs | 3 / 3 |
| check_status | 1 / 1 |
| json_output_for_scripting | 3 / 3 |
| date_filtered_search | 2 / 2 |
| exclude_filter | 2 / 2 |
| intent_disambiguation | 2 / 2 |
| structured_query_mode | 3 / 3 |
| reindex_after_changes | 1 / 1 |
