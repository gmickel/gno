---
satisfies: [R1, R4, R5]
---
# fn-130-memory-slice-rememberrecall-contracts.2 CLI surface: gno remember / gno recall

## Description
CLI surface. **Size:** M. **Files/Touches:** src/cli/program.ts, new src/cli/commands/memory.ts, spec/cli.md, docs/CLI.md, test/cli/memory*.
`gno remember` / `gno recall`: explicit `--scope` (repeatable, fail-closed — missing scope exits VALIDATION), `--collection`, decision flags `--add` / `--supersede <uri> --predecessor-hash <hash>` (neither → candidate-proposal output), `--budget` overrides on recall, required caller/session identity flags (defaulted from process context, overridable), `--json` everywhere; self-teaching empty-recall line names `gno remember`; exit codes per spec/cli.md conventions (VALIDATION for scope/flag errors, dedicated conflict signaling for supersede races per core contract). Calls the core service ONLY — no direct store access, no lease acquisition (core owns it).

**Touches:** src/cli/program.ts, src/cli/commands/memory.ts (new), spec/cli.md, docs/CLI.md, test/cli/memory*

## Acceptance
- [ ] Missing --scope exits VALIDATION with a message naming the flag, live-verified
- [ ] add / supersede / no-decision flows live-verified end to end incl. candidate-proposal output shape
- [ ] Empty recall prints the self-teaching line; populated recall shows cites + budget respected
- [ ] spec/cli.md + docs/CLI.md sections land in the same change; --json shapes match the shared schema

## Done summary
Added `gno remember` / `gno recall` as thin CLI adapters over the core MemoryService (`src/cli/commands/memory.ts`, wired in `src/cli/program.ts`): fail-closed repeatable `--scope`, memory-managed `--collection` (defaulted when exactly one is configured), `--add` / `--supersede <uri> --predecessor-hash <hash>` (plus explicit `--decision` / `--predecessor` so the core empty-recall hint stays truthful), `--receipt` / `--derived-from` fencing inputs, `--max-facts` / `--max-tokens` budget overrides, caller/session identity defaulted from `GNO_MEMORY_CALLER` / `GNO_MEMORY_SESSION` then `cli:<user>` / `ppid:<pid>`, `--json` emitting the core result shapes verbatim, MemoryError -> exit codes (VALIDATION 1, BUSY 4 for supersede conflict + lease busy, RUNTIME 2) with `details.memoryCode`. spec/cli.md and docs/CLI.md gained the command sections, matrix rows, exit-code note, and env vars.

Tests (test/cli/memory.test.ts, 9 focused): missing --scope names the flag on both commands (R4); unmanaged collection message names memoryManaged (R4); supersede flag validation; empty recall prints MEMORY_EMPTY_RECALL_HINT verbatim (R5); no-decision candidate shape writes nothing (R3); add -> file + completed sync + recall cites with receipt/spanHashes, --max-facts budget honored, foreign scope sees nothing (R1/R5); exact duplicate idempotent + receipted replay fenced (R6); supersede hash mismatch -> VALIDATION, successor carries supersedes, second supersede -> exit 4 BUSY/MEMORY_SUPERSEDE_CONFLICT, predecessor excluded from recall (R2 single-process sequence; the two-writer race itself is covered by test/core/memory.test.ts).

baseline: green via handoff (verified at 48488e5d by fn-130.1)
gates: bun test -> 4581 pass / 0 fail (suite_rc=0); bun run lint:check -> rc 0; gate classify -> FULL (spec/cli.md). Pre-existing red not caused here: `bun run docs:verify` fails on README/website version pins and skill parity.
notes: /home/gordon/work/gno/.git/flow-notes/fn-130-20260903-run1/fn-130-2-cli-memory.md (error-code mapping for MCP/REST parity, --decision vs --add naming, options.ts CMD registry left untouched as outside Touches).

stage: impl-review - skipped(policy: parallel-wave - conductor owns the review after integration)

stage: impl-review - skipped(policy: review backend none)
stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 696a672a7f773ffcc5a976de4bda8923a51a15d6
- Tests: bun test test/cli/memory.test.ts, bun test, bun run lint:check
- PRs: