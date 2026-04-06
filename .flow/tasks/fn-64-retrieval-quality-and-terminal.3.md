# fn-64-retrieval-quality-and-terminal.3 Add TTY terminal hyperlinks for CLI retrieval results

## Description

Improve terminal-first retrieval ergonomics without destabilizing structured output.

This task adds OSC 8 hyperlinks for TTY terminal output on retrieval surfaces while keeping `gno://` as the displayed identifier.

Target commands:

- `gno search`
- `gno vsearch`
- `gno query`

`gno ask` is optional only if it reuses the same formatter path cleanly for retrieval-only sections.

Start here:

- `src/cli/format/search-results.ts`
- `src/cli/commands/search.ts`
- `src/cli/commands/vsearch.ts`
- `src/cli/commands/query.ts`
- `src/pipeline/types.ts`
- `docs/CLI.md`

Requirements:

- emit OSC 8 links only when writing terminal output to `stdout` when `process.stdout.isTTY` is true
- do not emit OSC 8 sequences in:
  - JSON
  - CSV
  - XML
  - files mode
  - non-TTY stdout
- keep visible text as `gno://...`, not raw editor-specific URIs
- prefer `source.absPath` for the click target
- include a best-effort line hint derived from `snippetRange.startLine` when present
- do not synthesize `:1` or fake line numbers when `snippetRange` is absent
- support configurable editor URI templates with a sane fallback when no template is configured
- keep pager behavior functional when hyperlinks are enabled
- pass terminal-link policy/config into the formatter explicitly rather than reading global process state ad hoc inside deep formatting helpers

Config/behavior notes:

- support both YAML config and env override, with one documented precedence rule
- if placeholders are supported, define them explicitly:
  - `{path}`
  - `{line}`
  - optional `{col}`
- configuration should fit the existing central config model, not invent per-collection config
- behavior should degrade to plain text safely when path or line information is unavailable
- path/URI escaping rules must be explicit, including spaces and Windows-safe behavior

Tests:

- unit coverage for formatter behavior in TTY vs non-TTY modes
- coverage for line-aware link generation when `snippetRange` exists
- coverage for no-line behavior when `snippetRange` is absent
- coverage proving plain output remains unchanged for structured formats and pipes
- snapshot-style tests only if they stay readable and stable
- extend CLI smoke/formatter coverage around `test/cli/query-smoke.test.ts`

Docs/website:

Own these updates in this task:

- update `docs/CLI.md`
- update `docs/CONFIGURATION.md` if a new config/env knob is added
- update `docs/TROUBLESHOOTING.md` with terminal/editor caveats if needed
- update `README.md` if this becomes a user-facing CLI capability worth surfacing
- update `website/features/hybrid-search.md`
- update `website/_data/features.yml`
- refresh `website/assets/screenshots/cli.jpg` and/or `website/demos/tapes/search-modes.tape` if visible CLI output examples materially change
- run `bun run website:sync-docs`

If the implementation materially changes visible CLI examples or screenshots, refresh the relevant terminal-facing website asset(s) instead of leaving stale visuals.

Non-goals:

- changing retrieval ranking
- changing `gno://` URI identity
- web UI link behavior

Related prior work to reuse:

- `fn-26.1` for `source.absPath`
- `fn-9.1` for prior CLI output/pager fragility

## Acceptance

- [ ] TTY terminal output for retrieval commands can emit clickable hyperlinks without changing the visible `gno://` text.
- [ ] Structured output modes and non-TTY output remain free of OSC 8 escape sequences.
- [ ] Link targets use absolute paths and best-effort line hints when available.
- [ ] Formatter input carries explicit terminal-link policy/config instead of discovering it ad hoc deep in formatting code.
- [ ] Pager path remains functional with hyperlinks enabled.
- [ ] YAML config support and env override are both implemented with explicit precedence and documented behavior.
- [ ] Website hybrid-search copy reflects the terminal-link capability only if the feature ships in this task.

## Done summary
Implemented TTY-only OSC 8 terminal hyperlinks for `gno search`, `gno vsearch`, and `gno query` through the shared formatter.

Delivered:

- added explicit formatter terminal-link policy injection instead of hidden process-state reads in the formatter
- added top-level `editorUriTemplate` YAML config plus `GNO_EDITOR_URI_TEMPLATE` env override with documented precedence
- preserved plain text for non-TTY output and all structured formats
- used `source.absPath` for link targets and best-effort snippet line hints without fabricating `:1`
- documented terminal hyperlink behavior in CLI/config/troubleshooting docs and hybrid-search feature copy
- added dedicated formatter tests plus query-format coverage for hyperlink output
## Evidence
- Commits:
- Tests: bun test test/cli/search-results-format.test.ts test/cli/query-smoke.test.ts test/config/loader.test.ts test/config/saver.test.ts, bun run lint:check, bun run docs:verify, make -C website sync-docs
- PRs: