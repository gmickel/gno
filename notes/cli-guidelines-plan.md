# Plan: CLI Guidelines Compliance Audit & Improvements

**Reference:** [Command Line Interface Guidelines](https://clig.dev) - comprehensive best practices for CLI design.

## Current State Assessment

GNO CLI is already well-designed and follows many best practices:

### Already Implemented ✅
- Commander.js for argument parsing
- Exit codes (0=success, 1=validation, 2=runtime) — `src/cli/run.ts`
- Output to stdout, errors/progress to stderr
- `-h`/`--help` flags
- `NO_COLOR` env var support (no-color.org compliant) — `src/cli/context.ts`
- Multiple output formats (`--json`, `--files`, `--csv`, `--md`, `--xml`)
- XDG Base Directory spec compliance
- Progress indicators for model downloads
- `--yes` flag for non-interactive scripting
- `CliError` class with structured error handling — `src/cli/errors.ts`
- Machine-readable JSON error envelope — `src/cli/run.ts`
- Format support matrix validated per-command
- Terminal output sanitization (ANSI injection prevention) — `src/cli/commands/collection/list.ts`
- Lazy imports for fast `--help` — `src/cli/program.ts`
- Color via picocolors with global enable/disable — `src/cli/colors.ts`
- Returns exit codes instead of calling `process.exit()` (testable/embeddable)

---

## Gaps to Address (Prioritized)

### P0: Critical / Easy Wins

#### 1. Concise help when run with no args
**Guideline:** "Display concise help text by default when command requires args and is run with none"

Currently `gno` with no args shows full Commander help. Should show:
- Brief description
- 1-2 example invocations
- Pointer to `gno --help` for full listing

**Files:** `src/cli/program.ts`

#### 2. Add `--quiet` / `-q` flag
**Guideline:** "Provide a -q option to suppress all non-essential output"

Missing global quiet flag. Currently only have `--verbose`.

**Files:** `src/cli/program.ts`, `src/cli/context.ts`

#### 3. Fix inconsistent console.log/error usage
**Guideline:** "Send output to stdout, messaging to stderr"

Some commands use `console.log()`/`console.error()` instead of `process.stdout.write()`/`process.stderr.write()`. Inconsistent with rest of codebase.

**Files:** `src/cli/commands/context/list.ts`, others to audit

#### 4. Global options consistency (NEW - from review)
**Guideline:** Flags like `--no-color`, `--quiet`, `--config` must work consistently across ALL commands.

Currently only some commands call `resolveGlobalOptions()`. Many management commands don't, so global flags won't take effect.

**Solution:** Every `.action()` must begin by resolving globals. Create `withGlobals()` helper to enforce this.

**Files:** `src/cli/program.ts`, create `src/cli/action.ts`

#### 5. Help after error (NEW - from review)
**Guideline:** Guide users when they make mistakes.

Enable Commander's `showHelpAfterError(true)` alongside suggestions.

**Files:** `src/cli/program.ts`

#### 6. Concise help via pre-parse (NEW - from review)
**Issue:** Using `program.action()` for concise help conflicts with Commander subcommands and doesn't handle `--json` mode.

**Solution:** Implement in `runCli` pre-parse for deterministic behavior:
```ts
if (!argvHasSubcommand(argv) && !isHelpOrVersion(argv)) {
  printConciseHelp({ json: argvWantsJson(argv) });
  return 0;
}
```

**Files:** `src/cli/run.ts`

---

### P1: High Value

#### 7. Suggest corrections for typos
**Guideline:** "If the user did something wrong and you can guess what they meant, suggest it"

Commander has built-in `suggestAfterError()` - just needs enabling.

**Files:** `src/cli/program.ts`

#### 8. Add "next steps" suggestions
**Guideline:** "Suggest commands the user should run"

After key commands, suggest what to do next:
- After `init` → "Run `gno index` to build your search index"
- After `index` → "Run `gno ask "your query"` to search"
- After errors → Suggest fixes

**Files:** Various command files

#### 9. Centralized messaging policy (NEW - from review)
**Guideline:** "stdout is for data" - hints/progress must go to stderr, gated by TTY/json/quiet.

Create `src/cli/ui.ts` with centralized output routing:
```ts
export type OutputPolicy = { quiet: boolean; json: boolean; isTTY: boolean };
export function shouldShowHints(p: OutputPolicy): boolean;
export function hint(msg: string, p: OutputPolicy): void;  // stderr, gated
export function info(msg: string): void;                    // stderr
export function data(msg: string): void;                    // stdout
export function error(msg: string): void;                   // stderr
```

**Files:** Create `src/cli/ui.ts`, update command files

#### 10. Add `--dry-run` where applicable
**Guideline:** "Use standard names for flags"

Commands that modify state should support `--dry-run`:
- `cleanup --dry-run` - show orphaned data counts without deleting
- `reset --dry-run` - show what DBs/files would be deleted
- `update --dry-run` - show file changes without writing to DB

Pass `dryRun: boolean` deep into executor layer, not just CLI output.

**Files:** `src/cli/commands/cleanup.ts`, `src/cli/commands/reset.ts`, etc.

---

### P2: Nice to Have

#### 11. Better progress indicators
**Guideline:** "Show progress if something takes a long time"

Current: Simple `\r` overwrite for model downloads
Improve:
- Spinner for short operations (< 5s expected)
- Better formatting for indexing progress
- Time estimates where feasible

**Files:** Create `src/cli/progress.ts`, update command files

#### 12. Graceful Ctrl-C with AbortController (NEW - from review)
**Guideline:** "If a user hits Ctrl-C, exit as soon as possible. Say something immediately."

Current: Silent exit with code 130
Improved approach:
- Print "Interrupted" to stderr
- Use AbortController for proper cancellation plumbing
- Pass signal through to long-running operations

```ts
// src/cli/runtime.ts
export type CliRuntime = { signal: AbortSignal };
```

**Files:** `src/index.ts`, `src/cli/run.ts`, create `src/cli/runtime.ts`

#### 13. Add support path / web docs link in help
**Guideline:** "Provide a support path for feedback and issues"

Add GitHub link and docs URL to top-level help.

**Files:** `src/cli/program.ts`, `src/app/constants.ts`

#### 14. Terminal width awareness
**Guideline:** "Increase information density"

Use terminal width for:
- Truncating long paths
- Table formatting
- Help text wrapping

**Files:** Create `src/cli/terminal.ts`

#### 15. stdin support for query commands (NEW - from review)
**Guideline:** "Composability / pipelines" - accept piped input where sensible.

Allow query-like commands to read from stdin:
- `echo "my query" | gno ask`
- `gno ask -` reads from stdin

```ts
// src/cli/stdin.ts
export async function readStdinText(opts?: { maxBytes?: number }): Promise<string>;
export function stdinHasData(): boolean;
```

**Files:** Create `src/cli/stdin.ts`, update `src/cli/program.ts` (make `<query>` optional)

---

### P3: Future / Low Priority

> **Tracked in beads:** Epic `gno-amf` with tasks `gno-8l3`, `gno-c6p`, `gno-eb8`

#### 16. Pager for long output
**Guideline:** "Use a pager if you are outputting a lot of text"

For commands like `ls` with many results, pipe through pager when TTY.

**Beads:** `gno-8l3`

#### 17. Man pages
**Guideline:** "Consider providing man pages"

Generate from spec/cli.md using tool like ronn.

**Beads:** `gno-c6p`

#### 18. Tab completion
Not in guidelines but mentioned. Commander supports generating completion scripts.

**Beads:** `gno-eb8`

---

## Implementation Plan

### Phase 1: Foundation (P0)

#### 1.1 Create `src/cli/action.ts` - withGlobals helper
```ts
import type { Command } from 'commander';
import { resolveGlobalOptions, type GlobalOptions } from './context';

export type ActionContext = { globals: GlobalOptions };

export function withGlobals<TArgs extends unknown[]>(
  program: Command,
  fn: (ctx: ActionContext, ...args: TArgs) => Promise<void> | void
) {
  return (...args: TArgs) => fn({ globals: resolveGlobalOptions(program.opts()) }, ...args);
}
```

#### 1.2 Update `src/cli/context.ts` - add quiet flag
```ts
export type GlobalOptions = {
  index: string;
  config?: string;
  color: boolean;
  verbose: boolean;
  yes: boolean;
  quiet: boolean;  // NEW
};
```

#### 1.3 Update `src/cli/program.ts` - enable suggestions + help after error
```ts
program
  .showSuggestionAfterError(true)
  .showHelpAfterError('(Use --help for available options)');
```

#### 1.4 Update `src/cli/run.ts` - concise help pre-parse
```ts
function argvHasSubcommand(argv: string[]): boolean {
  const commands = ['init', 'index', 'search', 'ask', ...]; // all command names
  return argv.slice(2).some(arg => commands.includes(arg));
}

// In runCli, before program.parseAsync:
if (!argvHasSubcommand(argv) && !argv.includes('-h') && !argv.includes('--help')) {
  printConciseHelp();
  return 0;
}
```

#### 1.5 Fix console.log/error usage
Audit and replace in all CLI files:
- `console.log()` → `process.stdout.write(msg + '\n')`
- `console.error()` → `process.stderr.write(msg + '\n')`

#### 1.6 Wrap all command actions with `withGlobals()`
Update every `.action()` in `program.ts` to use the helper.

### Phase 2: Core Improvements (P1)

#### 2.1 Create `src/cli/ui.ts` - centralized output
```ts
export type OutputPolicy = { quiet: boolean; json: boolean; isTTY: boolean };

export function shouldShowHints(p: OutputPolicy): boolean {
  return !p.quiet && !p.json && p.isTTY;
}

export function hint(msg: string, p: OutputPolicy): void {
  if (shouldShowHints(p)) process.stderr.write(msg + '\n');
}

export function info(msg: string): void {
  process.stderr.write(msg + '\n');
}

export function data(msg: string): void {
  process.stdout.write(msg + '\n');
}
```

#### 2.2 Create `src/cli/hints.ts` - next steps suggestions
```ts
import { CLI_NAME } from '../app/constants';

export const hints = {
  afterInit: () => `Next: Run '${CLI_NAME} index' to build your search index`,
  afterIndex: () => `Next: Run '${CLI_NAME} ask "your query"' to search`,
  afterCollectionAdd: () => `Next: Run '${CLI_NAME} index' to index this collection`,
};
```

#### 2.3 Add `--dry-run` to destructive commands
- `cleanup --dry-run`: Show orphaned data counts without deleting
- `reset --dry-run`: Show what DBs/files would be deleted
- `update --dry-run`: Show file changes without writing to DB

Pass `dryRun: boolean` to executor layer.

### Phase 3: Polish (P2)

#### 3.1 Create `src/cli/progress.ts` - spinner utility
```ts
export function createSpinner(message: string) {
  if (!process.stderr.isTTY) return { stop: () => {}, update: () => {} };

  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const id = setInterval(() => {
    process.stderr.write(`\r${frames[i++ % frames.length]} ${message}`);
  }, 80);

  return {
    update: (msg: string) => { message = msg; },
    stop: (finalMsg?: string) => {
      clearInterval(id);
      process.stderr.write(`\r${finalMsg ?? message}\n`);
    }
  };
}
```

#### 3.2 Create `src/cli/runtime.ts` - AbortController for SIGINT
```ts
export type CliRuntime = { signal: AbortSignal };

export function createRuntime(): { runtime: CliRuntime; cleanup: () => void } {
  const controller = new AbortController();

  const handler = () => {
    process.stderr.write('\nInterrupted\n');
    controller.abort();
  };
  process.on('SIGINT', handler);

  return {
    runtime: { signal: controller.signal },
    cleanup: () => process.off('SIGINT', handler)
  };
}
```

#### 3.3 Create `src/cli/terminal.ts` - width utilities
```ts
export function getTerminalWidth(): number {
  return process.stdout.columns ?? 80;
}

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}
```

#### 3.4 Add support/docs links to constants
```ts
// src/app/constants.ts
export const DOCS_URL = 'https://github.com/xxx/gno#readme';
export const ISSUES_URL = 'https://github.com/xxx/gno/issues';
```

#### 3.5 Create `src/cli/stdin.ts` - stdin support (optional)
```ts
export async function readStdinText(opts?: { maxBytes?: number }): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
    if (opts?.maxBytes && Buffer.concat(chunks).length > opts.maxBytes) break;
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

export function stdinHasData(): boolean {
  return !process.stdin.isTTY;
}
```

---

## Files to Modify

### New Files
| File | Purpose |
|------|---------|
| `src/cli/action.ts` | `withGlobals()` helper for consistent option resolution |
| `src/cli/ui.ts` | Centralized output routing (hint/info/data/error) |
| `src/cli/hints.ts` | "Next steps" suggestion messages |
| `src/cli/progress.ts` | Spinner + progress bar utilities |
| `src/cli/terminal.ts` | Terminal width detection + truncation |
| `src/cli/runtime.ts` | AbortController for SIGINT handling |
| `src/cli/stdin.ts` | stdin reading utilities (P2) |

### Modified Files
| File | Changes |
|------|---------|
| `src/app/constants.ts` | Add DOCS_URL, ISSUES_URL constants |
| `src/cli/program.ts` | --quiet flag, suggestAfterError, showHelpAfterError, wrap actions with withGlobals |
| `src/cli/context.ts` | Add `quiet` to GlobalOptions type |
| `src/cli/run.ts` | Concise help pre-parse, integrate runtime/AbortController |
| `src/index.ts` | Integrate SIGINT handling via runtime |
| `src/cli/commands/init.ts` | Add next steps hint, use ui.ts |
| `src/cli/commands/index/index.ts` | Add next steps hint, use spinner |
| `src/cli/commands/collection/add.ts` | Add next steps hint |
| `src/cli/commands/cleanup.ts` | Add --dry-run option |
| `src/cli/commands/reset.ts` | Add --dry-run option |
| `src/cli/commands/update.ts` | Add --dry-run option |
| `src/cli/commands/context/list.ts` | Fix console.log → use ui.ts |

---

## Task Execution Order

### Phase 1: Foundation (P0) - Do First
```
1.  Create src/cli/action.ts (withGlobals helper)
2.  Update src/cli/context.ts (add quiet to GlobalOptions)
3.  Update src/cli/program.ts:
    - Add --quiet/-q global flag
    - Enable showSuggestionAfterError(true)
    - Enable showHelpAfterError()
4.  Update src/cli/run.ts (add concise help pre-parse logic)
5.  Wrap ALL command actions with withGlobals() in program.ts
6.  Audit and fix console.log/error usage across CLI files
```

### Phase 2: Core Improvements (P1)
```
7.  Create src/cli/ui.ts (centralized output policy)
8.  Create src/cli/hints.ts (next steps messages)
9.  Update init.ts to use ui.hint() after success
10. Update index/index.ts to use ui.hint() after success
11. Update collection/add.ts to use ui.hint() after success
12. Add --dry-run to cleanup.ts
13. Add --dry-run to reset.ts
14. Add --dry-run to update.ts
```

### Phase 3: Polish (P2)
```
15. Create src/cli/terminal.ts (width utilities)
16. Create src/cli/progress.ts (spinner)
17. Create src/cli/runtime.ts (AbortController)
18. Update src/app/constants.ts (add DOCS_URL, ISSUES_URL)
19. Add docs/issues links to help text in program.ts
20. Integrate runtime into run.ts and index.ts
21. Add spinners to embed, model pull commands
22. (Optional) Create src/cli/stdin.ts for pipeline support
23. Run tests, fix any issues
```

---

## Test Requirements

Existing smoke tests in `test/cli/smoke.test.ts` need updates:

### New Tests Required
| Feature | Test Description |
|---------|------------------|
| `--quiet`/`-q` flag | Test that flag is accepted, suppresses non-essential output |
| Concise help | Test `gno` with no args shows brief help, not full Commander output |
| Suggestions | Test typo like `gno serach` suggests `search` |
| Help after error | Test error message includes "(Use --help for available options)" |
| Docs link in help | Test `--help` output contains GitHub URL |

### Existing Tests to Verify
- All global options tests still pass
- Error envelope format unchanged
- Exit codes unchanged (0/1/2)

---

## Non-Breaking Guarantees

All changes are additive or behavioral improvements:
- New flags (`--quiet`, `--dry-run`) are optional with sensible defaults
- Existing output formats unchanged
- Exit codes unchanged
- JSON schemas unchanged
- Commander.js stays as framework
- Tests continue to pass
- No breaking changes to existing scripts using gno
