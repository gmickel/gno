# feat: gno get/multi-get/ls Implementation Plan

**Issue Refs:** gno-n5m.2 (T9.2), gno-n5m.3 (T9.3)
**Priority:** P0 (get/multi-get), P2 (ls)
**Date:** 2025-12-26
**Review Status:** Updated after Carmack-level review

---

## Overview

Implement three retrieval commands for the GNO CLI:

1. `gno get <ref>` - Retrieve single document by reference
2. `gno multi-get <refs...>` - Retrieve multiple documents
3. `gno ls [scope]` - List indexed documents

All specs defined in `spec/cli.md`, schemas in `spec/output-schemas/`.

---

## Technical Context

### Existing Infrastructure

| Component       | Location                                                       | Purpose                                                                                |
| --------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Store adapter   | `src/store/sqlite/adapter.ts`                                  | `getDocumentByDocid`, `getDocumentByUri`, `getDocument`, `listDocuments`, `getContent` |
| Command pattern | `src/cli/commands/search.ts`                                   | Reference for result types, formatters                                                 |
| Shared init     | `src/cli/commands/shared.ts`                                   | `initStore()` for DB access                                                            |
| Format helpers  | `src/cli/format/search-results.ts`                             | `addLineNumbers`, `escapeCsv`, `escapeXml`                                             |
| CLI stubs       | `src/cli/program.ts:558-600`                                   | `wireRetrievalCommands()` stubs                                                        |
| Schemas         | `spec/output-schemas/get.schema.json`, `multi-get.schema.json` | JSON output contracts                                                                  |
| Error handling  | `src/cli/errors.ts`                                            | `CliError` class for VALIDATION/RUNTIME exits                                          |
| CLI runner      | `src/cli/run.ts`                                               | Centralized exit code handling, JSON error envelopes                                   |

### Key Design Decisions

1. **Line numbers are 1-indexed**, `returnedLines.end` is inclusive (lines 10-14 = 5 lines)
2. **--max-bytes is per-document**, not aggregate (per schema `truncated` field)
3. **Truncation at line boundary** ≤ maxBytes using `TextEncoder` for UTF-8 safety
4. **Ref resolution priority**: docid (#) > URI (gno://) > collection/path
5. **Inactive docs excluded** by filtering at command layer (`!doc.active` = not found)
6. **Line suffix parsing**: Allow `:(\d+)$` suffix for URI and collPath refs only (not docid)
7. **--from overrides :line suffix** when both specified
8. **Glob expansion** happens in multi-get command, not in parser (layering)
9. **Error handling via CliError** - throw, don't `process.exit()` in handlers
10. **Formatters never emit errors** - only format success payloads; errors throw `CliError` and are emitted by `run.ts` to stderr

---

## Acceptance Criteria

### gno get

- [ ] Retrieve document by `gno://collection/path`
- [ ] Retrieve document by `collection/path`
- [ ] Retrieve document by `#docid`
- [ ] Parse `:line` suffix for starting line (URI and collPath only)
- [ ] Support `--from <line>` and `-l <lines>` for range
- [ ] Support `--line-numbers` flag
- [ ] Support `--source` flag for metadata
- [ ] Output formats: terminal, `--json`, `--md`
- [ ] Exit 1 for invalid ref format
- [ ] Exit 2 for document not found or mirror unavailable

### gno multi-get

- [ ] Accept space-separated refs
- [ ] Accept comma-separated refs
- [ ] Support glob patterns (`work/*.md`) via `minimatch`
- [ ] Apply `--max-bytes` per-document limit (default: 10240)
- [ ] Truncate at line boundary with `truncated: true` flag
- [ ] Track skipped docs with reasons: `not_found`, `conversion_error`
- [ ] Support `--line-numbers` flag
- [ ] Output formats: terminal, `--json`, `--files`, `--md`
- [ ] Exit 0 even with partial failures

### gno ls

- [ ] List all documents when no scope
- [ ] Filter by collection name
- [ ] Filter by URI prefix (`gno://work/contracts`)
- [ ] Output formats: terminal, `--json`, `--files`, `--md`
- [ ] Sort by URI alphabetically
- [ ] Exit 0 on success, Exit 1 on invalid scope

---

## Implementation Plan

### Phase 1: Ref Parser (Pure Parsing Only)

**File:** `src/cli/commands/ref-parser.ts` (new)

```ts
// ref-parser.ts - Pure lexical parsing, NO store/config access

export type RefType = "docid" | "uri" | "collPath";

export type ParsedRef = {
  type: RefType;
  value: string; // normalized ref (without :line suffix)
  collection?: string; // for collPath
  relPath?: string; // for collPath
  line?: number; // parsed :line suffix (1-indexed)
};

export type ParseRefResult = ParsedRef | { error: string };

/**
 * Parse a single ref string.
 * - Docid: starts with # (no :line suffix allowed)
 * - URI: starts with gno:// (optional :N suffix)
 * - Else: collection/path (optional :N suffix)
 */
export function parseRef(ref: string): ParseRefResult {
  // 1. DocID: starts with #, validate pattern
  if (ref.startsWith("#")) {
    if (ref.includes(":")) {
      return { error: "Docid refs cannot have :line suffix" };
    }
    // Validate docid format: #[a-f0-9]{6,8}
    if (!/^#[a-f0-9]{6,8}$/.test(ref)) {
      return { error: `Invalid docid format: ${ref}` };
    }
    return { type: "docid", value: ref };
  }

  // 2. Parse optional :line suffix for URI and collPath
  let line: number | undefined;
  let baseRef = ref;
  const lineMatch = ref.match(/:(\d+)$/);
  if (lineMatch) {
    line = parseInt(lineMatch[1], 10);
    baseRef = ref.slice(0, -lineMatch[0].length);
  }

  // 3. URI: starts with gno://
  if (baseRef.startsWith("gno://")) {
    return { type: "uri", value: baseRef, line };
  }

  // 4. Collection/path: must contain /
  const slashIdx = baseRef.indexOf("/");
  if (slashIdx === -1) {
    return { error: `Invalid ref format (missing /): ${ref}` };
  }
  const collection = baseRef.slice(0, slashIdx);
  const relPath = baseRef.slice(slashIdx + 1);

  return { type: "collPath", value: baseRef, collection, relPath, line };
}

/**
 * Split comma-separated refs. Does NOT expand globs.
 */
export function splitRefs(refs: string[]): string[] {
  const result: string[] = [];
  for (const r of refs) {
    for (const part of r.split(",")) {
      const trimmed = part.trim();
      if (trimmed) result.push(trimmed);
    }
  }
  return result;
}

/**
 * Check if a ref contains glob characters.
 */
export function isGlobPattern(ref: string): boolean {
  return /[*?[\]]/.test(ref);
}
```

### Phase 2: gno get Command

**File:** `src/cli/commands/get.ts` (new)

````ts
// get.ts - follows search.ts pattern

import { CliError } from "../errors";
import { addLineNumbers } from "../format/search-results";
import { parseRef, type ParsedRef } from "./ref-parser";
import { initStore } from "./shared";

export type GetCommandOptions = {
  configPath?: string;
  from?: number; // --from <line>, overrides :line suffix
  limit?: number; // -l <lines>
  lineNumbers?: boolean;
  source?: boolean;
  json?: boolean;
  md?: boolean;
};

export type GetResult =
  | { success: true; data: GetResponse }
  | { success: false; error: string; isValidation?: boolean };

export type GetResponse = {
  docid: string;
  uri: string;
  title?: string;
  content: string;
  totalLines: number;
  returnedLines?: { start: number; end: number };
  language?: string;
  source: {
    absPath?: string;
    relPath: string;
    mime: string;
    ext: string;
    modifiedAt?: string;
    sizeBytes?: number;
    sourceHash?: string;
  };
  conversion?: {
    converterId?: string;
    converterVersion?: string;
    mirrorHash?: string;
  };
};

export async function get(
  ref: string,
  options: GetCommandOptions
): Promise<GetResult> {
  // 1. Parse ref
  const parsed = parseRef(ref);
  if ("error" in parsed) {
    return { success: false, error: parsed.error, isValidation: true };
  }

  // 2. Init store
  const initResult = await initStore({ configPath: options.configPath });
  if (!initResult.ok) {
    return { success: false, error: initResult.error };
  }
  const { store } = initResult;

  try {
    // 3. Lookup document by type
    let docResult;
    switch (parsed.type) {
      case "docid":
        docResult = await store.getDocumentByDocid(parsed.value);
        break;
      case "uri":
        docResult = await store.getDocumentByUri(parsed.value);
        break;
      case "collPath":
        docResult = await store.getDocument(
          parsed.collection!,
          parsed.relPath!
        );
        break;
    }

    if (!docResult.ok) {
      return { success: false, error: docResult.error.message };
    }
    const doc = docResult.value;

    // 4. Check doc exists and is active
    if (!doc || !doc.active) {
      return { success: false, error: "Document not found" };
    }

    // 5. Check mirror content exists
    if (!doc.mirrorHash) {
      return {
        success: false,
        error: "Mirror content unavailable (conversion error)",
      };
    }

    const contentResult = await store.getContent(doc.mirrorHash);
    if (!contentResult.ok || contentResult.value === null) {
      return { success: false, error: "Mirror content unavailable" };
    }

    // 6. Apply line range
    const lines = contentResult.value.split("\n");
    const totalLines = lines.length;

    // --from overrides :line suffix
    const startLine = options.from ?? parsed.line ?? 1;
    const limit = options.limit ?? totalLines;

    // Clamp to valid range (1-indexed)
    const clampedStart = Math.max(1, Math.min(startLine, totalLines));
    const clampedEnd = Math.min(clampedStart + limit - 1, totalLines);

    const selectedLines = lines.slice(clampedStart - 1, clampedEnd);
    let content = selectedLines.join("\n");

    // Determine if partial
    const isPartial = clampedStart > 1 || clampedEnd < totalLines;

    // 7. Build response
    return {
      success: true,
      data: {
        docid: doc.docid,
        uri: doc.uri,
        title: doc.title ?? undefined,
        content,
        totalLines,
        returnedLines: isPartial
          ? { start: clampedStart, end: clampedEnd }
          : undefined,
        language: doc.languageHint ?? undefined,
        source: {
          relPath: doc.relPath,
          mime: doc.sourceMime,
          ext: doc.sourceExt,
          sizeBytes: doc.sourceSize,
          sourceHash: doc.sourceHash,
        },
        conversion: doc.converterId
          ? {
              converterId: doc.converterId,
              converterVersion: doc.converterVersion ?? undefined,
              mirrorHash: doc.mirrorHash,
            }
          : undefined,
      },
    };
  } finally {
    await store.close();
  }
}

/**
 * Format get result for output.
 */
export function formatGet(
  result: GetResult,
  options: GetCommandOptions
): string {
  if (!result.success) {
    if (options.json) {
      return JSON.stringify({
        error: { code: "GET_FAILED", message: result.error },
      });
    }
    return `Error: ${result.error}`;
  }

  const { data } = result;

  if (options.json) {
    return JSON.stringify(data, null, 2);
  }

  if (options.md) {
    const lines: string[] = [];
    lines.push(`# ${data.title || data.source.relPath}`);
    lines.push("");
    lines.push(`- **URI**: \`${data.uri}\``);
    lines.push(`- **DocID**: \`${data.docid}\``);
    if (data.returnedLines) {
      lines.push(
        `- **Lines**: ${data.returnedLines.start}-${data.returnedLines.end} of ${data.totalLines}`
      );
    }
    lines.push("");
    lines.push("```");
    lines.push(
      options.lineNumbers && data.returnedLines
        ? addLineNumbers(data.content, data.returnedLines.start)
        : data.content
    );
    lines.push("```");
    return lines.join("\n");
  }

  // Terminal format
  let content = data.content;
  if (options.lineNumbers) {
    const startLine = data.returnedLines?.start ?? 1;
    content = addLineNumbers(content, startLine);
  }
  return content;
}

function addLineNumbers(text: string, startLine: number): string {
  return text
    .split("\n")
    .map((line, i) => `${startLine + i}: ${line}`)
    .join("\n");
}
````

### Phase 3: gno multi-get Command

**File:** `src/cli/commands/multi-get.ts` (new)

````ts
// multi-get.ts

import { minimatch } from "minimatch";
import {
  parseRef,
  splitRefs,
  isGlobPattern,
  type ParsedRef,
} from "./ref-parser";
import { initStore } from "./shared";

export type MultiGetCommandOptions = {
  configPath?: string;
  maxBytes?: number; // default 10240
  lineNumbers?: boolean;
  json?: boolean;
  files?: boolean;
  md?: boolean;
};

export type MultiGetResult =
  | { success: true; data: MultiGetResponse }
  | { success: false; error: string; isValidation?: boolean };

export type MultiGetDocument = {
  docid: string;
  uri: string;
  title?: string;
  content: string;
  truncated?: boolean;
  totalLines?: number;
  source: { absPath?: string; relPath: string; mime: string; ext: string };
};

export type SkippedDoc = {
  ref: string;
  reason: "not_found" | "conversion_error";
};

export type MultiGetResponse = {
  documents: MultiGetDocument[];
  skipped: SkippedDoc[];
  meta: {
    requested: number;
    returned: number;
    skipped: number;
    maxBytes?: number;
  };
};

export async function multiGet(
  refs: string[],
  options: MultiGetCommandOptions
): Promise<MultiGetResult> {
  const maxBytes = options.maxBytes ?? 10240;

  // 1. Split comma-separated refs
  const allRefs = splitRefs(refs);

  // 2. Init store
  const initResult = await initStore({ configPath: options.configPath });
  if (!initResult.ok) {
    return { success: false, error: initResult.error };
  }
  const { store } = initResult;

  try {
    // 3. Expand globs and resolve refs
    const expandedRefs: string[] = [];

    for (const ref of allRefs) {
      if (isGlobPattern(ref)) {
        // Glob must be in collection/pattern format
        const slashIdx = ref.indexOf("/");
        if (slashIdx === -1) {
          // Invalid glob format - skip
          continue;
        }
        const collection = ref.slice(0, slashIdx);
        const pattern = ref.slice(slashIdx + 1);

        // List docs in collection and match
        const listResult = await store.listDocuments(collection);
        if (listResult.ok) {
          for (const doc of listResult.value) {
            if (doc.active && minimatch(doc.relPath, pattern)) {
              expandedRefs.push(`${collection}/${doc.relPath}`);
            }
          }
        }
      } else {
        expandedRefs.push(ref);
      }
    }

    // 4. Fetch each document
    const documents: MultiGetDocument[] = [];
    const skipped: SkippedDoc[] = [];
    const seen = new Set<string>();

    for (const ref of expandedRefs) {
      // Dedupe by ref
      if (seen.has(ref)) continue;
      seen.add(ref);

      const parsed = parseRef(ref);
      if ("error" in parsed) {
        skipped.push({ ref, reason: "not_found" });
        continue;
      }

      // Fetch doc
      let docResult;
      switch (parsed.type) {
        case "docid":
          docResult = await store.getDocumentByDocid(parsed.value);
          break;
        case "uri":
          docResult = await store.getDocumentByUri(parsed.value);
          break;
        case "collPath":
          docResult = await store.getDocument(
            parsed.collection!,
            parsed.relPath!
          );
          break;
      }

      if (!docResult.ok) {
        skipped.push({ ref, reason: "not_found" });
        continue;
      }

      const doc = docResult.value;
      if (!doc || !doc.active) {
        skipped.push({ ref, reason: "not_found" });
        continue;
      }

      if (!doc.mirrorHash) {
        skipped.push({ ref, reason: "conversion_error" });
        continue;
      }

      const contentResult = await store.getContent(doc.mirrorHash);
      if (!contentResult.ok || contentResult.value === null) {
        skipped.push({ ref, reason: "conversion_error" });
        continue;
      }

      // 5. Truncate if needed (line boundary, UTF-8 safe)
      let content = contentResult.value;
      let truncated = false;
      const encoder = new TextEncoder();

      if (encoder.encode(content).length > maxBytes) {
        const lines = content.split("\n");
        let accumulated = "";
        let byteLen = 0;

        for (const line of lines) {
          const lineBytes = encoder.encode(line + "\n").length;
          if (byteLen + lineBytes > maxBytes) {
            truncated = true;
            break;
          }
          accumulated += line + "\n";
          byteLen += lineBytes;
        }
        content = accumulated.trimEnd();
      }

      documents.push({
        docid: doc.docid,
        uri: doc.uri,
        title: doc.title ?? undefined,
        content,
        truncated: truncated || undefined,
        totalLines: content.split("\n").length,
        source: {
          relPath: doc.relPath,
          mime: doc.sourceMime,
          ext: doc.sourceExt,
        },
      });
    }

    return {
      success: true,
      data: {
        documents,
        skipped,
        meta: {
          requested: expandedRefs.length,
          returned: documents.length,
          skipped: skipped.length,
          maxBytes,
        },
      },
    };
  } finally {
    await store.close();
  }
}

export function formatMultiGet(
  result: MultiGetResult,
  options: MultiGetCommandOptions
): string {
  if (!result.success) {
    if (options.json) {
      return JSON.stringify({
        error: { code: "MULTI_GET_FAILED", message: result.error },
      });
    }
    return `Error: ${result.error}`;
  }

  const { data } = result;

  if (options.json) {
    return JSON.stringify(data, null, 2);
  }

  if (options.files) {
    return data.documents.map((d) => `${d.docid},${d.uri}`).join("\n");
  }

  if (options.md) {
    const lines: string[] = [];
    lines.push(`# Multi-Get Results`);
    lines.push("");
    lines.push(`*${data.meta.returned} of ${data.meta.requested} documents*`);
    lines.push("");

    for (const doc of data.documents) {
      lines.push(`## ${doc.title || doc.source.relPath}`);
      lines.push(`- **URI**: \`${doc.uri}\``);
      if (doc.truncated) {
        lines.push(`- **Truncated**: yes (max ${data.meta.maxBytes} bytes)`);
      }
      lines.push("");
      lines.push("```");
      lines.push(doc.content);
      lines.push("```");
      lines.push("");
    }

    if (data.skipped.length > 0) {
      lines.push("## Skipped");
      for (const s of data.skipped) {
        lines.push(`- ${s.ref}: ${s.reason}`);
      }
    }

    return lines.join("\n");
  }

  // Terminal format
  const lines: string[] = [];
  for (const doc of data.documents) {
    lines.push(`=== ${doc.uri} ===`);
    lines.push(doc.content);
    lines.push("");
  }
  if (data.skipped.length > 0) {
    lines.push(`Skipped: ${data.skipped.map((s) => s.ref).join(", ")}`);
  }
  lines.push(
    `${data.meta.returned}/${data.meta.requested} documents retrieved`
  );
  return lines.join("\n");
}
````

### Phase 4: gno ls Command

**File:** `src/cli/commands/ls.ts` (new)

```ts
// ls.ts

import { initStore } from "./shared";

export type LsCommandOptions = {
  configPath?: string;
  json?: boolean;
  files?: boolean;
  md?: boolean;
};

export type LsResult =
  | { success: true; data: LsDocument[] }
  | { success: false; error: string; isValidation?: boolean };

export type LsDocument = {
  docid: string;
  uri: string;
  title?: string;
  source: { relPath: string; mime: string; ext: string };
};

export async function ls(
  scope: string | undefined,
  options: LsCommandOptions
): Promise<LsResult> {
  const initResult = await initStore({ configPath: options.configPath });
  if (!initResult.ok) {
    return { success: false, error: initResult.error };
  }
  const { store } = initResult;

  try {
    // Determine scope type
    let docs;

    if (!scope) {
      // List all
      docs = await store.listDocuments();
    } else if (scope.startsWith("gno://")) {
      // URI prefix filter
      const allDocs = await store.listDocuments();
      if (!allDocs.ok) {
        return { success: false, error: allDocs.error.message };
      }
      docs = {
        ok: true as const,
        value: allDocs.value.filter((d) => d.uri.startsWith(scope)),
      };
    } else {
      // Collection name
      docs = await store.listDocuments(scope);
    }

    if (!docs.ok) {
      return { success: false, error: docs.error.message };
    }

    // Filter active only, sort by URI
    const result: LsDocument[] = docs.value
      .filter((d) => d.active)
      .map((d) => ({
        docid: d.docid,
        uri: d.uri,
        title: d.title ?? undefined,
        source: {
          relPath: d.relPath,
          mime: d.sourceMime,
          ext: d.sourceExt,
        },
      }))
      .sort((a, b) => a.uri.localeCompare(b.uri));

    return { success: true, data: result };
  } finally {
    await store.close();
  }
}

export function formatLs(result: LsResult, options: LsCommandOptions): string {
  if (!result.success) {
    if (options.json) {
      return JSON.stringify({
        error: { code: "LS_FAILED", message: result.error },
      });
    }
    return `Error: ${result.error}`;
  }

  const docs = result.data;

  if (options.json) {
    return JSON.stringify(docs, null, 2);
  }

  if (options.files) {
    return docs.map((d) => `${d.docid},${d.uri}`).join("\n");
  }

  if (options.md) {
    if (docs.length === 0) {
      return "# Documents\n\nNo documents found.";
    }
    const lines: string[] = [];
    lines.push("# Documents");
    lines.push("");
    lines.push("| DocID | URI | Title |");
    lines.push("|-------|-----|-------|");
    for (const d of docs) {
      lines.push(`| \`${d.docid}\` | \`${d.uri}\` | ${d.title || "-"} |`);
    }
    return lines.join("\n");
  }

  // Terminal format
  if (docs.length === 0) {
    return "No documents found.";
  }
  return docs.map((d) => `${d.docid}\t${d.uri}`).join("\n");
}
```

### Phase 5: CLI Wiring (Using CliError Pattern)

**Update:** `src/cli/program.ts:558-600`

Replace stubs in `wireRetrievalCommands()` using the established CliError pattern:

```ts
import { CliError } from "./errors";

