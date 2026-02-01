# CLI Entry Point Wiring

**Type**: Infrastructure / EPIC 8.5
**Priority**: P1 (Critical - blocks manual testing)
**Estimated Effort**: Medium (1-2 sessions)

---

## Overview

Wire up a world-class CLI entry point for GNO using Commander.js. The current `src/index.ts` is a placeholder that only logs "hello world". All command implementations exist in `src/cli/commands/` but have no CLI router to invoke them.

**Goal**: Replace placeholder with full CLI router so users can run `gno search "query"`, `gno init`, etc.

## Problem Statement

- `src/index.ts` is a placeholder: `console.log("hello")`
- Command functions exist (query, search, ask, etc.) but are not callable
- `package.json` declares `bin: { "gno": "src/index.ts" }` but it does nothing
- Cannot manually test any features without programmatic test harness
- Blocks EPIC 9+ (retrieval, MCP) and EPIC 12 (packaging)

---

## Technical Approach

### Architecture: Thin CLI Core Layer

Based on review feedback, implement a proper CLI core that separates concerns:

```
src/index.ts          → Bootstrap only (SIGINT, call runCli, set exitCode)
src/cli/run.ts        → Main entry: parse argv, handle errors, return exit code
src/cli/program.ts    → Commander program definition + command wiring
src/cli/context.ts    → Global options resolution (color, verbose, config, etc.)
src/cli/options.ts    → Format selection, validation, conditional defaults
src/cli/errors.ts     → CliError class, JSON error envelope, exit code mapping
src/cli/help.ts       → Custom grouped help renderer (optional)
```

**Key Principles:**

1. **No `process.exit()` inside actions** - return exit codes, single exit point
2. **Explicit option mappers** - no blind merging of globalOpts + cmdOpts
3. **Centralized error model** - consistent JSON envelope for `--json` errors
4. **Lazy imports** - `gno --help` must not load heavy modules
5. **Protocol-clean stdout** - especially critical for `gno mcp`

---

## File Structure

### New Files

| File                 | Purpose                                  |
| -------------------- | ---------------------------------------- |
| `src/cli/run.ts`     | Main CLI runner, returns exit code       |
| `src/cli/program.ts` | Commander program + command wiring       |
| `src/cli/context.ts` | Global options resolution                |
| `src/cli/options.ts` | Format selection, validation, defaults   |
| `src/cli/errors.ts`  | CliError class, JSON envelope formatting |

### Modified Files

| File                   | Change                                  |
| ---------------------- | --------------------------------------- |
| `src/index.ts`         | Replace placeholder with thin bootstrap |
| `src/app/constants.ts` | Add VERSION constant                    |

---

## Implementation Details

### 1. Bootstrap (`src/index.ts`)

```typescript
#!/usr/bin/env bun
/**
 * GNO CLI entry point.
 * Thin bootstrap that delegates to CLI runner.
 */

import { runCli } from "./cli/run";

// SIGINT handler for graceful shutdown
process.on("SIGINT", () => {
  process.stderr.write("\nInterrupted\n");
  process.exit(130);
});

// Run CLI and set exit code (no process.exit inside)
runCli(process.argv).then((code) => {
  process.exitCode = code;
});
```

### 2. CLI Runner (`src/cli/run.ts`)

```typescript
/**
 * CLI runner - main entry point.
 */

import { createProgram } from "./program";
import { CliError, formatErrorForOutput, exitCodeFor } from "./errors";
import { resolveGlobalOptions, type GlobalContext } from "./context";

export async function runCli(argv: string[]): Promise<number> {
  const program = createProgram();

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      const globals = resolveGlobalOptions(program.opts());
      const output = formatErrorForOutput(err, globals);
      process.stderr.write(output + "\n");
      return exitCodeFor(err);
    }

    // Commander errors (missing args, unknown options)
    if (err && typeof err === "object" && "code" in err) {
      const code = (err as { code: string }).code;
      if (code.startsWith("commander.")) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
        return 1; // Validation error
      }
    }

    // Unexpected errors
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 2; // Runtime error
  }
}
```

### 3. Error Model (`src/cli/errors.ts`)

```typescript
/**
 * CLI error model aligned to spec.
 */

export type CliErrorCode = "VALIDATION" | "RUNTIME";

export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: CliErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "CliError";
  }
}

export function exitCodeFor(err: CliError): 1 | 2 {
  return err.code === "VALIDATION" ? 1 : 2;
}

export function formatErrorForOutput(
  err: CliError,
  globals: { json?: boolean }
): string {
  if (globals.json) {
    return JSON.stringify({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }
  return `Error: ${err.message}`;
}
```

### 4. Global Context (`src/cli/context.ts`)

```typescript
/**
 * Global CLI context resolution.
 */

export type GlobalOptions = {
  index: string;
  config?: string;
  color: boolean;
  verbose: boolean;
  yes: boolean;
};

export function resolveGlobalOptions(
  raw: Record<string, unknown>,
  env = process.env
): GlobalOptions {
  // NO_COLOR env var support (https://no-color.org/)
  const noColorEnv = env.NO_COLOR !== undefined && env.NO_COLOR !== "";
  const noColorFlag = raw.color === false; // --no-color sets color to false

  return {
    index: (raw.index as string) ?? "default",
    config: raw.config as string | undefined,
    color: !noColorEnv && !noColorFlag,
    verbose: Boolean(raw.verbose),
    yes: Boolean(raw.yes),
  };
}
```

### 5. Format Options (`src/cli/options.ts`)

```typescript
/**
 * Output format selection and validation.
 */

import { CliError } from "./errors";

export type OutputFormat = "terminal" | "json" | "files" | "csv" | "md" | "xml";

// Format support matrix per command (from spec/cli.md)
const FORMAT_SUPPORT: Record<string, OutputFormat[]> = {
  search: ["terminal", "json", "files", "csv", "md", "xml"],
  vsearch: ["terminal", "json", "files", "csv", "md", "xml"],
  query: ["terminal", "json", "files", "csv", "md", "xml"],
  ask: ["terminal", "json", "md"],
  get: ["terminal", "json"],
  "multi-get": ["terminal", "json"],
  ls: ["terminal", "json"],
  status: ["terminal", "json"],
  "collection-list": ["terminal", "json", "md"],
  "context-list": ["terminal", "json"],
  "models-list": ["terminal", "json"],
};

export function selectOutputFormat(flags: {
  json?: boolean;
  files?: boolean;
  csv?: boolean;
  md?: boolean;
  xml?: boolean;
}): OutputFormat {
  const selected: OutputFormat[] = [];
  if (flags.json) selected.push("json");
  if (flags.files) selected.push("files");
  if (flags.csv) selected.push("csv");
  if (flags.md) selected.push("md");
  if (flags.xml) selected.push("xml");

  if (selected.length > 1) {
    throw new CliError(
      "VALIDATION",
      `Conflicting output formats: ${selected.join(", ")}. Choose one.`
    );
  }

  return selected[0] ?? "terminal";
}

export function assertFormatSupported(cmd: string, format: OutputFormat): void {
  const supported = FORMAT_SUPPORT[cmd];
  if (supported && !supported.includes(format)) {
    throw new CliError(
      "VALIDATION",
      `Format --${format} is not supported by '${cmd}'. Supported: ${supported.join(", ")}`
    );
  }
}

/**
 * Get default limit based on format (spec: 5 for terminal, 20 for structured).
 */
export function getDefaultLimit(format: OutputFormat): number {
  return format === "terminal" ? 5 : 20;
}
```

### 6. Commander Program (`src/cli/program.ts`)

