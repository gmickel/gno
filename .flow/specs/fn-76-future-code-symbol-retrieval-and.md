# fn-76 Future code symbol retrieval and navigation

## Goal & Context
<!-- scope: business -->

Preserve an evidence gate for symbol-aware code retrieval without implying that implementation is scheduled. Current code retrieval already combines identifier-friendly BM25 chunks with exact source line retrieval. The canonical AST experiment produced no retrieval gain (`nDCG@10` remained `0.963`) while adding parser latency, fallbacks, package size, and cross-platform risk.

Symbol navigation is still a potentially strong developer feature, but today it is a hypothesis rather than a justified product investment. This spec owns one decision task only: collect new workflow/benchmark evidence and either keep the deferral or mint a fresh implementation spec. It must not add product code, parser runtime dependencies, symbol graph nodes, storage schema, or public API surfaces.

## Architecture & Data Models
<!-- scope: technical -->

No production architecture change is authorized by this spec. The evidence task evaluates the existing heuristic chunker and retrieval surfaces against optional derived symbol metadata in isolated fixtures/benchmarks.

If a later implementation is justified, the default direction remains:

- optional derived metadata keyed by source revision/hash;
- document/chunk nodes remain primary;
- parser health and unsupported-language fallback are explicit;
- exact definition/reference claims require cited symbol spans;
- lexical fallback is labeled text match, not semantic resolution.

Those are constraints for a future spec, not implementation deliverables here.

## API Contracts
<!-- scope: technical -->

The only output contract is a decision record containing:

- concrete failed user/agent workflows reproducible against current GNO;
- preregistered fixtures, languages, repositories, relevance judgments, metrics, latency/package/platform budgets, and fallback criteria;
- baseline and candidate results with raw artifacts;
- parser error/missing-node rates and unsupported-language behavior;
- `GO`, `NO_GO`, or `INSUFFICIENT_EVIDENCE` verdict;
- for `GO`, the scoped capability and a link to a newly created implementation spec; for other verdicts, the next admissible reconsideration trigger.

No CLI/MCP/API/SDK schema is added in fn-76.

## Edge Cases & Constraints
<!-- scope: technical -->

- At least three concrete navigation/retrieval workflows must demonstrate a current failure that line-range `gno_get`/`gno_multi_get` plus BM25 cannot solve reliably.
- Evaluation includes more than one repository and language, exact identifiers, overloads/duplicate names, generated/minified code, parse errors, partial files, renamed symbols, and unsupported languages.
- Metrics and materiality thresholds are fixed before candidate results are inspected; a gain on one hand-picked query is insufficient.
- Candidate comparison accounts for indexing latency, incremental reindex behavior, package/install size, native/WASM lifecycle, macOS/Linux/Windows support, memory, and fallback quality.
- Tree-sitter `ERROR`/`MISSING` nodes cannot produce trusted symbol claims.
- No LSP/static-analysis promise, call graph, reference graph, or symbol nodes enter production under this task.
- Research artifacts live in the existing benchmark/eval locations; user-facing docs continue to state the current no-gain decision.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** The task begins only when at least three reproducible developer/agent workflows expose a material navigation/retrieval failure in current GNO; absent that evidence, the verdict is `NO_GO` without parser implementation.
- **R2:** A preregistered benchmark compares current heuristic retrieval with the smallest viable symbol-metadata candidate across multiple repositories/languages, with relevance, latency, memory, package, platform, parser-health, and fallback evidence retained.
- **R3:** The decision record distinguishes exact symbol evidence from lexical text matches and reports `GO`, `NO_GO`, or `INSUFFICIENT_EVIDENCE` without post-hoc threshold changes.
- **R4:** fn-76 introduces no production runtime dependency, database/schema change, graph node, CLI/API/SDK/MCP surface, or user-facing capability claim.
- **R5:** A `GO` verdict creates a new implementation spec with optional derived metadata and fallback constraints; `NO_GO`/`INSUFFICIENT_EVIDENCE` leaves current ADR/docs truthful and records the next reconsideration trigger.

## Boundaries
<!-- scope: business -->

- Deferred; not part of the active implementation order.
- No full LSP, compiler/type checker, call graph, or mandatory AST indexing.
- No implementation disguised as a benchmark task.
- No reopening based on novelty, a library release alone, or synthetic quality movement without a real workflow gap.

## Decision Context
<!-- scope: both — conditionally substructured -->

The idea remains attractive, but the evidence is negative and the current workflow already handles many symbol-shaped queries through identifier search plus exact line retrieval. Keeping a small, strict reconsideration gate preserves the option without creating roadmap pressure or dependency risk. Any future `GO` starts a new spec so this evidence record cannot silently expand into implementation.

## Quick commands

```bash
bun run bench:ast-chunking -- --fixture canonical
bun run eval:hybrid
bun run lint:check
```

## Early proof point

Task fn-76.1 first reproduces real current-workflow failures. If fewer than three material failures exist, stop with `NO_GO`; do not install or benchmark a parser candidate merely to complete the task.

## Requirement coverage

| Req | Description | Task(s) | Gap justification |
|---|---|---|---|
| R1 | Real workflow trigger | fn-76.1 | — |
| R2 | Preregistered multi-dimensional benchmark | fn-76.1 | — |
| R3 | Honest decision receipt | fn-76.1 | — |
| R4 | No production implementation | fn-76.1 | — |
| R5 | New-spec-only GO path | fn-76.1 | — |

## References

- `src/ingestion/chunker.ts`
- `scripts/ast-chunking-benchmark.ts:11-13`
- `docs/adr/003-code-aware-chunking.md:118-135`
- `docs/adr/006-code-symbol-graph-foundation.md:18-74`
- `docs/HOW-SEARCH-WORKS.md:250`
- `docs/GLOSSARY.md:238`
- Tree-sitter parser behavior: https://tree-sitter.github.io/tree-sitter/using-parsers/
- Tree-sitter query errors/missing nodes: https://tree-sitter.github.io/tree-sitter/using-parsers/queries/1-syntax.html