// get
program
  .command("get <ref>")
  .description("Get document by URI or docid")
  .option("--from <line>", "Start at line number", parseInt)
  .option("-l, --limit <lines>", "Limit to N lines", parseInt)
  .option("--line-numbers", "Prefix lines with numbers")
  .option("--source", "Include source metadata")
  .option("--json", "JSON output")
  .option("--md", "Markdown output")
  .action(async (ref: string, cmdOpts: Record<string, unknown>) => {
    const format = getFormat(cmdOpts);
    assertFormatSupported(CMD.get, format);

    const { get, formatGet } = await import("./commands/get");
    const result = await get(ref, cmdOpts);

    if (!result.success) {
      throw new CliError(
        result.isValidation ? "VALIDATION" : "RUNTIME",
        result.error
      );
    }

    process.stdout.write(formatGet(result, cmdOpts) + "\n");
  });

// multi-get
program
  .command("multi-get <refs...>")
  .description("Get multiple documents")
  .option("--max-bytes <n>", "Max bytes per document", parseInt, 10240)
  .option("--line-numbers", "Include line numbers")
  .option("--json", "JSON output")
  .option("--files", "File protocol output")
  .option("--md", "Markdown output")
  .action(async (refs: string[], cmdOpts: Record<string, unknown>) => {
    const format = getFormat(cmdOpts);
    assertFormatSupported(CMD.multiGet, format);

    const { multiGet, formatMultiGet } = await import("./commands/multi-get");
    const result = await multiGet(refs, cmdOpts);

    if (!result.success) {
      throw new CliError(
        result.isValidation ? "VALIDATION" : "RUNTIME",
        result.error
      );
    }

    process.stdout.write(formatMultiGet(result, cmdOpts) + "\n");
  });

// ls
program
  .command("ls [scope]")
  .description("List indexed documents")
  .option("--json", "JSON output")
  .option("--files", "File protocol output")
  .option("--md", "Markdown output")
  .action(
    async (scope: string | undefined, cmdOpts: Record<string, unknown>) => {
      const format = getFormat(cmdOpts);
      assertFormatSupported(CMD.ls, format);

      const { ls, formatLs } = await import("./commands/ls");
      const result = await ls(scope, cmdOpts);

      if (!result.success) {
        throw new CliError(
          result.isValidation ? "VALIDATION" : "RUNTIME",
          result.error
        );
      }

      process.stdout.write(formatLs(result, cmdOpts) + "\n");
    }
  );
```

### Phase 6: Export & Index

**Update:** `src/cli/commands/index.ts`

```ts
export { get, formatGet } from "./get";
export { multiGet, formatMultiGet } from "./multi-get";
export { ls, formatLs } from "./ls";
```

### Phase 7: Tests

**Update existing schema tests** instead of creating duplicates:

- `test/spec/schemas/get.test.ts` - extend with more cases
- `test/spec/schemas/multi-get.test.ts` - extend with more cases

**Update stub tests:**

- Remove "not yet implemented" assertions from `test/cli/smoke.test.ts`

**Add CLI smoke tests:**

- `test/cli/get.test.ts` (new)
- `test/cli/multi-get.test.ts` (new)
- `test/cli/ls.test.ts` (new)

**Test Cases (following search-smoke.test.ts pattern):**

```ts
// test/cli/get.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runCli, setupTestEnv, teardownTestEnv, type TestEnv } from "./helpers";

