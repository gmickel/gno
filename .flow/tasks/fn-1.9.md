# T13.2: CLI wrapper module

**Migrated from:** gno-ub9.10
**Priority:** P1

## Description

Create CLI wrapper for executing gno commands.

## File

src/lib/cli.ts

## Functions

```typescript
// Execute gno search (BM25)
async function gnoSearch(
  query: string,
  limit?: number
): Promise<SearchResult[]>;

// Execute gno query (hybrid)
async function gnoQuery(query: string, limit?: number): Promise<SearchResult[]>;

// Execute gno ask (AI answer) - fallback when API unavailable
async function gnoAsk(query: string): Promise<AskResponse>;

// Check if gno is installed
async function isGnoInstalled(): Promise<boolean>;

// Get gno version
async function getGnoVersion(): Promise<string>;
```

## Implementation Pattern

```typescript
import { exec } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);

async function gnoSearch(query: string, limit = 10): Promise<SearchResult[]> {
  const { stdout } = await execAsync(
    `gno search --json --limit ${limit} ${JSON.stringify(query)}`
  );
  const result = JSON.parse(stdout);
  return result.results;
}
```

## Error Handling

- ENOENT: gno not installed
- Non-zero exit: parse stderr for error
- Invalid JSON: wrap in runtime error

## Checklist

- [ ] gnoSearch implementation
- [ ] gnoQuery implementation
- [ ] gnoAsk implementation
- [ ] isGnoInstalled check
- [ ] Error handling for all cases

## Acceptance Criteria

- [ ] Implementation complete
- [ ] Tests passing
