# fn-64-retrieval-quality-and-terminal.4 Implement code-aware chunking with graceful fallback and retrieval validation

## Description

Add structural chunking for supported code files while preserving safe fallback to the current chunker.

This task should improve retrieval quality for code-heavy collections by avoiding arbitrary chunk breaks in source files.

Start here:

- `src/ingestion/chunker.ts`
- `src/ingestion/sync.ts`
- `src/ingestion/types.ts`
- `src/pipeline/vsearch.ts`
- `src/pipeline/hybrid.ts`
- `test/ingestion/chunker.test.ts`
- `docs/HOW-SEARCH-WORKS.md`

Scope:

- automatic first-pass code-aware chunking for:
  - TypeScript / TSX / JavaScript / JSX
  - Python
  - Go
  - Rust
- detect supported code file types
- derive structural break points for those file types
- chunk around meaningful code boundaries when possible
- preserve existing line-number and snippet-range correctness
- fall back to the current chunker for:
  - unsupported languages
  - parse/init failures
  - malformed input

The implementation can use a parser library if justified, but the fallback path and install/runtime story must stay explicit and well-tested.
Fallback is the production path for unsupported or failed cases, not an error path.

Requirements:

- markdown and prose ingestion behavior must remain stable
- converted Office/PDF/plaintext mirrors must never be misrouted into the code-aware path
- line ranges stored in `content_chunks` must stay trustworthy
- chunking should not require a parser for every file type to keep the system usable
- failure mode must be “current behavior”, not “indexing breaks”
- no DB schema churn unless strictly necessary
- add a size-floor / fallback split policy so structural chunks do not become pathologically tiny or import-heavy
- no major indexing slowdown on non-code files
- users/operators need a way to tell whether code-aware chunking is active, unavailable, or falling back

Retrieval validation:

Do not stop at chunker unit tests.

Add enough retrieval-oriented validation to prove the structural chunking path is useful and safe:

- unit tests for structural boundaries on representative code files
- at least one ingestion-level test covering stored chunk boundaries and line ranges
- at least one retrieval-level test showing better or safer chunk selection for code search
- no regression for markdown/non-code fixtures
- fallback tests for unsupported ext, parser-unavailable, and malformed-code cases

ADR/docs/website:

Own these updates in this task:

- add `docs/adr/003-code-aware-chunking.md`
- update `docs/HOW-SEARCH-WORKS.md`
- update `docs/ARCHITECTURE.md`
- update `docs/CLI.md` if any knobs or explain output change
- update `docs/TROUBLESHOOTING.md` if parser/fallback behavior needs operator guidance
- update `docs/GLOSSARY.md` if code-aware chunking becomes public terminology
- update `README.md` if this becomes a notable retrieval differentiator
- update `website/features/hybrid-search.md`
- update `website/features/multi-format.md`
- update `website/_data/features.yml` if the feature copy benefits from it
- run `bun run website:sync-docs`

Non-goals:

- broad parser-powered symbol indexing beyond chunk boundary selection
- per-language semantic analysis beyond what chunking needs
- per-collection model config
- terminal hyperlink output

Observability/debug expectation:

- parser availability and fallback behavior should be visible through at least one existing operator-facing surface such as:
  - `gno doctor`
  - `gno status`
  - `--explain`
  - another clearly documented retrieval/runtime status surface
- the task should decide whether the first pass is:
  - automatic-only
  - or user-selectable
    and document that choice explicitly
- the shipped surface should make both chunking mode and parser availability/fallback state legible enough that a user can tell why code-aware chunking is or is not active

## Acceptance

- [ ] Supported code files chunk at meaningful structural boundaries instead of only generic prose breaks.
- [ ] Unsupported languages and parser failures fall back to the current chunker safely.
- [ ] First-pass language support is explicit and intentionally narrow: TS/JS family, Python, Go, Rust.
- [ ] Line-range/snippet correctness remains intact for downstream retrieval and editor jumps.
- [ ] Retrieval validation covers code-heavy cases and preserves markdown/prose behavior.
- [ ] No DB schema change is introduced unless implementation proves it unavoidable and documents why.
- [ ] Non-code indexing performance does not regress materially.
- [ ] Parser availability/fallback is observable through a documented operator-facing surface.
- [ ] The first-pass mode decision is explicit: automatic-only or user-selectable.
- [ ] Chunking mode plus parser availability/fallback state are exposed clearly enough to explain when code-aware chunking is active, unavailable, or falling back.
- [ ] ADR-003 and the search/architecture docs explain the new chunking policy and fallback behavior.

## Done summary

Implemented automatic first-pass code-aware chunking for `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, and `.rs` by extending the existing chunker with structural breakpoint heuristics while preserving the existing chunk output shape and prose fallback path.

Delivered:

- code-aware structural breakpoints in `src/ingestion/chunker.ts`
- source-path aware chunker interface + sync wiring in `src/ingestion/types.ts` and `src/ingestion/sync.ts`
- first-pass operator visibility via `gno doctor` in `src/cli/commands/doctor.ts`
- code-file ingestion support through `text/plain` MIME mapping for the supported extensions in `src/converters/mime.ts`
- chunker unit coverage and sync+search integration coverage in `test/ingestion/chunker.test.ts` and `test/ingestion/sync-code-chunking.test.ts`
- docs + website updates describing the automatic mode, supported extensions, and fallback behavior
- ADR-003 documenting the automatic-only first pass, supported extensions, fallback rules, and non-goals

## Evidence

- Commits:
- Tests: bun test test/ingestion/chunker.test.ts test/ingestion/sync-code-chunking.test.ts test/ingestion/sync-tags.test.ts test/pipeline/search-n1.test.ts, bun run lint, bun run docs:verify, make -C website sync-docs
- PRs:
