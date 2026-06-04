# fn-82-second-brain-capture-and-provenance.2 Add CLI capture command on the shared core

## Description

Add the missing `gno capture` CLI surface using the shared capture core from task 1.

Task 1 delivered the shared contract in `src/core/capture.ts` and the canonical
receipt schema `spec/output-schemas/capture-receipt.schema.json`. Use
`planCapture()` and `buildCaptureReceipt()` rather than reimplementing content
hashing, UTC inbox paths, source frontmatter, tag normalization, or collision
status fields.

The command is a thin adapter: parse Commander options, read content or scaffold intent, pass normalized input to the shared core, and format the shared receipt as human text, JSON, or quiet output.

Expected files:

- `src/cli/program.ts`
- `src/cli/commands/capture*.ts`
- `spec/cli.md`
- `docs/CLI.md`
- `docs/QUICKSTART.md`
- `README.md`
- `assets/skill/SKILL.md`
- `assets/skill/cli-reference.md`
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`
- tests under `test/cli` or the repo's existing CLI-command test location

CLI contract:

- content source modes: inline argument, `--stdin`, `--file`, or scaffold-only mode when `--preset` can generate non-empty content
- `--collection`, `--folder`, `--path`, `--title`, `--preset`, `--tags`
- `--collision-policy <error|open_existing|create_with_suffix>`
- provenance flags: `--source-kind`, `--source-url`, `--source-title`, `--source-author`, `--source-date`, `--source-id`
- `--source-date` maps to `source.observedAt`; `--source-id` maps to `source.externalId`
- output flags: `--json`, `--quiet`; `--json` wins, quiet prints only URI on success

## Acceptance

- [ ] **R1:** CLI enforces the shared content validation matrix: mutually exclusive content sources, scaffold-capable preset without body allowed, and empty body without scaffold rejected.
- [ ] **R2:** CLI exposes `--collision-policy <error|open_existing|create_with_suffix>` and tests generated-path default `open_existing` plus explicit-path default `error`.
- [ ] **R3:** CLI file/stdin reading delegates text safety, NUL, size, hash, provenance, and binary-like rejection rules to shared core.
- [ ] **R4:** CLI output uses the shared receipt contract for normal, `--json`, and quiet URI-only modes, with `--json` precedence tested.
- [ ] **R5:** CLI capture uses shared collection/path/collision/preset/tag/provenance behavior instead of reimplementing note creation.
- [ ] **R6:** Source flags map exactly to canonical fields and validate ISO-like dates/URLs before write.
- [ ] **R7:** `spec/cli.md`, `docs/CLI.md`, `docs/QUICKSTART.md`, `README.md`, skill CLI reference, and hosted `gno.sh` quickstart/docs are updated with CLI-specific examples only, reusing canonical task-1 schema wording.

## Done summary
Implemented the CLI capture surface on the shared capture core.

- Added `gno capture [content...]` with inline/stdin/file source handling, collection/path/folder/title/preset/tags options, collision policy, provenance source flags, JSON receipts, and quiet URI-only output.
- CLI delegates content validation, UTC inbox hash paths, source frontmatter, tag normalization, and collision planning to `src/core/capture.ts`.
- Capture writes the planned file, runs syncFiles for FTS ingestion, and returns a receipt with separate sync and embed states.
- Added CLI tests for JSON receipt/source/tags, quiet output, conflicting content sources, and disk-only collision suffixing.
- Updated repo CLI docs/spec/README/skill assets and hosted `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx` for CLI capture examples and receipt semantics.
## Evidence
- Commits:
- Tests: {'command': 'bun test test/cli/capture.test.ts test/core/capture.test.ts test/spec/schemas/capture-receipt.test.ts test/spec/schemas/mcp-capture-result.test.ts', 'result': 'pass', 'evidence': '18 pass, 0 fail'}, {'command': 'bun run lint:check', 'result': 'pass', 'evidence': 'Found 0 warnings and 0 errors; formatting check passed'}
- PRs: