# feat: Wire --full and --line-numbers through search formatters

## Overview

Complete EPIC 8 search pipeline by wiring `--full` and `--line-numbers` options through all search command formatters. Currently:

- `--full` exists in program.ts but formatters don't receive it
- `--line-numbers` documented in spec but not implemented
- `formatSearch()` only receives `{ json: boolean }` — all other format flags ignored
- Terminal formatter flattens newlines, making line numbers meaningless

## Problem Statement

**Root cause**: `program.ts` passes options to `search()` but NOT to `formatSearch()`.

```typescript
// Current broken state (program.ts):
const result = await search(queryText, {
  full: Boolean(cmdOpts.full), // ✅ reaches pipeline
  // ...
});
process.stdout.write(
  `${formatSearch(result, { json: format === "json" })}\n` // ❌ no full, no md, no xml...
);
```

Additional issues:

- Terminal formatters truncate to 200-500 chars ignoring any options
- `formatTerminal()` does `snippet.replace(/\n/g, ' ')` — line numbers impossible
- No mechanism to emit warnings to stderr from formatters (return string only)
- `--lang` documented in spec for search/vsearch but not wired in program.ts (separate issue)

## Proposed Solution

### Design Decisions

| Question                   | Decision                                        | Rationale                          |
| -------------------------- | ----------------------------------------------- | ---------------------------------- |
| Line number indexing       | 1-indexed                                       | Matches editors, grep, ripgrep     |
| Line number format         | `{n} \| ` (dynamic width, no extra indent)      | Ripgrep-style, copy-paste friendly |
| --full scope               | All formats                                     | Consistency                        |
| Line numbers in JSON/XML   | Use existing `snippetRange` metadata            | Don't mutate content               |
| Absolute vs relative lines | Absolute (use `snippetRange.startLine`)         | Editor jump support                |
| Terminal newline handling  | Preserve newlines (no flatten)                  | Required for line numbers          |
| Warnings (>10MB)           | Emit in program.ts before formatting            | Formatters stay pure               |
| Warning trigger            | Only when `full=true` AND format shows snippets | Skip for --files/--csv             |
| Size measurement           | JS string length (UTF-16 code units)            | Simple, consistent                 |
| CRLF handling              | Normalize to LF before processing               | Cross-platform consistency         |
| XML content escaping       | Always escape `&<>` in snippet content          | Valid XML even with --full         |

### Type Boundaries

Maintain clear separation between pipeline and formatting concerns:

```typescript
// Pipeline options (what search() consumes)
type SearchPipelineOptions = {
  limit?: number;
  collection?: string;
  full?: boolean;
  lang?: string;
  // ... other pipeline concerns
};

// Format options (what formatters consume)
type SearchFormatOptions = {
  format: "terminal" | "json" | "md" | "csv" | "xml" | "files";
  full?: boolean;
  lineNumbers?: boolean;
};
```

### Architecture

```
program.ts
    ↓
  Build pipelineOpts and formatOpts separately
    ↓
  Call search(query, pipelineOpts)
    ↓
  Emit warnings to stderr (only if full=true AND format shows snippets)
    ↓
  Call formatSearch(result, formatOpts)
    ↓
  Shared renderSnippet() helper applies truncation + line numbers
```

## Technical Approach

### Phase 0: Fix Formatter Option Passing (prerequisite)

**File: src/cli/program.ts**

Build separate options objects for pipeline and formatting:

```typescript
// For each of search, vsearch, query commands:
.action(async (queryText: string, cmdOpts: Record<string, unknown>) => {
  // ... existing validation ...

  // Pipeline options
  const pipelineOpts: SearchOptions = {
    limit,
    collection: cmdOpts.collection as string | undefined,
    full: Boolean(cmdOpts.full),
  };

  // Format options (single format guaranteed by selectOutputFormat)
  const formatOpts: SearchFormatOptions = {
    format,  // 'terminal' | 'json' | 'md' | 'csv' | 'xml' | 'files'
    full: Boolean(cmdOpts.full),
    lineNumbers: Boolean(cmdOpts.lineNumbers),
  };

  const result = await search(queryText, pipelineOpts);

  // Warnings only when format shows snippets
  const showsSnippets = !['files', 'csv'].includes(format);
  if (formatOpts.full && showsSnippets && result.success) {
    emitLargeFileWarnings(result.data.results);
  }

  process.stdout.write(`${formatSearch(result, formatOpts)}\n`);
});
```

### Phase 1: Shared Snippet Rendering

**File: src/cli/commands/formatting.ts** (new)

Consolidate all snippet formatting logic to prevent drift across commands:

```typescript
export type SnippetRange = { startLine: number; endLine: number };

export type SnippetRenderOptions = {
  full: boolean;
  lineNumbers: boolean;
  truncateChars: number; // e.g., 200 for terminal, 500 for md/xml
  truncateLines: number; // e.g., 10 when lineNumbers && !full
  range?: SnippetRange;
};

/**
 * Render snippet with optional truncation and line numbers.
 * Normalizes CRLF to LF for cross-platform consistency.
 */
export function renderSnippet(
  text: string,
  opts: SnippetRenderOptions
): { text: string; truncated: boolean } {
  // Normalize line endings
  let content = text.replace(/\r\n/g, "\n");
  let truncated = false;

  if (!opts.full) {
    if (opts.lineNumbers) {
      // Truncate by lines when showing line numbers
      const lines = content.split("\n");
      if (lines.length > opts.truncateLines) {
        content = lines.slice(0, opts.truncateLines).join("\n");
        truncated = true;
      }
    } else {
      // Truncate by chars otherwise
      if (content.length > opts.truncateChars) {
        content = content.slice(0, opts.truncateChars);
        truncated = true;
      }
    }
  }

  if (opts.lineNumbers) {
    content = addLineNumbers(content, opts.range?.startLine ?? 1);
  }

  return { text: content, truncated };
}

/**
 * Add line numbers to content (1-indexed, dynamic width).
 */
export function addLineNumbers(content: string, startLine = 1): string {
  const lines = content.split("\n");
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, i) => `${String(startLine + i).padStart(width)} | ${line}`)
    .join("\n");
}

/**
 * Escape XML special characters.
 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
```

### Phase 2: Update Formatters

**File: src/cli/commands/search.ts**

Update formatters to use shared helper:

```typescript
import { renderSnippet, escapeXml } from "./formatting";

function formatTerminal(
  data: SearchResults,
  options: SearchFormatOptions
): string {
  // NO MORE: snippet.replace(/\n/g, ' ')
  // Preserve newlines for readable multi-line output

  for (const result of data.results) {
    const { text: snippet, truncated } = renderSnippet(result.snippet, {
      full: options.full ?? false,
      lineNumbers: options.lineNumbers ?? false,
      truncateChars: 200,
      truncateLines: 10,
      range: result.snippetRange,
    });

    // Output snippet (no extra indentation when line numbers present)
    lines.push(snippet + (truncated ? "..." : ""));
  }
  // ...
}

function formatXml(data: SearchResults, options: SearchFormatOptions): string {
  for (const result of data.results) {
    const { text: snippet } = renderSnippet(result.snippet, {
      full: options.full ?? false,
      lineNumbers: false, // XML uses metadata, not inline numbers
      truncateChars: 500,
      truncateLines: 20,
      range: result.snippetRange,
    });

    // Add line range attributes when available
    const rangeAttrs = result.snippetRange
      ? ` startLine="${result.snippetRange.startLine}" endLine="${result.snippetRange.endLine}"`
      : "";

    lines.push(`<snippet${rangeAttrs}>${escapeXml(snippet)}</snippet>`);
  }
  // ...
}
```

### Phase 3: Add --line-numbers to CLI

**File: src/cli/program.ts**

Add option to all three commands (spec already documents it):

```typescript
program
  .command("search <query>")
  .option("--full", "include full content")
  .option("--line-numbers", "prepend line numbers to output");
// ...
```

### Phase 4: Warnings in program.ts

**File: src/cli/program.ts**

```typescript
const MAX_FULL_SIZE_CHARS = 10 * 1024 * 1024; // ~10MB in UTF-16 code units

function emitLargeFileWarnings(results: SearchResult[], quiet: boolean): void {
  if (quiet) return; // Respect --quiet flag
  for (const r of results) {
    if (r.snippet.length > MAX_FULL_SIZE_CHARS) {
      const sizeMB = (r.snippet.length / 1024 / 1024).toFixed(1);
      process.stderr.write(`Warning: ${r.uri} is ~${sizeMB}MB\n`);
    }
  }
}
```

## Acceptance Criteria

### Functional Requirements

- [ ] `gno search "q" --full` shows full content (no truncation)
- [ ] `gno search "q" --full --md` shows full content in markdown code blocks
- [ ] `gno search "q" --full --xml` shows full content with `startLine`/`endLine` attrs
- [ ] `gno search "q" --line-numbers` prepends line numbers (1-indexed, absolute)
- [ ] `gno search "q" --full --line-numbers` combines both
- [ ] Terminal output preserves newlines (not flattened to single line)
- [ ] Same for `vsearch` and `query` commands
- [ ] `--files` and `--csv` unaffected (no snippet display)
- [ ] XML content properly escaped even with --full

### Non-Functional Requirements

- [ ] Files >10MB with --full emit warning to stderr
- [ ] Warnings only emit when format shows snippets (not --files/--csv)
- [ ] Line numbers 1-indexed, dynamically padded width
- [ ] Missing `snippetRange.startLine` defaults to 1
- [ ] CRLF normalized to LF before processing

### Quality Gates

- [ ] Unit tests for `renderSnippet()` helper with all flag combinations
- [ ] Unit tests for each formatter + flag combination
- [ ] Lint passes (`bun run lint`)
- [ ] Type check passes (`bun run typecheck`)

## File Modification Checklist

```
src/cli/program.ts                         # Pass formatOpts to formatters, add --line-numbers, add warnings
src/cli/commands/formatting.ts             # NEW: renderSnippet(), addLineNumbers(), escapeXml()
src/cli/commands/search.ts                 # Use renderSnippet(), preserve newlines
src/cli/commands/vsearch.ts                # Same updates
src/cli/commands/query.ts                  # Same updates
```

## Testing Strategy

```bash
# Manual smoke tests
gno search "test" --full
gno search "test" --full --md
gno search "test" --full --xml
gno search "test" --full --json
gno search "test" --line-numbers
gno search "test" --full --line-numbers

# Verify newlines preserved
gno search "function" --line-numbers | head -20

# Verify no warnings for --files
gno search "test" --full --files 2>&1 | grep Warning  # should be empty

# Same for vsearch and query
gno vsearch "semantic query" --full
gno query "hybrid" --line-numbers
```

## Edge Cases

| Case                              | Expected Behavior                              |
| --------------------------------- | ---------------------------------------------- |
| Empty file                        | Show nothing (or file metadata only)           |
| Single-line file                  | Line number "1" with content                   |
| No newlines                       | Treat as single line (line 1)                  |
| Missing `snippetRange`            | Default startLine to 1                         |
| File >10MB                        | Warn to stderr (only if format shows snippets) |
| `--line-numbers` without `--full` | Truncate by lines (~10), not by chars          |
| CRLF line endings                 | Normalize to LF                                |
| XML special chars (`&<>`)         | Always escaped                                 |

## Out of Scope (Known Issues)

- `--lang` wiring for search/vsearch (documented in spec, not wired in program.ts) — separate issue
- Binary file detection — would need content inspection in pipeline
- Streaming for very large files — current architecture buffers

## Dependencies

- Existing `SearchResult` type has `snippetRange?: { startLine; endLine }` (src/pipeline/types.ts)
- Existing `snippet` field contains full content when `full=true` (wired in pipeline)
- `SearchOptions` already includes `full?: boolean` and `lineNumbers?: boolean`

## References

### Internal

- `src/pipeline/types.ts` — SearchResult with snippetRange
- `spec/cli.md` — documents --line-numbers (already in spec)
- `spec/output-schemas/search-result.schema.json` — output schema

### External

- [ripgrep --line-number behavior](https://manpages.debian.org/testing/ripgrep/rg.1.en.html)
- [grep context control](https://www.gnu.org/software/grep/manual/html_node/Context-Line-Control.html)
- [Commander.js options](https://github.com/tj/commander.js#options)

### Related Beads

- gno-h7i — EPIC 8: Search pipelines
- gno-h7i.1 — T8.1: gno search (BM25)
- gno-h7i.2 — T8.2: gno vsearch (vector)
- gno-h7i.3 — T8.3: gno query (hybrid)