```typescript
/**
 * Commander program definition.
 */

import { Command } from "commander";
import { CLI_NAME, VERSION, PRODUCT_NAME } from "../app/constants";
import { CliError } from "./errors";
import { resolveGlobalOptions } from "./context";
import {
  selectOutputFormat,
  assertFormatSupported,
  getDefaultLimit,
} from "./options";

export function createProgram(): Command {
  const program = new Command();

  program
    .name(CLI_NAME)
    .description(`${PRODUCT_NAME} - Local Knowledge Index and Retrieval`)
    .version(VERSION);

  // Global flags
  program
    .option("--index <name>", "index name", "default")
    .option("--config <path>", "config file path")
    .option("--no-color", "disable colors")
    .option("--verbose", "verbose logging")
    .option("--yes", "non-interactive mode");

  // Wire commands
  wireSearchCommands(program);
  wireOnboardingCommands(program);
  wireManagementCommands(program);
  wireRetrievalCommands(program);
  wireMcpCommand(program);

  return program;
}

function wireSearchCommands(program: Command): void {
  // Search command
  program
    .command("search <query>")
    .description("BM25 keyword search")
    .option("-n <num>", "max results")
    .option("--min-score <num>", "minimum score threshold")
    .option("-c, --collection <name>", "filter by collection")
    .option("--full", "include full content")
    .option("--line-numbers", "include line numbers")
    .option("--lang <code>", "language filter")
    .option("--json", "JSON output")
    .option("--md", "Markdown output")
    .option("--csv", "CSV output")
    .option("--xml", "XML output")
    .option("--files", "file paths only")
    .action(async (queryText, cmdOpts) => {
      const globals = resolveGlobalOptions(program.opts());
      const format = selectOutputFormat(cmdOpts);
      assertFormatSupported("search", format);

      const limit = cmdOpts.n
        ? parseInt(cmdOpts.n, 10)
        : getDefaultLimit(format);

      const { search, formatSearch } = await import("./commands/search");
      const result = await search(queryText, {
        ...cmdOpts,
        limit,
        configPath: globals.config,
        json: format === "json",
        md: format === "md",
        csv: format === "csv",
        xml: format === "xml",
        files: format === "files",
      });

      console.log(
        formatSearch(result, { ...cmdOpts, json: format === "json" })
      );

      if (!result.success) {
        throw new CliError("RUNTIME", result.error);
      }
    });

  // Similar pattern for vsearch, query, ask...
  // (abbreviated for plan readability)
}

function wireOnboardingCommands(program: Command): void {
  // init, index, status, doctor
}

function wireManagementCommands(program: Command): void {
  // collection, context, models, update, embed, cleanup
}

function wireRetrievalCommands(program: Command): void {
  // get, multi-get, ls (stub if not implemented)
}

function wireMcpCommand(program: Command): void {
  // mcp (stub if not implemented)
}
```

---

## Implementation Phases

### Phase 1: Core Infrastructure (MUST be done first)

Cross-cutting concerns that affect all commands:

- [ ] `src/cli/errors.ts` - CliError class, JSON envelope, exit codes
- [ ] `src/cli/context.ts` - Global options resolution (NO_COLOR support)
- [ ] `src/cli/options.ts` - Format selection, validation, conditional defaults
- [ ] `src/cli/run.ts` - Main runner with error handling
- [ ] `src/index.ts` - Bootstrap with SIGINT handler
- [ ] `src/app/constants.ts` - Add VERSION constant

### Phase 2: Search Commands

- [ ] Wire `search` command with explicit option mapping
- [ ] Wire `vsearch` command
- [ ] Wire `query` command
- [ ] Wire `ask` command
- [ ] Test format flag conflicts
- [ ] Test conditional defaults (-n based on format)

### Phase 3: Onboarding Commands

- [ ] Wire `init` command
- [ ] Wire `index` command
- [ ] Wire `status` command
- [ ] Wire `doctor` command

### Phase 4: Management Commands

- [ ] Wire `collection` subcommands (add, list, remove, rename)
- [ ] Wire `context` subcommands (add, list, check, rm)
- [ ] Wire `models` subcommands (list, pull, clear, path)
- [ ] Wire `update` command
- [ ] Wire `embed` command
- [ ] Wire `cleanup` command

### Phase 5: Retrieval Commands

- [ ] Wire `get` command (stub if not implemented)
- [ ] Wire `multi-get` command (stub if not implemented)
- [ ] Wire `ls` command (stub if not implemented)

### Phase 6: MCP Server

- [ ] Wire `mcp` command (stub if not implemented)
- [ ] Ensure stdout is protocol-clean (no logs)

### Phase 7: Polish

- [ ] Custom grouped help renderer (optional)
- [ ] Test all commands manually
- [ ] Update README

---

## Spec Alignment Checklist

Critical gaps identified in review:

- [ ] **Conditional defaults**: `-n` defaults to 5 (terminal) or 20 (structured)
- [ ] **JSON error envelope**: Errors return `{ error: { code, message, details } }`
- [ ] **NO_COLOR support**: Respect `NO_COLOR` env var
- [ ] **Format support matrix**: Enforce per-command allowed formats
- [ ] **Exit codes**: 0=success, 1=validation, 2=runtime
- [ ] **Option type mapping**: Commander camelCase → command options

---

## Acceptance Criteria

### Functional

- [ ] `gno --help` shows all commands
- [ ] `gno --version` shows version
- [ ] `gno search "test"` executes search command
- [ ] `gno query "test" --json` outputs JSON
- [ ] `gno query "test" --json --csv` errors (conflict)
- [ ] Exit codes match spec (0/1/2)
- [ ] `--verbose` enables debug output to stderr
- [ ] `--no-color` and `NO_COLOR` disable ANSI colors
- [ ] Ctrl+C exits gracefully with code 130
- [ ] `--json` errors return JSON envelope to stderr

### Quality

- [ ] Typecheck passes
- [ ] All tests pass
- [ ] Lint passes
- [ ] No `process.exit()` inside command actions

---

## Risks & Mitigations

| Risk                                                | Impact                | Mitigation                           |
| --------------------------------------------------- | --------------------- | ------------------------------------ |
| Spec duplication drift (Commander vs command types) | Inconsistent behavior | Explicit option mappers per command  |
| Missing command implementations                     | Can't wire all 22     | Stub with "Not implemented" + exit 2 |
| Commander async issues with Bun                     | Commands fail         | Use parseAsync(), test thoroughly    |
| Heavy module loading on --help                      | Slow startup          | Lazy imports only in action handlers |
| MCP stdout pollution                                | Protocol breaks       | Strict stderr for all logs           |

---

## Testing Plan

### Manual Testing Checklist

```bash
# Core infrastructure
gno --help
gno --version
gno nonexistent  # unknown command → exit 1

# Search with formats
gno search "test"
gno search "test" --json
gno search "test" --json --csv  # conflict → exit 1
gno search "test" -n 10

# Conditional defaults
gno search "test"  # -n defaults to 5
gno search "test" --json  # -n defaults to 20

# Error handling
gno search  # missing query → exit 1
gno query "test" --xml  # unsupported format for ask → exit 1 (if enforced)

# Global flags
NO_COLOR=1 gno search "test"  # no colors
gno search "test" --verbose  # debug to stderr

# Graceful shutdown
gno search "test"  # then Ctrl+C → exit 130
```

---

## References

### Internal

- `spec/cli.md` - CLI specification (authoritative)
- `src/cli/commands/index.ts` - Command exports
- `src/cli/commands/shared.ts` - Shared utilities
- `src/app/constants.ts` - CLI_NAME, etc.

### External

- [Commander.js Documentation](https://github.com/tj/commander.js)
- [NO_COLOR Standard](https://no-color.org/)
- [CLI Guidelines](https://clig.dev/)
- [12 Factor CLI Apps](https://medium.com/@jdxcode/12-factor-cli-apps-dd3c227a0e46)

---

## Future Considerations

- **Shell completion**: Generate bash/zsh/fish completions
- **Command aliases**: `gno q` for `gno query`
- **Progress indicators**: ora spinners for long operations
- **Grouped help**: Custom help renderer for command categories
