# fn-82-second-brain-capture-and-provenance.2 Add CLI capture command on the shared core

## Description

Add the missing `gno capture` CLI surface using the shared capture core from task 1.

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

## Evidence

- Commits:
- Tests:
- PRs:
