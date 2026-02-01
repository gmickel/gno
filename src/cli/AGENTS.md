# CLI Commands

GNO command-line interface using Commander.js.

## Architecture

```
src/cli/
├── program.ts         # Main Commander program with all commands
├── run.ts             # Entry point, error handling
├── context.ts         # CliContext with adapters
├── options.ts         # Shared option definitions
├── errors.ts          # Error types and exit codes
├── colors.ts          # Terminal color utilities
├── progress.ts        # Progress indicators
├── ui.ts              # User interaction helpers
├── format/            # Output formatters (json, csv, md, xml)
└── commands/          # Command implementations
    ├── search.ts
    ├── query.ts
    ├── ask.ts
    ├── tags.ts        # Tag management (list, add, remove)
    └── ...
```

## Specification

See `spec/cli.md` for full CLI specification including:

- Exit codes (0=success, 1=validation, 2=runtime)
- Global flags (--index, --json, --verbose, etc.)
- Output format support matrix
- All command schemas

**Always update spec/cli.md first** when adding/modifying commands.

## Command Pattern

Commands follow this structure in `program.ts`:

```typescript
program
  .command("search <query>")
  .description("BM25 keyword search")
  .option("-l, --limit <n>", "Max results", "10")
  .option("-c, --collection <name>", "Filter by collection")
  .addOption(formatOption) // From options.ts
  .action(async (query, opts) => {
    await runSearch(query, opts);
  });
```

## Exit Codes

```typescript
export const EXIT = {
  SUCCESS: 0, // Command completed successfully
  VALIDATION: 1, // Bad args, missing params
  RUNTIME: 2, // IO, DB, model, network errors
} as const;
```

## Output Formats

All search/query commands support multiple formats:

- `--json` - Machine-readable JSON
- `--files` - Line protocol for piping
- `--csv` - Spreadsheet compatible
- `--md` - Markdown tables
- `--xml` - XML format

Format handlers in `src/cli/format/`.

## CliContext

Created at command execution, holds adapters:

```typescript
interface CliContext {
  store: SqliteAdapter;
  config: Config;
  embedPort?: EmbeddingPort;
  genPort?: GenerationPort;
  rerankPort?: RerankPort;
}
```

## Testing

CLI tests in `test/cli/`:

```bash
bun test test/cli/
```

Use `--json` output for assertions in tests.

## Tag Commands

Tag management commands in `src/cli/commands/tags.ts`:

```bash
# List all tags (with doc counts)
gno tags

# Add tags to document
gno tag add <path> tag1 tag2

# Remove tags from document
gno tag remove <path> tag1

# Filter search/query by tags
gno search "query" --tags=foo,bar
```

- Tags normalized via `src/core/tags.ts`: lowercase, trimmed, validated
- Stored in `doc_tags` junction table with `source` column (frontmatter|user)
- Frontmatter tags extracted during ingestion (`src/ingestion/frontmatter.ts`)
- User-added tags can be removed; frontmatter tags are read-only
