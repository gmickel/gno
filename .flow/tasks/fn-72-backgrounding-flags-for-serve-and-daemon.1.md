# fn-72-backgrounding-flags-for-serve-and-daemon.1 Spec updates + process-status schema + contract test

## Description
Update CLI spec and add a JSON schema for `--status --json` output **before** any implementation. Spec-first is a hard rule in this repo (`spec/CLAUDE.md`).

**Size:** M
**Files:**
- `spec/cli.md` (serve section ~L2027-2060, daemon section ~L2064-2101, exit codes ~L12-16, format matrix ~L50-96)
- `spec/output-schemas/process-status.schema.json` (new)
- `test/spec/schemas/process-status.test.ts` (new)

## Approach
- Add `--detach`, `--pid-file <path>`, `--log-file <path>`, `--status`, `--stop` rows to both `gno serve` and `gno daemon` option tables.
- Document that `--detach` / `--status` / `--stop` are mutually exclusive.
- Update the Output Format Support Matrix: flip serve + daemon `--json` cells to yes for `--status --json` only.
- Add exit-code row: `3 | NOT_RUNNING | --status/--stop found no live process`.
- Create `process-status.schema.json` with `$id: "gno://schemas/process-status@1.0"`. Fields: `running: boolean`, `pid: number | null`, `port: number | null` (serve only), `cmd: "serve" | "daemon"`, `version: string | null`, `started_at: string | null`, `uptime_seconds: number | null`, `pid_file: string`, `log_file: string`, `log_size_bytes: number | null`.
- Contract test under `test/spec/schemas/` mirrors existing patterns (see `spec/output-schemas/status.schema.json` and its contract test for shape).

## Investigation targets
**Required:**
- `spec/cli.md` — serve + daemon sections, exit codes, format matrix
- `spec/output-schemas/status.schema.json` — shape/`$id` convention
- `spec/CLAUDE.md` — spec-first workflow rules
- `test/spec/schemas/` — existing contract test patterns

**Optional:**
- `spec/output-schemas/mcp-job-status.schema.json` — another JSON-ish status shape

## Key context
- `$id` pattern is `gno://schemas/<name>@<version>`.
- Contract tests run under `bun test`.
## Acceptance
- [ ] `spec/cli.md` updated (serve, daemon, exit codes, format matrix)
- [ ] Mutex rule (`--detach` / `--status` / `--stop`) documented in spec with example
- [ ] `spec/output-schemas/process-status.schema.json` created and valid
- [ ] `test/spec/schemas/process-status.test.ts` added and passing
- [ ] `bun run lint:check && bun test` green
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