describe("gno get", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await setupTestEnv();
    // Add test document
  });

  afterEach(async () => {
    await teardownTestEnv(env);
  });

  test("retrieves by docid", async () => {
    const { code, stdout } = await runCli(["get", "#testdoc"], env);
    expect(code).toBe(0);
    expect(stdout).toContain("test content");
  });

  test("retrieves by URI", async () => {
    const { code, stdout } = await runCli(["get", "gno://test/doc.md"], env);
    expect(code).toBe(0);
  });

  test("retrieves by collection/path", async () => {
    const { code } = await runCli(["get", "test/doc.md"], env);
    expect(code).toBe(0);
  });

  test("parses :line suffix", async () => {
    const { code, stdout } = await runCli(["get", "gno://test/doc.md:5"], env);
    expect(code).toBe(0);
  });

  test("applies --from and -l range", async () => {
    const { code, stdout } = await runCli(
      ["get", "test/doc.md", "--from", "2", "-l", "3"],
      env
    );
    expect(code).toBe(0);
  });

  test("outputs JSON matching schema", async () => {
    const { code, stdout } = await runCli(
      ["get", "test/doc.md", "--json"],
      env
    );
    expect(code).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.docid).toMatch(/^#[a-f0-9]{6,8}$/);
    expect(data.uri).toMatch(/^gno:\/\//);
  });

  test("exits 1 for invalid ref format", async () => {
    const { code, stderr } = await runCli(["get", "invalid"], env);
    expect(code).toBe(1);
  });

  test("exits 2 for not found", async () => {
    const { code } = await runCli(["get", "#notfound"], env);
    expect(code).toBe(2);
  });
});

