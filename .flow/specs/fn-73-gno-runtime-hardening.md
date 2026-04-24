# GNO Runtime Hardening Plan

Private implementation plan. This file lives under `newprds/`, which is
gitignored, so it can reference external inspiration directly.

## Context

We reviewed recent QMD hardening work in `/Users/gordon/repos/qmd` and selected
eight changes worth adapting to GNO. GNO already has stronger product surface
than QMD in several areas, so this plan scopes only defensive runtime,
integration, and docs work.

Implementation inspiration locations in QMD:

- `/Users/gordon/repos/qmd/src/llm.ts`
- `/Users/gordon/repos/qmd/src/store.ts`
- `/Users/gordon/repos/qmd/src/cli/qmd.ts`
- `/Users/gordon/repos/qmd/src/mcp/server.ts`
- `/Users/gordon/repos/qmd/test/llm.test.ts`
- `/Users/gordon/repos/qmd/test/store.test.ts`
- `/Users/gordon/repos/qmd/test/cli.test.ts`

GNO implementation target repo:

- `/Users/gordon/work/gno`

Hosted website/docs target repo:

- `/Users/gordon/work/gno.sh`

## Goals

- Reduce local model/download failure ambiguity.
- Make non-default index references portable.
- Improve machine-readable search result ergonomics.
- Prevent native model/runtime crashes from pathological input.
- Keep docs, schemas, skills, website, and public reference pages in sync.

## Non-Goals

- No new model preset.
- No default GPU behavior change.
- No ranking behavior change for normal inputs.
- No public mention of QMD inspiration.
- No broad refactor unless needed to thread index context safely.

## Delivery Strategy

Ship as separate small commits/tasks. Preferred order:

1. Status honors `--index`
2. Flat JSON `line` field
3. GGUF validation
4. Runtime vector guidance
5. Embedding input guardrail
6. Pathological chunk guard
7. Explicit GPU backend env
8. Custom index URI roundtrip

Reason: start with small CLI/schema fixes, then runtime hardening, then
cross-surface URI/index semantics.

## Shared Acceptance Criteria

Every item that changes user-visible behavior must update:

- `spec/cli.md`
- `spec/mcp.md` when MCP behavior changes
- `spec/output-schemas/*.json` when JSON output changes
- `docs/*.md`
- `skills/gno/*`
- `assets/skill/*`
- `README.md` when feature surface changes
- `CHANGELOG.md`
- `/Users/gordon/work/gno.sh` docs/product/reference pages when website-visible

Run gates as appropriate:

- `bun test`
- `bun run typecheck`
- `bun run lint:check`
- `bun run docs:verify`
- targeted CLI smoke tests
- targeted MCP tests when MCP touched
- website repo checks for changed website pages

Implementation invariants:

- Persisted document URIs stay canonical and index-free unless this plan
  explicitly says otherwise.
- New fields are additive unless explicitly called out as a breaking schema
  change.
- Existing default index behavior must remain compatible.
- Any hardening that deletes files may delete only GNO-owned cache files, never
  explicit user model paths.

## 1. GGUF Download Validation

### Problem

Model downloads can succeed at the transport layer but cache an HTML error page,
proxy response, captive portal page, or other non-GGUF file. That failure then
shows up later as a confusing model-load error.

### Desired Behavior

After resolving any local GGUF model path from cache or download:

- Check first 4 bytes for `GGUF`.
- If valid, continue.
- If invalid and content looks like HTML, delete cached file and return a clear
  error explaining likely proxy/firewall/captive portal interception.
- If invalid and not HTML, delete cached file and return a clear "not a GGUF"
  error with path and model URI.
- Do not apply GGUF validation to remote HTTP/OpenAI-compatible model backends.
- Apply to explicit pulls and auto-download.
- Apply to cached manifest hits before returning them from `resolve()`,
  `ensureModel()`, `isCached()`, and `models pull` skip logic.
- Explicit `file:`/absolute user paths are validated but never deleted.
- Invalid cached entries are removed from the manifest before returning.

### GNO Files

- `src/llm/cache.ts`
- `src/llm/errors.ts`
- `src/cli/commands/models/pull.ts`
- `src/serve/routes/api.ts` for `/api/models/pull` surfaced errors
- `test/llm/cache.test.ts`
- `test/cli/smoke.test.ts` or new model pull focused tests

### QMD Reference

- `src/llm.ts`: `validateGgufFile()`
- `test/llm.test.ts`: model validation style

### Design

Add helpers in `src/llm/cache.ts` or nearby:

```ts
const GGUF_MAGIC = new Uint8Array([0x47, 0x47, 0x55, 0x46]);

type ModelFileOwner = "cache" | "user";

async function validateGgufFile(
  path: string,
  uri: string,
  owner: ModelFileOwner
): Promise<LlmResult<void>>;
```

Use Bun-native file reads:

- `Bun.file(path).slice(0, 512).arrayBuffer()`
- `Bun.file(path).size` where needed
- `rm(path)` from `node:fs/promises` is acceptable for deletion

Return `LlmResult<string>` errors, not thrown strings.

Add structured errors in `src/llm/errors.ts`:

- `INVALID_MODEL_FILE`
- `MODEL_DOWNLOAD_INTERCEPTED`

Required cache behavior:

- `download()` validates `resolvedPath` before `addToManifest()`.
- Add an internal `getValidatedCachedPath(uri)` helper returning:

```ts
type ValidatedCachedPath =
  | { ok: true; path: string }
  | { ok: false; kind: "missing" }
  | { ok: false; kind: "invalid"; error: LlmError };
```

- `getValidatedCachedPath(uri)` validates HF manifest entries:
  - valid: return path
  - missing: remove manifest entry, return `missing`
  - invalid cache file: delete file, remove manifest entry, return `invalid`
- Public `getCachedPath()` can keep returning `string | null` for compatibility
  and should treat invalid as `null`.
- `resolve()` and `ensureModel()` should call the validated helper so they can
  return the structured invalid/intercepted error instead of a vague miss.
- `ensureModel()` double-check inside the download lock must also validate the
  path found by another process.
- `modelsPull()` must not skip a corrupt cached file. It should validate through
  `isCached()` or a stronger helper, then redownload if invalid.
- Keep manifest writes atomic under the existing manifest lock.

User path behavior:

- `file:` and absolute paths are checked for existence and GGUF magic.
- If invalid, return `INVALID_MODEL_FILE` with model URI and path.
- Do not delete or modify the user file.
- Do not add user paths to the cache manifest.

HTML sniff:

- Read the first 512 bytes.
- Treat as intercepted HTML if the sniffed lowercase text contains `<!doctype`,
  `<html`, `<head`, `<body`, or `huggingface` plus an HTML tag.
- Message should say the file was removed only for cache-owned files.

### Edge Cases

- Empty file: invalid, delete.
- Tiny file: invalid, delete.
- `file:` local path invalid: do not delete user file unless it is in GNO cache.
- Cache manifest says model exists but file invalid: delete file and update/remove
  manifest entry or force next ensure to redownload.
- Concurrent ensure: if process A deletes an invalid cached file while process B
  waits, process B redownloads cleanly after the lock.
- Manifest with corrupt path and `--offline`: return validation error, not
  "not cached", because the user has a concrete bad local cache to fix.

### Tests

- Valid fake file beginning with `GGUF` accepted.
- Cached HTML file rejected and deleted.
- Cached non-GGUF binary rejected and deleted.
- User-owned `file:` path invalid returns error but is not deleted.
- Auto-download path calls validation before manifest write.
- `models pull` does not skip cached HTML/non-GGUF files.
- `ensureModel()` validates already-cached manifest paths.
- Manifest entry removed after invalid cached file detection.

### Docs

Core repo:

- `docs/TROUBLESHOOTING.md`: add "Downloaded model is not GGUF" section.
- `docs/CLI.md`: `gno models pull` failure guidance.
- `docs/INSTALLATION.md`: mention proxy/firewall/captive portal case.
- `docs/WEB-UI.md`: model download recovery if UI surfaces error.

Website repo:

- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`: troubleshooting/install docs.
- `/Users/gordon/work/gno.sh/src/lib/product-pages.ts`: FAQ/model section if mirrored.
- `/Users/gordon/work/gno.sh/src/routes/install.tsx`: install/model pull guidance if present.

## 2. Explicit GPU Backend Env

### Problem

GNO currently lets `node-llama-cpp` choose the GPU backend automatically. Auto is
good by default, but explicit backend selection helps debug machines where a
driver exists but is broken, especially Vulkan/CUDA setups.

### Desired Behavior

Support explicit local backend env values while preserving current defaults.

Accepted values:

- unset/blank: `auto`
- `auto`: auto backend selection
- `metal`
- `vulkan`
- `cuda`
- `false`, `off`, `none`, `disable`, `disabled`, `0`: CPU only

Invalid values:

- warn once to stderr
- fall back to `auto`

### GNO Files

- `src/llm/nodeLlamaCpp/lifecycle.ts`
- `src/llm/nodeLlamaCpp/adapter.ts` if config threading needed
- `src/llm/types.ts` if new type exported
- `docs/CLI.md`
- `docs/TROUBLESHOOTING.md`
- `test/llm/lifecycle.test.ts`

### QMD Reference

- `src/llm.ts`: `resolveLlamaGpuMode()`, `ensureLlama()`
- `test/llm.test.ts`: `QMD_LLAMA_GPU resolution`

### Design

Add resolver:

```ts
type LlamaGpuMode = "auto" | "metal" | "vulkan" | "cuda" | false;
```

Env names:

- Add `GNO_LLAMA_GPU` as the product-owned env var.
- Keep `NODE_LLAMA_CPP_GPU` as compatibility alias.
- Precedence: `GNO_LLAMA_GPU` wins, then `NODE_LLAMA_CPP_GPU`, then `auto`.

Pass resolved mode into `getLlama({ gpu })`. Keep `build: "autoAttempt"`.

Current GNO dependency (`node-llama-cpp` 3.17.x) supports:

```ts
gpu?: "auto" | "metal" | "cuda" | "vulkan" | false
```

No default behavior change:

- unset env passes `gpu: "auto"` and keeps `build: "autoAttempt"`
- invalid env warns once and uses `auto`
- explicit CPU values pass `gpu: false`
- explicit backend init failure falls back to CPU with one warning; do not
  silently change GPU behavior after a model has already loaded

### Edge Cases

- Invalid value should not fail command startup.
- CPU-only mode should not try GPU.
- Explicit backend failure retries CPU exactly once and returns a clean load
  error if CPU init also fails.

### Tests

- Resolver table.
- Invalid value warning.
- `getLlama()` called with correct `gpu`.
- Default call remains equivalent to current behavior.

### Docs

Core repo:

- `docs/CLI.md`: env var table.
- `docs/TROUBLESHOOTING.md`: GPU backend troubleshooting.
- `docs/CONFIGURATION.md`: model/runtime env vars.

Website repo:

- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`: CLI/troubleshooting docs.
- `/Users/gordon/work/gno.sh/src/lib/product-pages.ts`: model FAQ if present.

## 3. Custom Index URI Roundtrip

### Problem

GNO supports named indexes via `--index`, but `gno://collection/path` does not
encode which index owns the reference. Search results from a non-default index
are not fully portable into later `get`/MCP/SDK calls.

### Desired Behavior

When a command runs against a non-default index, emitted document URIs carry the
index as output-only metadata:

```text
gno://notes/path/to/file.md?index=research
```

Consumers that receive this URI should open the referenced index automatically.

Persisted database document URIs remain canonical:

```text
gno://notes/path/to/file.md
```

The `?index=` query is added at API/CLI/MCP/SDK output boundaries and stripped
before same-store DB lookups. This avoids DB migrations and preserves existing
exact URI matches inside each index.

### GNO Files

- `src/app/constants.ts`: `buildUri`, `parseUri`
- `src/cli/commands/ref-parser.ts`
- `src/cli/commands/get.ts`
- `src/cli/commands/multi-get.ts`
- `src/cli/commands/links.ts`
- `src/cli/commands/search.ts`
- `src/cli/commands/vsearch.ts`
- `src/cli/commands/query.ts`
- `src/cli/commands/shared.ts`
- `src/mcp/resources/index.ts`
- `src/mcp/tools/get.ts`
- `src/mcp/tools/multi-get.ts`
- `src/mcp/tools/search.ts`
- `src/mcp/tools/query.ts`
- `src/sdk/documents.ts`
- `src/sdk/client.ts`
- `spec/output-schemas/search-result.schema.json`
- tests under `test/cli`, `test/mcp`, `test/sdk`, `test/spec`

### QMD Reference

- `src/store.ts`: `VirtualPath.indexName`, `parseVirtualPath()`,
  `buildVirtualPath()`
- `src/cli/qmd.ts`: current index state, search output links, `get` switching
  index from URI
- `test/cli.test.ts`: custom-index search links roundtrip test

### Design

Extend URI functions:

```ts
export interface ParsedGnoUri {
  collection: string;
  path: string;
  indexName?: string;
}

export interface BuildUriOptions {
  indexName?: string;
}
```

Rules:

- No `?index=` emitted for default index.
- Existing URI strings parse as before.
- `buildUri(collection, path)` remains valid and emits canonical URI.
- `buildUri(collection, path, { indexName })` appends `?index=...` only when
  `indexName` is non-default and non-blank.
- `parseUri()` strips query before path decode and returns `indexName`.
- `index` is URL-decoded via `URLSearchParams`.
- Empty/blank `index` ignored.
- `getDocumentByUri(uri)` may strip `?index=` for matching within the already
  open store, but it must not open another index.
- DB rows and ingestion continue storing canonical URI without query params.
- Search result schemas allow `?index=` in `uri`, but no existing required field
  changes.

Index context ownership:

- CLI context owns `globals.index`.
- MCP server context owns `options.indexName`.
- SDK client context owns `options.indexName`.
- Pipeline/store persisted rows do not own index identity.
- Add a small helper near URI utilities or CLI formatting:

```ts
export function decorateUriForIndex(uri: string, indexName?: string): string;
export function stripUriIndex(uri: string): string;
```

Command handling:

- Search/vsearch/query results are decorated after pipeline result assembly,
  using current context index. Do not mutate DB rows.
- `get`, `links`, `tags`, `publish export`, and other single-ref readers parse
  `indexName` from URI. If it differs from global `--index`, reopen/use a store
  for that indexed request before lookup.
- `multi-get` rejects mixed explicit indexes initially. Valid inputs:
  - all refs have no explicit index: use global index
  - all explicit indexed refs use same index: use that index
  - mixed explicit indexes: validation error with all indexes listed
  - explicit indexed refs plus unindexed refs: validation error unless global
    index equals the explicit index
- Line suffix parsing happens before URI parsing and must preserve query params:
  `gno://docs/a.md?index=alt:12` means URI index `alt`, line `12`.

MCP:

- Resource handler must parse `index`.
- Tool context currently opens one store. Add a scoped helper that can open a
  one-off `SqliteAdapter` for an indexed URI when it differs from server
  context, sync collections/contexts, run the lookup, then close it.
- Search/vsearch/query MCP outputs must decorate result URIs with the server
  index when non-default.
- MCP resources must accept indexed URIs by opening the requested index for
  that resource read. Resource list output must decorate URIs for the server
  index when non-default.

SDK:

- `GnoClient` stores its active `indexName`.
- SDK search/query/list outputs decorate URIs for that index.
- SDK `get`/`multiGet` parse indexed URIs and open a temporary store if the URI
  targets a different index than the client, then close it after the request.
  Do not silently read the wrong index.

### Edge Cases

- URI with `?index=foo:12` and line suffix parsing.
- Paths containing literal `?` encoded as `%3F`.
- Existing `gno://collection` no path behavior remains.
- Schema pattern must allow optional query string.
- Index names containing spaces or `/` are URL-encoded in URI query only. DB path
  normalization stays owned by existing index path logic.
- Indexed URI lookup against missing index returns clear "index not found or no
  document" error, not default-index fallback.
- Existing code that compares canonical DB `doc.uri` still works because stored
  URI remains query-free.

### Tests

- `buildUri(collection, path, { indexName })`
- `parseUri("gno://c/a.md?index=x")`
- Existing URI tests unchanged.
- CLI: `gno --index alt search --json` emits `?index=alt`.
- CLI: `gno get "gno://docs/a.md?index=alt"` reads alt index.
- CLI: mixed-index `multi-get` returns clear validation error.
- MCP: indexed URI behavior.
- SDK: indexed URI behavior.
- Store: `getDocumentByUri("gno://docs/a.md?index=alt")` strips query for the
  already-open store and finds canonical row.
