# Hybrid ranking and answer quality

## Goal & Context
<!-- scope: business; source: user + inferred -->

Once semantic search is fast (fast-semantic-retrieval spec), hybrid ranking has to make the semantic leg count. Three ranking behaviours in GNO were measured as harmful in other local retrieval systems this autumn, and GNO's answer prompt carries no dates. These are hypotheses for GNO until measured on its own fixtures. [user] [inferred]

1. **Non-monotonic rerank blend.** The position-tiered blend (`src/pipeline/types.ts` ~402: 0.75/0.25 to rank 3, 0.6/0.4 to rank 10, 0.4/0.6 beyond; applied in `src/pipeline/rerank.ts`) lets a candidate just past a tier boundary jump above one just inside it whenever its rerank score exceeds its fusion score. On an external 9k-document corpus the same tiers made reranking a no-op (MRR 0.460 with vs 0.463 without); "rerank score, ties by fusion rank" reached MRR 0.663, a monotonic linear blend recall@5 0.778.
2. **Chunk-keyed fusion splits a document's votes.** Reciprocal-rank fusion keys candidates by chunk (`src/pipeline/fusion.ts` ~78/120/156), but BM25 rows are document-level and vector rows chunk-level, so a document both legs rank first through different chunks is counted as two weaker candidates.
3. **Query date words become hard filters.** "last week", "today" etc. become since/until on every leg (`src/pipeline/temporal.ts` ~132, applied in `src/pipeline/hybrid.ts` ~418-556). An external preregistered test of the same behaviour measured −0.101 NDCG@5 (0 wins, 11 losses) and dropped it.
4. **Answers are generated without dates.** `src/pipeline/answer-prompt.ts` states neither today's date nor any source's date, although Capsules render document dates. An external evaluation of adding exactly that (no extra model calls) moved conversational QA accuracy from 74.2% to 88.2%, mostly on temporal questions.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** [inferred] Each ranking hypothesis (monotonic blend, document-level fusion, query-inferred dates as a soft recency signal or off) is evaluated independently with the vector, expansion and rerank stages actually running. The existing hybrid benchmark disables vectors and reranking (`evals/helpers/hybrid-benchmark.ts` ~226-235), so the comparison uses real models, for example the retrieval-candidate benchmark or the hybrid fixtures run with models. Report baseline and outcome for each, negatives included, in the PR and the eval notes; ship only demonstrated improvements.
- **R2:** [inferred] Shipped ranking changes are reflected in `query --explain` output and the docs that describe blending, fusion or temporal inference; explicit `--since`/`--until` stay hard filters.
- **R3:** [inferred] Ordinary and verified answer prompts include today's date and each source's known content date (frontmatter date, record/session/mail timestamp), reusing Capsule date semantics. File modification time is never presented as a content date; unknown dates are omitted.

## Verification
<!-- scope: technical -->

- [inferred] Evaluation table per hypothesis in the PR.
- [inferred] Answer-prompt unit test for the date frame; the ask eval shows no regression.
- [inferred] `bun run lint:check && bun test`.

## If no hypothesis wins
<!-- scope: technical -->

Keep today's ranking and record the negative results. Candidate follow-ups, each needing its own measurement before a spec: [inferred]

- Rerank score first with fusion rank as tie-break (the strongest external result), if the monotonic blend loses.
- Frontmatter text as its own weighted FTS column.
- Evidence passages fitted to the reranker's token budget around the match, instead of a 4000-char prefix.
- Question-shaped input on the BM25 leg matched as any-term rather than all-terms (check current behaviour first).
- Expansion dedupe on the cached-expansion path (check first).

## Boundaries
<!-- scope: business -->

- [inferred] No new ranking signals, models or a held-out corpus build; no public reference-date option (tests may inject the date).
- [inferred] Deferred during implementation (2026-10-12): the query-inferred-date hypothesis in R1. None of the judged retrieval cases carries a date phrase, and dating the fixture documents to construct one would make the outcome a function of the chosen timestamps; with no held-out corpus allowed, inference stays as it is and the evaluation waits for a dated, judged case set. Recorded in `evals/README.md` (Ranking Ablation).
- [inferred] Depends on the fast-semantic-retrieval spec: evaluating with vectors on is impractical at today's speeds, and that spec's parity test must compare unchanged ranking.
- [user] Never name other products in code, specs, commits, docs or the site.