// Similar patterns for multi-get.test.ts and ls.test.ts
```

---

## File Summary

| File                                  | Action | Purpose                                        |
| ------------------------------------- | ------ | ---------------------------------------------- |
| `src/cli/commands/ref-parser.ts`      | create | Pure ref parsing (no store access)             |
| `src/cli/commands/get.ts`             | create | get command + formatter                        |
| `src/cli/commands/multi-get.ts`       | create | multi-get command + formatter + glob expansion |
| `src/cli/commands/ls.ts`              | create | ls command + formatter                         |
| `src/cli/commands/index.ts`           | update | Export new commands                            |
| `src/cli/program.ts`                  | update | Wire commands using CliError pattern           |
| `test/cli/get.test.ts`                | create | get CLI smoke tests                            |
| `test/cli/multi-get.test.ts`          | create | multi-get CLI smoke tests                      |
| `test/cli/ls.test.ts`                 | create | ls CLI smoke tests                             |
| `test/spec/schemas/get.test.ts`       | update | Extend schema validation                       |
| `test/spec/schemas/multi-get.test.ts` | update | Extend schema validation                       |
| `test/cli/smoke.test.ts`              | update | Remove stub assertions                         |

**Removed from plan (YAGNI):**

- ~~`src/cli/format/get-result.ts`~~ (inline in command)
- ~~`src/cli/format/multi-get-result.ts`~~ (inline in command)
- ~~`src/cli/format/ls-result.ts`~~ (inline in command)
- ~~`test/spec/schemas/get-schema.test.ts`~~ (extend existing)
- ~~`test/spec/schemas/multi-get-schema.test.ts`~~ (extend existing)

---

## Edge Cases & Error Handling

### Ref Parsing

| Input                   | Type          | Resolution                              |
| ----------------------- | ------------- | --------------------------------------- |
| `#a1b2c3d4`             | docid         | `getDocumentByDocid('#a1b2c3d4')`       |
| `#a1b2c3:50`            | error         | Docid refs cannot have :line suffix     |
| `gno://work/doc.md`     | uri           | `getDocumentByUri('gno://work/doc.md')` |
| `gno://work/doc.md:120` | uri+line      | Parse line=120, strip suffix            |
| `work/doc.md`           | collPath      | `getDocument('work', 'doc.md')`         |
| `work/doc.md:50`        | collPath+line | Parse line=50                           |
| `invalid`               | error         | Invalid ref format (missing /)          |

### ls Scope Validation

**Valid Scopes:**
| Scope | Interpretation |
|-------|----------------|
| (none) | List all active documents |
| `work` | Collection name filter |
| `gno://work/` | URI prefix filter (must match `^gno://[^/]+/`) |
| `gno://work/contracts` | URI prefix filter |

**Invalid Scopes (Exit 1):**
| Scope | Error |
|-------|-------|
| `gno://` | Invalid scope: missing collection |
| `gno://work` | Invalid scope: missing trailing path (use `gno://work/`) |

### Document States

| State           | Behavior                                               |
| --------------- | ------------------------------------------------------ |
| doc not found   | Exit 2 "Document not found"                            |
| doc inactive    | Exit 2 "Document not found"                            |
| mirrorHash null | Exit 2 "Mirror content unavailable (conversion error)" |
| content missing | Exit 2 "Mirror content unavailable"                    |

### Line Range Validation & Edge Cases

**Validation (Exit 1):**
| Input | Behavior |
|-------|----------|
| `--from <= 0` | Exit 1 validation error |
| `-l < 0` | Exit 1 validation error |

**Clamping/Edge Cases (Exit 0):**
| Scenario | Behavior |
|----------|----------|
| `--from > totalLines` | Clamp to last line, return empty content, `returnedLines: { start: totalLines, end: totalLines }` |
| `--from 50 -l 1000` goes past end | Return lines 50 to end |
| `-l 0` | Return empty content, omit `returnedLines` |
| Both `:line` and `--from` | `--from` takes precedence |
| `-l` not specified | Return all remaining lines from start |