- Ingestion: DB document `uri` remains canonical without query string.

### Docs

Core repo:

- `docs/CLI.md`: document indexed URI.
- `docs/MCP.md`: document indexed URI support/limits.
- `docs/SDK.md`: document indexed URI parsing.
- `docs/GLOSSARY.md`: update URI definition.
- `skills/gno/cli-reference.md`
- `skills/gno/mcp-reference.md`
- `assets/skill/*`

Website repo:

- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`: CLI/MCP/SDK docs.
- `/Users/gordon/work/gno.sh/src/lib/product-pages.ts`: developer/API pages if
  URI examples appear.

## 4. Flat JSON `line` Field

### Problem

GNO structured search results expose `snippetRange.startLine`, but many shell,
editor, and agent workflows want a simple top-level `line` value.

### Desired Behavior

Search result JSON includes:

```json
{
  "uri": "gno://docs/file.md",
  "line": 42,
  "snippetRange": { "startLine": 42, "endLine": 48 }
}
```

Include `line` when GNO knows the best matching/source chunk line. For normal
snippet results this is `snippetRange.startLine`. For `--full`, keep
`snippetRange` omitted but still include `line` from the chunk that selected the
document. This matches QMD's editor-anchor behavior while keeping the existing
meaning of `snippetRange` as "range of the returned snippet".

### GNO Files

- `src/pipeline/types.ts`
- `src/pipeline/search.ts`
- `src/pipeline/vsearch.ts`
- `src/pipeline/hybrid.ts`
- `spec/output-schemas/search-result.schema.json`
- `src/cli/format/search-results.ts` if JSON formatting uses pipeline output directly
- tests under `test/cli/search-*.test.ts`, `test/spec/schemas/search-result.test.ts`

### QMD Reference

- `src/cli/qmd.ts`: JSON output includes `line`
- `test/cli.test.ts`: line field test

### Design

Add optional `line?: number` to `SearchResult`.

Set it where the source chunk is known:

```ts
line: chunk?.startLine;
```

Rules:

- Normal snippet output: include `line` and `snippetRange`.
- `--line-numbers`: include `line` and `snippetRange`.
- `--full`: include `line`, omit `snippetRange` when snippet is full document.
- If no chunk exists, omit `line`.
- MCP/API/SDK search result types expose the same field.
- Existing consumers of `snippetRange` keep working; `line` is additive.

### Tests

- BM25 JSON includes `line`.
- Vector JSON includes `line`.
- Hybrid JSON includes `line`.
- Full output includes `line` from the best/source chunk while omitting
  `snippetRange` when returning full document content.
- Result with no chunk omits `line`.
- Schema accepts line.

### Docs

Core repo:

- `spec/output-schemas/search-result.schema.json`
- `docs/CLI.md`
- `docs/API.md` if API search exposes same schema.
- `docs/MCP.md` if MCP results include JSON content with line.
- `skills/gno/examples.md`: update jq/editor examples.
- `assets/skill/examples.md`

Website repo:

- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`: CLI/API reference.
- `/Users/gordon/work/gno.sh/src/lib/product-pages.ts`: developer/API docs if
  examples include search JSON.

## 5. Status Honors `--index`

### Problem

Several GNO commands use shared index initialization, but `gno status` currently
opens `getIndexDbPath()` without threading global `--index`. That makes
non-default index status inaccurate.

### Desired Behavior

`gno --index research status --json` opens `index-research.sqlite` and reports
that index.

### GNO Files

- `src/cli/program.ts`
- `src/cli/commands/status.ts`
- `src/cli/commands/shared.ts` if reuse is cleaner
- `test/cli/global-options.test.ts`
- `test/cli/smoke.test.ts`
- `test/spec/schemas/status.test.ts` if output shape affected

### QMD Reference

- `src/cli/qmd.ts`: `currentIndexName`, `setIndexName()`, status path handling

### Design

Add `indexName?: string` to `StatusOptions`.

In `status()`:

```ts
const dbPath = getIndexDbPath(options.indexName);
```

In CLI program action, pass global index into status command.

Ensure returned `IndexStatus.indexName` reflects actual index name. If store
derives index name internally only from defaults, thread it explicitly.

### Tests

- Create default and alt DBs with distinct counts.
- `gno status --json` returns default counts.
- `gno --index alt status --json` returns alt counts.
- Terminal output includes `Index: alt`.

### Docs

Core repo:

- `docs/CLI.md`: mention global `--index` applies to `status`.
- `docs/API.md`: no change expected unless status API docs mention global index.
- `skills/gno/cli-reference.md`
- `assets/skill/cli-reference.md`

Website repo:

- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`: CLI reference.

## 6. Runtime Vector Guidance

### Problem

`gno doctor` has sqlite-vec guidance, but runtime vector failures can still
surface as generic "vector search unavailable" messages without the original
extension load/probe reason.

### Desired Behavior

When sqlite-vec is unavailable:

- preserve load/probe reason in vector adapter
- make `vsearch` and hybrid failure/degradation messages actionable
- avoid repeated noisy warnings
- keep BM25 search working

### GNO Files

- `src/store/vector/sqlite-vec.ts`
- `src/store/vector/types.ts`
- `src/pipeline/vsearch.ts`
- `src/pipeline/hybrid.ts`
- `src/cli/commands/vsearch.ts`
- `src/cli/commands/query.ts`
- `src/serve/status.ts`
- `src/cli/commands/doctor.ts`
- tests under `test/store/vector`, `test/pipeline`, `test/cli`

### QMD Reference

- `src/store.ts`: `_sqliteVecUnavailableReason`,
  `createSqliteVecUnavailableError()`
- `test/store.test.ts`: actionable sqlite-vec guidance test

### Design

Current GNO already exposes `VectorIndexPort.loadError` and hybrid search
already degrades to `bm25_only` when `vectorIndex.searchAvailable` is false.
This task is a diagnostic enhancement, not a behavior rewrite.

Extend/standardize vector port result metadata:

```ts
searchAvailable: boolean;
loadError?: string;
guidance?: string;
```

When `searchNearest` is called unavailable, return error with:

- code: `VEC_SEARCH_UNAVAILABLE`
- message: includes original load/probe error if any
- suggestion: run `gno doctor`; on macOS mention Homebrew SQLite/sqlite-vec
  troubleshooting docs

Pipeline/CLI behavior:

- `vsearch` remains a hard failure when vectors are unavailable, but the error is
  actionable and includes `loadError`.
- `query`/hybrid keeps current BM25-only degradation:
  - `meta.mode` remains `bm25_only`
  - `meta.vectorsUsed` remains `false`
  - `meta.explain.lines` includes vector unavailable reason/guidance when
    `--explain` is enabled
  - no ranking change when vectors are available
- `search`/BM25 unaffected.
- MCP tools that create vector indexes should surface the same reason text in
  tool content and structured errors.
- Health Center / serve status should show `loadError` and guidance without
  repeating warnings on every poll.

Logging:

- Do not `console.warn` every request.
- It is acceptable to log one vector load/probe warning per process or per vector
  index creation.

### Tests

- Simulated sqlite-vec import failure preserves reason.
- `vsearch` returns actionable message.
- `search` still works with sqlite-vec unavailable.
- Hybrid behavior unchanged except `explain`/metadata diagnostics.
- `query --explain` includes vector unavailable reason.
- Repeated status/API calls do not spam stderr.

### Docs

Core repo:

- `docs/TROUBLESHOOTING.md`: runtime vector failure section.
- `docs/INSTALLATION.md`: macOS SQLite note.
- `docs/CLI.md`: `vsearch` failure guidance.
- `docs/WEB-UI.md`: Health Center/vector guidance if UI surface affected.

Website repo:

- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`: troubleshooting/install docs.
- `/Users/gordon/work/gno.sh/src/routes/install.tsx`: macOS SQLite install note if present.

## 7. Embedding Input Guardrail

### Problem

Oversized embedding inputs can exceed model context and cause native inference
failures. GNO chunking usually prevents this, but direct or pathological inputs
can still slip through.

### Desired Behavior

