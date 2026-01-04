# Testing

GNO test suite using Bun's built-in test runner.

## Structure

```
test/
├── cli/           # CLI command tests
├── mcp/           # MCP server tests
├── serve/         # Web UI/API tests
├── pipeline/      # Search pipeline tests
├── llm/           # LLM adapter tests
├── store/         # SQLite store tests
├── config/        # Configuration tests
├── converters/    # File converter tests
├── ingestion/     # Document ingestion tests
├── spec/          # Contract tests (schema validation)
│   └── schemas/   # JSON schema validators
├── eval/          # Evaluation framework tests
├── fixtures/      # Test data
│   ├── docs/      # Sample documents
│   ├── docs-corpus/ # Larger test corpus
│   ├── config/    # Config file examples
│   ├── conversion/ # Converter test files
│   └── outputs/   # Expected outputs
└── helpers/       # Test utilities
    └── cleanup.ts # DB cleanup helpers
```

## Running Tests

```bash
# All tests
bun test

# Specific directory
bun test test/cli/
bun test test/pipeline/

# Single file
bun test test/cli/search.test.ts

# Watch mode
bun test --watch
```

## Test Patterns

### Basic Test

```typescript
import { test, expect } from "bun:test";

test("description", () => {
  expect(result).toBe(expected);
});
```

### Async Test

```typescript
test("async operation", async () => {
  const result = await someAsyncFn();
  expect(result).toMatchObject({ key: "value" });
});
```

### Using Fixtures

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixture = readFileSync(
  join(__dirname, "../fixtures/docs/sample.md"),
  "utf-8"
);
```

## Contract Tests

Tests in `test/spec/schemas/` validate JSON outputs against schemas:

```typescript
import schema from "../../../spec/output-schemas/search-results.schema.json";

test("output matches schema", () => {
  // Run command with --json
  // Validate against schema
});
```

## Test Database

Tests use isolated SQLite databases via helpers:

```typescript
import { createTestDb, cleanup } from "../helpers/cleanup";

let db: Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  cleanup(db);
});
```

## Guidelines

- Use `bun:test` imports, not jest/vitest
- Prefer async/await over done callbacks
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat
- Use fixtures for test data, don't inline large strings

## Tag Contract Tests

Tag system schema validation in `test/spec/schemas/`:

- `tags.schema.test.ts` - Validates list_tags, tag add/remove responses
- Tests tag normalization (lowercase, trim) and validation rules
- Covers both frontmatter and user-added tag sources
