---
satisfies: [R1, R2, R3, R4, R5, R6]
---
# fn-223-gno-convert-one-file-to-indexed-markdown.1 Implement gno convert: one file to indexed Markdown

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Added `gno convert <file> [--json]` and SDK `convertFile(path)`. One file runs through indexing's own path (extension MIME + record-adapter check, sniffed MIME, prepareFile in the terminable file processor under the default 100 MB / 60 s / memory budget), so the Markdown and mirrorHash equal the mirror `gno update` stores. Nothing is read or written: no config, index or cache; the preAction session-binding check is skipped for convert. Multi-record formats are refused with MULTI_DOCUMENT (details.format names the adapter). Errors use the CLI envelope with details.reason (NOT_FOUND/TOO_LARGE/UNSUPPORTED/MULTI_DOCUMENT exit 1; converter codes exit 2). New convert@1.0 schema + contract registration; spec/cli.md, docs/CLI.md, docs/SDK.md, CHANGELOG (credits @ArnauvGilotra, #314), skill cli-reference. Also synced the .claude/.codex project skill copies, which had drifted since #335 (docs:verify failed on main).

Deviation from the spec text: mirrorHash is plain SHA-256 hex (what indexing stores), not "sha256:…"; spec example updated.

stage: impl-review - skipped(config: repository instructions say "Skip all review stages")

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 1beed1d9ff97ae2465bf8dd2a4091d5b0ad167d6
- Tests: bun test test/cli/convert.test.ts test/spec test/cli/skill.test.ts test/cli/global-options.test.ts, bun run lint:check, bun run docs:verify
- PRs: