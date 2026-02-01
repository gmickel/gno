# feat: EPIC 1 - Specs and Contract Tests

**Type:** Epic
**Priority:** P0
**Beads ID:** gno-kos
**Date:** 2025-12-23

## Overview

Freeze CLI and MCP interfaces early via specification documents and contract tests before implementation expands. This establishes a spec-driven development workflow where no implementation merges without spec updates and executable contract tests.

## Problem Statement

GNO needs stable, versioned interfaces for:

- CLI commands (23+ commands, multiple output formats)
- MCP tools/resources (6 tools, URI-based resources)
- JSON output contracts (consistent shapes across CLI and MCP)

Without specs, implementation will drift from PRD intent and break consumers.

## Proposed Solution

Create three specification artifacts plus contract tests:

1. **spec/cli.md** - CLI command reference
2. **spec/mcp.md** - MCP server specification
3. **spec/output-schemas/\*.json** - JSON Schema contracts
4. **test/spec/schemas/** - Contract tests validating outputs

## Technical Approach

### Architecture

```
spec/
  cli.md                    # CLI command reference
  mcp.md                    # MCP server specification
  output-schemas/
    search-result.schema.json
    status.schema.json
    get.schema.json
    multi-get.schema.json
    ask.schema.json
    error.schema.json

test/
  spec/
    schemas/
      search-result.test.ts   # Contract tests per schema
      status.test.ts
      cli-output.test.ts      # CLI output validation
      mcp-tools.test.ts       # MCP tool contracts
  fixtures/
    outputs/                  # Golden output fixtures
      search-result.json
      status.json
```

### Technology Choices

| Concern           | Choice               | Rationale                            |
| ----------------- | -------------------- | ------------------------------------ |
| Schema validation | Ajv                  | Fastest, JSON Schema standard        |
| MCP tool schemas  | Zod                  | Already in MCP SDK, TypeScript-first |
| Test runner       | bun:test             | Already configured, Jest-compatible  |
| Schema format     | JSON Schema Draft-07 | VSCode/TS compatible                 |

### Schema Structure (per PRD §15.1)

**search-result.schema.json:**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "gno://schemas/search-result",
  "title": "GNO Search Result",
  "type": "object",
  "required": ["docid", "score", "uri", "snippet", "source"],
  "properties": {
    "docid": { "type": "string", "pattern": "^#[a-f0-9]{6,8}$" },
    "score": { "type": "number", "minimum": 0, "maximum": 1 },
    "uri": { "type": "string", "pattern": "^gno://[^/]+/.+" },
    "title": { "type": "string" },
    "snippetLanguage": { "type": "string" },
    "context": { "type": "string" },
    "snippet": { "type": "string" },
    "snippetRange": {
      "type": "object",
      "properties": {
        "startLine": { "type": "integer", "minimum": 1 },
        "endLine": { "type": "integer", "minimum": 1 }
      }
    },
    "source": {
      "type": "object",
      "required": ["relPath", "mime", "ext"],
      "properties": {
        "absPath": { "type": "string" },
        "relPath": { "type": "string" },
        "mime": { "type": "string" },
        "ext": { "type": "string", "pattern": "^\\." },
        "modifiedAt": { "type": "string", "format": "date-time" },
        "sizeBytes": { "type": "integer", "minimum": 0 },
        "sourceHash": { "type": "string" }
      }
    },
    "conversion": {
      "type": "object",
      "properties": {
        "converterId": { "type": "string" },
        "converterVersion": { "type": "string" },
        "mirrorHash": { "type": "string" },
        "warnings": { "type": "array", "items": { "type": "object" } }
      }
    }
  }
}
```

### Implementation Phases

#### Phase 1: CLI Specification (T1.1)

**File:** `spec/cli.md`

**Content:**

- Command catalog (all 23 commands from PRD §14.2)
- Global flags (--index, --config, --no-color, --verbose, --yes)
- Output format flags (--json, --files, --csv, --md, --xml)
- Exit codes (0=success, 1=validation, 2=runtime)
- Per-command documentation:
  - Synopsis
  - Options
  - Output format support matrix
  - Exit code semantics
  - Examples

**Commands to document:**

```
gno status
gno init [<path>] [--name] [--pattern] [--include] [--exclude] [--update] [--yes]
gno collection add|list|remove|rename
gno update [--git-pull]
gno index [--collection] [--no-embed] [--models-pull] [--git-pull] [--yes]
gno embed [--force] [--model] [--batch-size]
gno search <query> [-n] [--min-score] [-c] [--full] [--line-numbers] [--lang]
gno vsearch <query> [same opts]
gno query <query> [same opts + --no-expand, --no-rerank, --explain]
gno ask <query> [--answer] [--no-answer] [--max-answer-tokens]
gno get <ref> [:line] [--from] [-l] [--line-numbers] [--source]
gno multi-get <pattern-or-list> [--max-bytes] [--line-numbers]
gno ls [collection|gno://collection/prefix]
gno context add|list|check|rm
gno models list|pull|clear|path
gno cleanup
gno doctor
gno mcp
```

**Output format support matrix:**
| Command | --json | --files | --csv | --md | --xml |
|---------|--------|---------|-------|------|-------|
| search | yes | yes | yes | yes | yes |
| vsearch | yes | yes | yes | yes | yes |
| query | yes | yes | yes | yes | yes |
| ask | yes | no | no | yes | no |
| get | yes | no | no | yes | no |
| multi-get| yes | yes | no | yes | no |
| status | yes | no | no | yes | no |
| ls | yes | yes | no | yes | no |
| collection list | yes | no | no | yes | no |
| context list | yes | no | no | yes | no |
| models list | yes | no | no | yes | no |
| doctor | yes | no | no | yes | no |

#### Phase 2: MCP Specification (T1.2)

**File:** `spec/mcp.md`

**Content:**

- Server info (name: "gno", transport: stdio)
- Capabilities declaration
- Tools (6):
  - gno_search - BM25 keyword search
  - gno_vsearch - vector semantic search
  - gno_query - hybrid search
  - gno_get - retrieve single document
  - gno_multi_get - retrieve multiple documents
  - gno_status - index status
- Resources (gno://{collection}/{path})
- Error handling
- Versioning strategy

**Tool schema pattern:**

```typescript
{
  name: "gno_search",
  description: "BM25 keyword search over indexed documents",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      collection: { type: "string", description: "Optional collection filter" },
      limit: { type: "integer", default: 5, maximum: 100 },
      minScore: { type: "number", minimum: 0, maximum: 1 }
    },
    required: ["query"]
  },
  outputSchema: { "$ref": "gno://schemas/search-results" }
}
```

#### Phase 3: JSON Schemas (T1.3)

**Files:**

```
spec/output-schemas/
  search-result.schema.json    # Single result item
  search-results.schema.json   # Array wrapper + metadata
  status.schema.json           # gno status output
  get.schema.json              # gno get output
  multi-get.schema.json        # gno multi-get output
  ask.schema.json              # gno ask output (PRD §15.4)
  error.schema.json            # Error output shape
```

**ask.schema.json (per PRD §15.4):**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "gno://schemas/ask",
  "title": "GNO Ask Response",
  "type": "object",
  "required": ["query", "mode", "results", "meta"],
  "properties": {
    "query": { "type": "string" },
    "mode": { "enum": ["hybrid", "bm25_only"] },
    "queryLanguage": { "type": "string", "default": "auto" },
    "answer": { "type": "string" },
    "citations": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "docid": { "type": "string" },
          "uri": { "type": "string" },
          "startLine": { "type": "integer" },
          "endLine": { "type": "integer" }
        }
      }
    },
    "results": {
      "type": "array",
      "items": { "$ref": "search-result.schema.json" }
    },
    "meta": {
      "type": "object",
      "properties": {
        "expanded": { "type": "boolean" },
        "reranked": { "type": "boolean" },
        "vectorsUsed": { "type": "boolean" }
      }
    }
  }
}
```

#### Phase 4: Contract Tests (T1.4)

**Files:**

```
test/spec/schemas/
  validator.ts          # Ajv setup + helpers
  search-result.test.ts
  status.test.ts
  get.test.ts
  multi-get.test.ts
  ask.test.ts
  error.test.ts

test/fixtures/outputs/
  search-result-valid.json
  search-result-minimal.json
  status-healthy.json
  error-validation.json
```

**validator.ts:**

```typescript
import Ajv from "ajv";
import addFormats from "ajv-formats";

const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);

export function loadSchema(name: string) {
  const path = `spec/output-schemas/${name}.schema.json`;
  return Bun.file(path).json();
}

export function createValidator(schema: object) {
  return ajv.compile(schema);
}

export function assertValid(data: unknown, schema: object) {
  const validate = createValidator(schema);
  const valid = validate(data);
  if (!valid) {
    throw new Error(JSON.stringify(validate.errors, null, 2));
  }
  return true;
}
```

**search-result.test.ts:**

```typescript
import { describe, test, expect, beforeAll } from "bun:test";
import { loadSchema, assertValid } from "./validator";

describe("search-result schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("search-result");
  });

  test("validates minimal valid result", () => {
    const result = {
      docid: "#a1b2c3",
      score: 0.78,
      uri: "gno://work/doc.md",
      snippet: "sample text",
      source: {
        relPath: "doc.md",
        mime: "text/markdown",
        ext: ".md",
      },
    };
    expect(assertValid(result, schema)).toBe(true);
  });

  test("validates full result with all optional fields", async () => {
    const fixture = await Bun.file(
      "test/fixtures/outputs/search-result-valid.json"
    ).json();
    expect(assertValid(fixture, schema)).toBe(true);
  });

  test("rejects invalid docid format", () => {
    const result = {
      docid: "invalid", // missing # prefix
      score: 0.5,
      uri: "gno://work/doc.md",
      snippet: "text",
      source: { relPath: "doc.md", mime: "text/markdown", ext: ".md" },
    };
    expect(() => assertValid(result, schema)).toThrow();
  });

  test("rejects score out of range", () => {
    const result = {
      docid: "#abc123",
      score: 1.5, // > 1
      uri: "gno://work/doc.md",
      snippet: "text",
      source: { relPath: "doc.md", mime: "text/markdown", ext: ".md" },
    };
    expect(() => assertValid(result, schema)).toThrow();
  });

  test("rejects invalid uri format", () => {
    const result = {
      docid: "#abc123",
      score: 0.5,
      uri: "file:///path/doc.md", // wrong scheme
      snippet: "text",
      source: { relPath: "doc.md", mime: "text/markdown", ext: ".md" },
    };
    expect(() => assertValid(result, schema)).toThrow();
  });
});
```

## Acceptance Criteria

### Functional Requirements

- [ ] spec/cli.md documents all 23 commands from PRD §14.2
- [ ] spec/cli.md includes exit code table with semantics
- [ ] spec/cli.md includes output format support matrix
- [ ] spec/mcp.md documents all 6 MCP tools
- [ ] spec/mcp.md documents gno:// resource pattern
- [ ] All JSON schemas validate against JSON Schema Draft-07
- [ ] Contract tests exist for each schema
- [ ] Contract tests cover both valid and invalid inputs
- [ ] `bun test` passes with all contract tests

### Non-Functional Requirements

- [ ] Schemas use consistent naming (kebab-case files)
- [ ] Schemas include $id and description fields
- [ ] Specs cross-reference schemas by relative path
- [ ] Tests run in <1s total

### Quality Gates

- [ ] Zero Ajv compilation errors on all schemas
- [ ] 100% of required fields documented in specs
- [ ] At least 2 test cases per schema (valid + invalid)

## Dependencies & Prerequisites

- PRD docs/prd.md (complete) - source of truth for interfaces
- src/app/constants.ts (complete) - naming conventions
- Bun test runner (configured) - test infrastructure
- Ajv package (to install) - schema validation

**Install:**

```bash
bun add -d ajv ajv-formats
```

## Design Decisions

### Decision 1: Separate schema files vs monolithic

**Choice:** Separate files per output type

**Rationale:**

- Easier to maintain and version independently
- Clearer mapping to CLI commands
- Supports $ref composition

### Decision 2: Required vs optional fields

**Choice:** Minimal required set from PRD §15.1

**Required fields:**

- docid, score, uri, snippet, source.{relPath, mime, ext}

**Optional fields:**

- title, snippetLanguage, context, snippetRange
- source.{absPath, modifiedAt, sizeBytes, sourceHash}
- conversion.\*

**Rationale:** PRD says "source.absPath is included when --source is set or output is from MCP tools"

### Decision 3: Error output format

**Choice:** Errors go to stderr, JSON errors wrap in {error: {...}}

**Rationale:** Follows ripgrep/jq patterns, allows piping stdout cleanly

### Decision 4: CLI/MCP shape consistency

**Choice:** MCP tools return same JSON shape as CLI --json

**Rationale:** PRD §16.3 says "Each tool returns... structuredContent: machine-readable payloads matching schemas"

## References & Research

### Internal References

- PRD: docs/prd.md (§14 CLI, §15 Output, §16 MCP)
- Constants: src/app/constants.ts:1-294
- Existing tests: test/spec/app/constants.test.ts

### External References

- [JSON Schema Draft-07](https://json-schema.org/specification-links.html#draft-7)
- [Ajv Documentation](https://ajv.js.org/)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [ripgrep JSON format](https://docs.rs/grep-printer/*/grep_printer/struct.JSON.html)
- [POSIX Exit Codes](https://man.openbsd.org/sysexits.3)

### Related Work

- EPIC 0 (closed): gno-8db - scaffold and constants

## Task Breakdown

### T1.1: Write spec/cli.md [P0]

- Document all 23 commands
- Global flags section
- Output format matrix
- Exit code semantics
- Per-command examples

### T1.2: Write spec/mcp.md [P0]

- Server capabilities
- 6 tool definitions with schemas
- Resource URI pattern
- Versioning rules

### T1.3: Write spec/output-schemas/\*.json [P0]

- search-result.schema.json
- search-results.schema.json
- status.schema.json
- get.schema.json
- multi-get.schema.json
- ask.schema.json
- error.schema.json

### T1.4: Add contract tests [P1]

- Install ajv, ajv-formats
- Create validator.ts helpers
- Write test per schema
- Add golden fixtures

## Risks

| Risk                  | Likelihood | Impact | Mitigation                                         |
| --------------------- | ---------- | ------ | -------------------------------------------------- |
| PRD §15.1 changes     | Medium     | High   | Spec-driven: PRD changes require spec update first |
| Schema too strict     | Medium     | Medium | Start permissive, tighten based on implementation  |
| MCP SDK version drift | Low        | Medium | Pin SDK version, monitor releases                  |

## Open Questions (Resolved)

1. **Q: Single vs multiple schema files?** A: Multiple files, one per output type
2. **Q: Required fields?** A: docid, score, uri, snippet, source.{relPath, mime, ext}
3. **Q: Error handling?** A: Errors to stderr; with --json, wrap in {error: {...}}
4. **Q: MCP shape matches CLI?** A: Yes, identical JSON structure
5. **Q: Exit code semantics?** A: Per PRD - 0=success, 1=validation, 2=runtime