### Truncation Algorithm

```ts
// UTF-8 safe line-boundary truncation
const encoder = new TextEncoder();
const lines = content.split("\n");
let accumulated = "";
let byteLen = 0;

for (const line of lines) {
  const lineBytes = encoder.encode(line + "\n").length;
  if (byteLen + lineBytes > maxBytes) {
    truncated = true;
    break;
  }
  accumulated += line + "\n";
  byteLen += lineBytes;
}
content = accumulated.trimEnd();
```

### Multi-get Skipped Reasons

| Reason             | When                                                |
| ------------------ | --------------------------------------------------- |
| `not_found`        | Doc doesn't exist, is inactive, or ref parse failed |
| `conversion_error` | mirrorHash null or content missing                  |

**Note:** `exceeds_maxBytes` is reserved in the schema but never emitted by CLI - we always truncate and include. Future consumers (MCP tools) may use it for different semantics.

### Performance Considerations

Multi-get performs O(n) store calls over resolved refs (one `getDocument*` + `getContent` per ref). This is acceptable for typical ref list sizes (< 100). Batch query optimization can be added later if needed for MCP bulk retrieval use cases.

---

## Success Metrics

- [ ] All commands pass `bun test`
- [ ] JSON outputs validate against schemas
- [ ] `bun run lint` passes
- [ ] `bun run typecheck` passes
- [ ] Manual smoke test: get, multi-get, ls work with real index
- [ ] No `process.exit()` in command handlers
- [ ] Tests use runCli harness, not direct function calls

---

## References

- CLI Spec: `spec/cli.md:531-636`
- get Schema: `spec/output-schemas/get.schema.json`
- multi-get Schema: `spec/output-schemas/multi-get.schema.json`
- Store methods: `src/store/sqlite/adapter.ts:337-425`
- Search pattern: `src/cli/commands/search.ts`
- Error handling: `src/cli/errors.ts`, `src/cli/run.ts`
- Test harness: `test/cli/search-smoke.test.ts`
- PRD §13-14: retrieval command requirements