Before embedding:

- tokenize text when model/tokenizer available
- if token count exceeds active context limit, truncate to safe limit
- leave small margin for model overhead
- log/warn once per relevant call path
- batch embedding applies same guard per input
- normal in-limit inputs unchanged

### GNO Files

- `src/llm/nodeLlamaCpp/embedding.ts`
- `src/llm/nodeLlamaCpp/lifecycle.ts` if model metadata needed
- `src/embed/batch.ts`
- `test/llm/embedding.test.ts`
- `test/embed/batch.test.ts`

### QMD Reference

- `src/llm.ts`: `resolveEmbedTokenLimit()`, `truncateToContextSize()`
- `test/llm.test.ts`: embedding truncation test

### Design

Use node-llama-cpp APIs available through the loaded embedding model in
`NodeLlamaCppEmbedding.createContexts()`:

- `llamaModel.tokenize(text)`
- `llamaModel.detokenize(tokens)`
- `llamaModel.trainContextSize`
- existing embedding context creation options

Add helper in `NodeLlamaCppEmbedding`:

```ts
private async truncateForEmbedding(text: string): Promise<{
  text: string;
  truncated: boolean;
  tokenCount: number;
  limit: number;
}>
```

State required by helper:

- Store loaded `llamaModel` on the embedding port after successful
  `loadModel()` in `createContexts()`, or route helper through a method that has
  access to the loaded model.
- Resolve limit as:

```ts
const trained = llamaModel.trainContextSize;
const rawLimit =
  Number.isFinite(trained) && trained > 0 ? Math.floor(trained) : undefined;
if (rawLimit === undefined) {
  return { text, truncated: false, tokenCount: 0, limit: 0 };
}
const safeLimit = Math.max(1, rawLimit - 4);
```

- GNO does not currently pass `contextSize` to `createEmbeddingContext()`, and
  node-llama-cpp 3.17.x does not expose actual embedding context size on
  `LlamaEmbeddingContext`. Use `llamaModel.trainContextSize` when finite and
  positive; otherwise keep current behavior and do not truncate.
- Truncation must use tokenize/slice/detokenize, not string slicing.
- Warn once per `NodeLlamaCppEmbedding` instance for single `embed()` truncation
  and once for batch truncation. Include original token count and limit.
- Batch embedding truncates each input before scheduling work onto workers.
- Normal in-limit inputs are passed unchanged.
- If tokenizer/detokenizer throws, return an `INFERENCE_FAILED` result with
  cause and do not call native embedding on oversized unknown text.

### Edge Cases

- Unicode text truncation should detokenize, not substring, if possible.
- If model train context is huge but active embedding context is smaller, use
  active limit.
- If context limit unknown, keep current behavior.
- Empty text remains accepted as today.
- Multiple concurrent batch workers must not race warning state or mutate input
  order.
- Truncation should happen after document/query embedding formatting, because
  prefixes count against context.

### Tests

- Fake model with tokenizer truncates oversized text.
- In-limit text unchanged.
- Batch path truncates oversized item.
- Warning message includes original token count and token limit, emitted once.
- Embedding dimensions remain correct.
- Tokenizer unavailable/unknown limit path is no-op and does not regress normal
  embedding.

### Docs

Core repo:

- `docs/TROUBLESHOOTING.md`: "large document/native embedding failure" note.
- `docs/ARCHITECTURE.md`: mention embedding safety clamp if appropriate.

Website repo:

- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`: troubleshooting if mirrored.

## 8. Pathological Chunk Guard

### Problem

GNO's chunker already advances defensively, but giant single-line/no-breakpoint
inputs deserve explicit regression coverage so embedding guardrails are not the
first line of defense.

### Desired Behavior

Chunker invariants:

- always strictly advances
- never infinite loops
- emits multiple chunks for giant one-line content
- preserves line/pos metadata
- normal markdown/code chunking unchanged

### GNO Files

- `src/ingestion/chunker.ts`
- `test/ingestion/chunker.test.ts`
- `test/ingestion/sync-max-bytes.test.ts` if ingestion-level coverage useful

### QMD Reference

- `src/store.ts`: `chunkDocumentByTokens()` recursive shrink fallback
- `test/store.test.ts`: "Token chunking guardrails"

### Design

GNO chunker is character-based and already uses:

```ts
pos = Math.max(pos + 1, nextPos);
```

Need not port token-recursive algorithm directly. Add explicit tests first. If
test exposes oversize/poor behavior, add a bounded fallback:

- if `endPos <= pos`, force `endPos = Math.min(markdown.length, pos + maxChars)`
- if chunk text length exceeds expected hard cap for no-breakpoint input, force
  split at `maxChars`
- keep overlap bounded so `nextPos > pos` for every iteration

Do not change structural code chunking unless required.

### Tests

- `"x".repeat(120_000)` chunks without hang.
- Chunk positions strictly increase.
- Chunk text length <= `maxChars + smallAllowance`.
- Line number remains 1 for single-line input.
- Existing structural/code tests pass.
- Add a low `maxTokens` regression test so the guard executes on a small fixture
  quickly.

### Docs

Core repo:

- Usually no user-facing docs unless implementation changes visible behavior.
- If chunking behavior changes materially, update `docs/ARCHITECTURE.md` and
  `docs/HOW-SEARCH-WORKS.md`.

Website repo:

- Only update if docs changed in core: `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`
  and any feature pages that discuss chunking/retrieval.

## Cross-Cutting Docs Checklist

For each implemented item, decide whether website copy changes are needed.

Core repo docs likely affected:

- `README.md`
- `CHANGELOG.md`
- `docs/CLI.md`
- `docs/MCP.md`
- `docs/SDK.md`
- `docs/API.md`
- `docs/INSTALLATION.md`
- `docs/TROUBLESHOOTING.md`
- `docs/CONFIGURATION.md`
- `docs/HOW-SEARCH-WORKS.md`
- `docs/ARCHITECTURE.md`
- `docs/GLOSSARY.md`
- `skills/gno/SKILL.md`
- `skills/gno/cli-reference.md`
- `skills/gno/mcp-reference.md`
- `skills/gno/examples.md`
- `assets/skill/SKILL.md`
- `assets/skill/cli-reference.md`
- `assets/skill/mcp-reference.md`
- `assets/skill/examples.md`

Website repo likely affected:

- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`
- `/Users/gordon/work/gno.sh/src/lib/product-pages.ts`
- `/Users/gordon/work/gno.sh/src/lib/site-content.ts`
- `/Users/gordon/work/gno.sh/src/lib/gno-comparisons.tsx`
- `/Users/gordon/work/gno.sh/src/routes/install.tsx`
- `/Users/gordon/work/gno.sh/src/routes/faq.tsx`
- `/Users/gordon/work/gno.sh/src/routes/features.$featureSlug.tsx`
- `/Users/gordon/work/gno.sh/src/routes/docs.$slug.tsx`

Website update rules:

- If CLI syntax/output changes, update website docs/reference.
- If MCP behavior changes, update MCP docs pages.
- If model setup/failure behavior changes, update install/troubleshooting/FAQ.
- If feature positioning changes, update product pages and comparison pages.
- Do not mention QMD in public docs.

## Validation Plan

Minimum per-item:

- targeted unit tests
- targeted CLI test if CLI behavior changes
- schema tests if JSON shape changes
- docs update in same commit

Full gate before handoff:

```bash
bun test
bun run typecheck
bun run lint:check
bun run docs:verify
```

Website gate for `/Users/gordon/work/gno.sh` when changed:

```bash
bun run typecheck
bun run test
bun run build
bun x ultracite check
```

Adjust to repo reality if a command is unavailable or too slow; report any
blocked gate explicitly.

## Suggested Flow Breakdown

Create tasks under one Flow epic:

- `runtime-hardening-status-index`
- `runtime-hardening-json-line`
- `runtime-hardening-gguf-validation`
- `runtime-hardening-vector-guidance`
- `runtime-hardening-embedding-guard`
- `runtime-hardening-chunk-guard`
- `runtime-hardening-gpu-env`
- `runtime-hardening-indexed-uri`
- `runtime-hardening-docs-website`

Keep the docs/website task either:

- as a required checklist item per task, or
- as a final integration task that verifies every changed surface.

Preferred: docs with each feature, final docs audit at end.
