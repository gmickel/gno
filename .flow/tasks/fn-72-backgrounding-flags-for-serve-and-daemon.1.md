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

Spec-first groundwork for fn-72: documented --detach/--pid-file/--log-file/--status/--stop on `gno serve` and `gno daemon` with mutex and NOT_RUNNING (exit 3), added process-status@1.0 JSON schema with cross-field invariants (cmd<->port, running<->liveness, live-serve-needs-port), and landed a 17-test Ajv contract suite. Reviewed via codex through three fix rounds (schema invariants, --stop behavior alignment, retracted overstated LLM-thread-hazard claim from spike); final verdict SHIP.

## Evidence

- Commits: 7a0dd905eec3f1f5dab1ff855d2fdf02fc62c2c4, 4250277a56d81e16fa5c6eeaa2503cc4fb7990c0, 3280461fc8449d11f7c9467b18a846d53fe9cc04, 2919d82225d5985aa5f66aad29472376ac34c4e2
- Tests: bun run lint:check, bun test test/spec/schemas/process-status.test.ts, bun test test/spec/schemas/, bun test
- PRs:
