---
satisfies: [R4, R5, R6]
---
# fn-100-private-retrieval-learning-loop.4 Export qrels and replay candidate retrieval pipelines

## Description
Deliver canonical qrels export and immutable-receipt replay as one read-only retrieval-learning increment. Extend the task-3 trace management and aggregate-manifest contracts; do not create a parallel persistence path or mutate ranking configuration.

**Size:** L
**Files:** `src/core/retrieval-trace-management.ts`, `src/core/retrieval-trace-management-types.ts`, `src/core/retrieval-trace-management-helpers.ts`, `src/core/retrieval-trace.ts`, `src/core/retrieval-trace-request.ts`, `src/core/retrieval-qrels.ts`, `src/core/retrieval-replay.ts`, `src/core/retrieval-replay-types.ts`, `src/store/types.ts`, `src/store/sqlite/adapter.ts`, `src/store/sqlite/retrieval-trace-management-store.ts`, `src/cli/program.ts`, `src/cli/commands/trace.ts`, `src/cli/commands/replay.ts`, `evals/agentic/trace-import.ts`, `spec/output-schemas/retrieval-trace-qrels.schema.json`, `spec/output-schemas/retrieval-trace-replay.schema.json`, `test/replay/retrieval-qrels.test.ts`, `test/replay/retrieval-replay.test.ts`, `test/evals/agentic/trace-import.test.ts`, `test/cli/trace-replay.test.ts`, `spec/cli.md`, `docs/CLI.md`, `assets/skill/SKILL.md`, and affected hosted documentation in `~/work/gno.sh`

### Approach
- Extend `RetrievalTraceManagementService`, `ExportRetrievalTracesInput`, `ExportRetrievalTracesResult`, `RetrievalTraceArtifact`, and the public `RetrievalTraceExportFormat`. Preserve the existing `agentic-receipt` branch and add typed `qrels` export plus replay operations; keep CLI and any later SDK/REST/MCP adapters thin over the shared service.
- Add a StorePort complete aggregate-read operation that transactionally returns one export manifest and every complete linked trace bundle. Replay and qrels materialization must recover the exact stored `{ exportId, format, artifactHash, sorted traceIds }`, reconstruct the canonical artifact, and require its hash to equal `artifactHash`. A missing manifest, cascaded or shortened link set, missing trace, format conflict, or hash mismatch is unreplayable; bounded `show(..., { detailLimit })` is never a replay input.
- Qrels export accepts immutable terminal traces only. Require `redactionMode: "replay"`, `replayCapable: true`, non-null query text and digest, replay-complete strict filters, at least one retrieval run, and at least one effective `relevant` or `missing_expected` judgment. Reject open, mixed-redaction, incomplete, conflicting, and replay-incompatible inputs before storing an export manifest or writing an artifact.
- Export canonical `RetrievalTraceQrelsArtifact` JSON:
  - `schemaVersion: "1.0"` and `format: "qrels"`.
  - Deterministically ordered `cases[]`, one per persisted retrieval run, with `caseId`, `traceId`, `retrievalRunId`, terminal status, replay query/goal text plus digests, normalized filters, and original pipeline/model/config/index fingerprints.
  - `baseline.ranked[]` retains canonical `gno://` URI, docid, source hash, mirror hash, passage hash, sequence, exact inclusive line range, final rank, planner rank, score, sorted source list, and graph-expansion flag. Final rank and planner rank remain distinct.
  - `baseline.capabilityOutcomes[]` comes from explicit capability events; retrieval-run `capabilities` remains only the used subset. `fallbackCodes` are sorted and deduplicated. `baseline.outcomes` retains exact opened, cited, and pinned evidence.
  - `judgments.history[]` retains judgment ID, label, target kind, content-free target, creation time, and canonical digest. `judgments.effective[]` resolves corrections by the greatest `(createdAtMs, judgmentId)` for the same canonical target key; idempotent retries remain duplicates rather than corrections.
  - `qrels[]` retains qrel ID, explicit label, relevance, target, source judgment ID, and `baselineMissing`. Map `relevant` to relevance `1`, `irrelevant` to `0`, and `missing_expected` to `1` with `baselineMissing: true`. Opened/cited/pinned absence and every unlabeled result remain unjudged, never implicit negatives.
  - Never include source text, mirror text, snippets, or runtime-only symbols such as `SEARCH_RESULT_PLANNER_METADATA` and `CITATION_TRACE_METADATA`.
- Preserve replay-complete filters without inference: canonical sorted/deduplicated collection, tag, category, and exclusion sets; query-mode order; temporal, language, author, intent, graph, URI-prefix, limit, candidate-limit, minimum-score, expansion, and reranking scope. Extract and reuse a strict parser/normalizer rather than accepting arbitrary payload objects.
- Make fn-97 import deterministic without falsifying its answer-oriented oracle:
  - `evals/agentic/trace-import.ts` accepts the qrels artifact plus an injected active-store evidence resolver. It verifies current canonical mirror content, exact line bytes, mirror hash, and passage/span hash, then builds an ephemeral fn-97 `CorpusSnapshot`; exported artifacts never duplicate raw documents.
  - GNO `sourceHash` hashes original source bytes, while fn-97 `EvidenceCoordinate.sourceHash` hashes the exact text corpus. Use verified `mirrorHash` as the fn-97 coordinate/source hash, retain GNO source and mirror hashes in the qrels artifact, and map verified `passageHash` to fn-97 `spanHash`. Reject stale, missing, or unverifiable content.
  - Remap task IDs to `t<7 hex>`, collection IDs to `c<3 hex>`, and evidence URIs to the ephemeral collection deterministically.
  - Split a trace with positive evidence into one scored retrieval task: public required `evidenceSet` string-array claim, hidden expected values from relevant stable identities, relevant exact coordinates as required evidence, and irrelevant exact coordinates as forbidden evidence.
  - Split each `missing_expected` judgment into its own fn-97 missing-evidence task with one required public identifier claim, no oracle claim, the claim key in `expectedMissing`, and `expectAbstention: true`. This split is required because fn-97 scores expected-missing outcomes only under full abstention; never merge positive and missing outcomes into one misleading task.
  - Keep irrelevant-only cases in qrels but mark them `agentic_import_unscorable`; never invent a positive claim. Reject relevant or irrelevant evidence that cannot resolve to URI, mirror hash, exact lines, and passage hash.
- Handle multiple retrieval runs as separate cases. Bind run-scoped judgments by `runId`; copy a null-run `missing_expected` judgment only when the trace has exactly one retrieval run, otherwise fail with `ambiguous_missing_expected_run`.
- Add a pure current-fingerprint builder extracted from trace-request setup. Replay discloses original, current, and candidate pipeline/model/config/index fingerprints; the candidate fingerprint includes the explicit override object. Timings and cache state never participate in canonical identity.
- Replay input is `{ exportId, candidate }`, where candidate includes stable `id`, `type: "bm25" | "vector" | "hybrid"`, and optional limit, candidate limit, expansion, reranking, and query-mode overrides. Load only a verified qrels aggregate. Use persisted ranked evidence as the baseline and run the candidate in memory against the current store. Never create a synthetic baseline, start a new trace, call the config saver, or write boosts, prompts, models, configuration, or user files.
- Match expected evidence by exact source hash when present, then docid, then canonical URI. Report per-source state as `unchanged`, `stale`, `missing`, `inactive`, or `no_indexed_content`. Use `diagnoseQueryTarget` only for structured missing-target diagnosis (`not_found`, `inactive`, `no_indexed_content`, `filtered_out`, stage drop); never parse human-formatted `explain.ts` output.
- Replay reports per-qrel baseline rank, planner rank, candidate rank, delta, opened/cited/pinned outcomes, source state, and diagnosis; aggregate existing retrieval metrics at K. Preserve terminal outcome and capability/fallback truth. Verdict is `improved`, `unchanged`, `regressed`, or `unreplayable`; recommendation is `promote`, `keep_baseline`, or `manual_review`, always with `applied: false`.
- Stable unreplayable reasons include `manifest_missing`, `manifest_hash_mismatch`, `trace_missing`, `redaction_incompatible`, `query_missing`, `filters_incomplete`, `no_retrieval_run`, `ambiguous_missing_expected_run`, `source_stale`, `source_missing`, and `candidate_failed`. Disabled tracing, sub-minimum record caps, retention eviction, logical deletion, and physical purge never become empty successful cases. Keep purge cleanup status separate from logical trace availability.
- Extend the existing CLI group:
  - `gno trace export <trace-id...> --format <agentic-receipt|qrels> [--output <path>] --json`
  - `gno trace replay <qrels-export-id> --candidate <bm25|vector|hybrid> [--limit <n>] [--candidate-limit <n>] [--no-expand] [--no-rerank] [--json|--md]`
  - Preserve current `--output` behavior: atomically write only canonical artifact JSON and emit no stdout. Replay accepts a local export ID, not an arbitrary file that bypasses manifest verification.
- Add contract schemas and tests for canonical order/hash, explicit-label mapping and correction, exact evidence provenance, capabilities/fallbacks, terminal-state distinctions, converted-source hash semantics, fn-97 positive/missing task split, stale/missing/inactive/unindexed states, manifest cascade/hash invalidation, candidate failure, verdicts, no-mutation guarantees, and CLI JSON/Markdown/file behavior.

### Investigation targets
**Required** (read before coding):
- `src/bench/metrics.ts`
- `src/pipeline/diagnose.ts`
- `src/pipeline/explain.ts`
- `src/core/retrieval-trace-management.ts`
- `src/core/retrieval-trace-management-types.ts`
- `src/core/retrieval-trace-management-helpers.ts`
- `src/core/retrieval-trace-session.ts`
- `src/store/sqlite/retrieval-trace-management-store.ts`
- `evals/agentic/types.ts`
- `evals/agentic/canonical.ts`
- `evals/agentic/fixture-db.ts`
- `evals/agentic/scoring.ts`

**Optional** (reference as needed):
- `src/bench/fixture.ts`
- `src/bench/types.ts`
- `src/config/saver.ts` only to assert it is never called
- `research/finetune`

### Planned dependency outputs
- fn-100.2: replay-complete trace headers, exact ranked/evidence provenance, capability events, fallback codes, terminal semantics, and retention behavior.
- fn-100.3: shared management service, explicit append-only labels, aggregate manifests, complete trace store primitives, stable discovery, and truthful delete/purge receipts.
- fn-97: `AgentTask`, `HiddenOracle`, `EvidenceCoordinate`, `CorpusSnapshot`, canonical hash helpers, schemas, and scoring semantics consumed through `evals/agentic/trace-import.ts`.
## Acceptance
- [ ] Qrels export is canonical, contains no raw source/mirror/snippet text, references immutable source/mirror/passage hashes, preserves exact spans and final-rank versus planner-rank semantics, and validates against `retrieval-trace-qrels.schema.json`.
- [ ] Every exported qrel is traceable to an explicit stored judgment; corrections resolve deterministically, retries remain duplicates, and opened/cited/pinned absence or unlabeled evidence never becomes a negative.
- [ ] `relevant`, `irrelevant`, and `missing_expected` map to relevance and baseline-missing semantics exactly as specified; multiple retrieval runs and null-run missing judgments fail or split deterministically without cross-run contamination.
- [ ] `evals/agentic/trace-import.ts` produces schema-valid deterministic fn-97 fixtures using the positive-task plus per-missing-task split, marks irrelevant-only imports unscorable, and never fabricates answer claims or positives.
- [ ] Fn-97 import verifies active canonical mirror content, maps GNO `mirrorHash` to the fn-97 text-corpus source hash, maps only verified `passageHash` values to span hashes, and rejects stale, missing, converted, or incomplete coordinates that cannot be proven.
- [ ] Aggregate export identity and sorted membership are recovered through a complete manifest-bound StorePort read; reconstructed artifact hash mismatch, missing/cascaded links, missing traces, conflicting format, and bounded/truncated details all fail closed.
- [ ] Qrels/replay extends the task-3 management service, public export union, aggregate-manifest store APIs, and existing CLI group; it creates no second trace/export persistence path.
- [ ] Replay accepts a verified local qrels export ID plus explicit candidate options, uses persisted results as the baseline, compares rank, coverage, evidence outcomes, source state, diagnoses, capabilities, fallbacks, and original/current/candidate fingerprints, and validates against `retrieval-trace-replay.schema.json`.
- [ ] Replay distinguishes `unchanged`, `stale`, `missing`, `inactive`, and `no_indexed_content` sources and emits stable `improved`, `unchanged`, `regressed`, or `unreplayable` verdicts with explicit reason codes.
- [ ] A winning candidate returns only `promote`, `keep_baseline`, or `manual_review` guidance with `applied: false`; tests prove no ranking, prompt, model, configuration, trace, boost, or user-file mutation.
- [ ] Metadata-redacted, open, disabled, sub-minimum-cap, retention-evicted, deleted, purged, queryless, filter-incomplete, and no-retrieval-run receipts never become synthetic or empty successful replay cases.
- [ ] `gno trace export --format qrels` preserves atomic file-only output behavior, and `gno trace replay` provides schema-valid JSON plus deterministic readable Markdown without allowing arbitrary-file manifest bypass.
- [ ] Store, core, fn-97 importer, CLI, contract-schema, and no-mutation regression tests pass; `bun run lint:check`, `bun test`, and the retrieval-quality checks required by this repository are green.
- [ ] `spec/cli.md`, `docs/CLI.md`, `assets/skill/SKILL.md`, affected README/CHANGELOG surfaces, and affected hosted `~/work/gno.sh` documentation describe the shipped behavior without drift.
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
