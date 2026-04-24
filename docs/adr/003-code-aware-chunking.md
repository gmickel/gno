# ADR-003: Code-Aware Chunking

**Status**: accepted
**Date**: 2026-04-06
**Author**: Gordon Mickel

## Context

GNO's original chunker was prose-oriented: character windows, semantic break heuristics, stable line tracking, and overlap. That works well for markdown and converted documents, but it can split code files in the middle of functions or class/type blocks.

This hurts:

- code search snippet quality
- retrieval chunk alignment for source files
- user trust in line-range-based navigation

The task for this ADR was to improve code-file chunking without:

- adding schema churn
- forcing every file type through a parser
- introducing a second chunking configuration system
- regressing markdown/prose ingestion

## Decision

Adopt an **automatic first-pass code-aware chunking mode** for a narrow set of source file types:

- `.ts`
- `.tsx`
- `.js`
- `.jsx`
- `.py`
- `.go`
- `.rs`

For those extensions, GNO prefers structural breakpoints such as:

- imports
- functions
- classes
- interfaces/types/enums where relevant
- other top-level code-definition boundaries

If no useful structural breakpoint is available near the target chunk boundary, GNO falls back to the existing markdown/prose chunker.

If the file extension is unsupported, GNO falls back to the existing markdown/prose chunker.

This first pass is **automatic-only**. No user-selectable chunking mode is added in this change.

## Rationale

### Why automatic-only

- keeps the user model simple
- avoids adding a new config/control surface before the behavior proves itself
- matches the product goal: better code retrieval by default, not expert tuning

### Why narrow language support

- highest practical payoff for GNO's developer-heavy audience
- easier to validate safely
- avoids pretending "all code is supported" when only some languages can be chunked well

### Why fallback instead of failure

Fallback is the production path, not an error path.

That preserves:

- existing indexing behavior for unsupported code files
- stable line-range semantics
- no hard dependency on parser availability for unrelated content

### Why no schema change

The existing chunk contract already carries what downstream retrieval needs:

- `seq`
- `pos`
- `text`
- `startLine`
- `endLine`

Changing chunk generation without changing storage shape keeps the blast radius low.

## Consequences

### Positive

- better code-file chunk boundaries
- better snippet alignment for code search
- safer retrieval-visible behavior for source files
- no impact on markdown/PDF/Office mirrors unless they already use supported code file extensions

### Tradeoffs

- heuristic structural chunking is simpler than full AST-aware parsing
- some very large functions will still split internally when needed to stay within chunk-size constraints
- automatic-only means less operator control in the first pass

## Operator Visibility

`gno doctor` reports the code-chunking mode and supported extensions.

Docs must clearly state:

- supported extensions
- automatic-only mode
- fallback behavior for unsupported files or files with no useful structural boundaries

## Non-goals

- full symbol indexing
- full AST dependency on every supported platform/file type
- per-language deep semantic analysis
- collection-specific chunking configuration

## 2026-04-24 AST Benchmark Follow-up

GNO now has an experimental benchmark harness:

```bash
bun run bench:ast-chunking -- --fixture canonical --write
```

It compares the current heuristic chunker with real tree-sitter parsing via `web-tree-sitter` and VS Code's WASM grammars for TypeScript, TSX, JavaScript, JSX, Python, Go, and Rust. Production chunking is unchanged.

Latest canonical fixture result:

| Mode      | Recall@5 | Recall@10 | nDCG@10 |   MRR | parse ms | chunk ms | chunks | fallbacks |
| --------- | -------: | --------: | ------: | ----: | -------: | -------: | -----: | --------: |
| Heuristic |    1.000 |     1.000 |   0.963 | 0.950 |      0.0 |      2.0 |      9 |         0 |
| AST       |    1.000 |     1.000 |   0.963 | 0.950 |     17.1 |      1.7 |      8 |         2 |

Decision: **do not ship AST chunking yet**. The canonical benchmark showed no retrieval-quality gain, added parser latency, and requires dev-only grammar assets (`@vscode/tree-sitter-wasm`, 22.1 MB unpacked). Reconsider AST chunking only if larger code embedding fixtures show durable nDCG/recall gains, parse failure fallback stays clean, and package impact is justified.
