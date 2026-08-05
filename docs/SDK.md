---
title: SDK
description: Embed GNO directly in Bun or TypeScript apps with in-process search, retrieval, document access, and indexing.
keywords: gno sdk, local search sdk, retrieval sdk, bun sdk, typescript knowledge sdk
---

# SDK

Import GNO directly into another Bun or TypeScript app and reuse the same local search, retrieval, and indexing engine in-process.

No CLI subprocesses. No local server required.

## Project hints

`search`, `vsearch`, `query`, `ask`, and context compilation accept optional
`projectHints: string[]` (maximum 16). SDK hints are opaque and untrusted:
GNO normalizes them for bounded input handling but deliberately performs no
filesystem probing and applies no project-affinity boost. Omitted hints preserve
existing output bytes. Only trusted local CLI cwd/`--project-root` inputs can
produce the soft `+0.03` contribution.

---

## Install

```bash
bun add @gmickel/gno
```

---

## Quick Start

```ts
import { createDefaultConfig, createGnoClient } from "@gmickel/gno";

const config = createDefaultConfig();
config.collections = [
  {
    name: "notes",
    path: "/Users/me/notes",
    pattern: "**/*",
    include: [],
    exclude: [],
  },
];

const client = await createGnoClient({
  config,
  dbPath: "/tmp/gno-sdk.sqlite",
});

await client.index({ noEmbed: true });

const results = await client.search("JWT token");
console.log(results.results.map((r) => r.uri));

await client.close();
```

For logical records indexed from portable exports, search and document methods
return optional `record` provenance (locator, anchors, people/dates, and
thread/event/session metadata) plus exact adapter ID, version, and configuration
fingerprint. `source.relPath` is the real export container; use the unique
result `uri` or `docid` to retrieve the logical record.

---

## Open A Client

### Inline Config

Use this when another app owns the config and DB path.

```ts
import { createDefaultConfig, createGnoClient } from "@gmickel/gno";

const config = createDefaultConfig();
config.collections = [
  {
    name: "docs",
    path: "/Users/me/work/docs",
    pattern: "**/*",
    include: [],
    exclude: [],
  },
];

const client = await createGnoClient({
  config,
  dbPath: "/Users/me/.cache/my-app/gno.sqlite",
});
```

### Existing GNO Config

Use this when you want the SDK to reuse an existing `gno` installation.

```ts
import { createGnoClient } from "@gmickel/gno";

const client = await createGnoClient({
  configPath: "/Users/me/Library/Application Support/gno/config/index.yml",
});
```

If `dbPath` is omitted, GNO uses the normal per-index default location.

---

## Core Methods

### Search

BM25/document-level search.

```ts
const results = await client.search("JWT token", { limit: 5 });
```

`search`, `vsearch`, `query`, and `ask` preserve optional `context` on each
result. It contains matching user-configured guidance in deterministic
global-to-specific order while `uri` and `docid` retain the exact source
identity. No matching scope means the optional field is absent.

### Query

Hybrid retrieval. Same retrieval controls as the CLI/API.

```ts
const results = await client.query("performance", {
  intent: "web performance and latency",
  exclude: ["reviews"],
  noExpand: true,
  noRerank: true,
  explain: true,
});

const structured = await client.query(
  'auth flow\\nterm: "refresh token"\\nintent: token rotation',
  {
    noExpand: true,
    noRerank: true,
  }
);
```

### Ask

Retrieval-only or grounded answer generation.

```ts
const retrievalOnly = await client.ask("JWT token", {
  noAnswer: true,
  noExpand: true,
  noRerank: true,
});

const answered = await client.ask("What is our auth flow?", {
  answer: true,
});

const verified = await client.ask("Who owns the launch decision?", {
  verify: true,
  explain: true,
  contextBudgetTokens: 12_000,
  contextBudgetBytes: 48_000,
});
console.log(
  verified.verification?.claims.answerStatus,
  verified.verification?.claims.coverage
);

const retrievalOnlyStructured = await client.ask(
  "term: web performance budgets\\nintent: latency and vitals",
  {
    noAnswer: true,
    noExpand: true,
    noRerank: true,
  }
);
```

`verify: true` is explicit closed-evidence synthesis. The SDK builds one Context
Capsule, generates only from its retained sections, verifies source/mirror
freshness, and classifies each substantive claim as `supported`,
`contradicted`, `insufficient`, or `uncertain`. The draft is returned only at
100% substantive-claim support; otherwise `answer` is withheld and the result
records abstention. An unavailable, incapable, failed, or malformed semantic
verifier fails closed.

Verified Ask preserves the Capsule, exact evidence IDs/URIs/line spans,
freshness receipt, coverage, gaps, and semantic capability state under
`verification`. This is a support classification against the retained Capsule,
not a guarantee of corpus completeness or source truth. Existing retrieval-only
and `answer: true` calls remain compatible.

`explain: true` adds `meta.explain`. When a configured content type has a
non-neutral `searchBoost`, the result receipt includes raw/base score, factor,
bounded and combined contributions, final score, rule source, and the full
ranking-rules fingerprint. Verified Ask keeps this metadata outside the
canonical Capsule.

### Vector Search

Vector-only retrieval when embeddings and `sqlite-vec` are available.

```ts
const results = await client.vsearch("natural language auth flow", {
  limit: 5,
});
```

### Context Capsules

Compile exact evidence under one global budget, then verify it later without
silently rebuilding it:

```ts
const capsule = await client.context({
  goal: "compare the launch proposals",
  budgetTokens: 12_000,
  collections: ["work"],
  depthPolicy: "balanced",
});

const receipt = await client.verifyContext(capsule);
console.log(receipt.contentStatus, receipt.fingerprintStatus);
```

`client.context()` and the CLI share the same compiler and canonical projector.
`client.verifyContext()` requires the client's effective index to match the
Capsule scope. An omitted client `indexName` is canonical `default`; mismatches
return `invalid_filter` before verification reads the store.
The returned `GnoContextResult` includes exact evidence text and line ranges,
source/mirror/passage hashes, configured-context bindings, coverage gaps,
omission counts, capability fallbacks, and exact final payload accounting.
`depthPolicy: "fast"` avoids model loading. The normalized request persists
author, language, structured query modes, effective result/candidate limits,
and graph intent. Capability states distinguish `not_requested`,
`not_attempted`, `used`, and attempted `unavailable`; fallbacks describe only
actual unavailable attempts. Unknown collections throw `invalid_filter` before
retrieval or model setup. Tag filters are normalized, lowercased, deduplicated,
and validated. Result admission and rerank/graph candidate limits remain global
across multi-collection requests.
Balanced and thorough Context requests enable bounded graph expansion when
`graph` is omitted. Pass `graph: false`, or use `depthPolicy: "fast"`, for an
explicit opt-out.

`client.verifyContext()` validates canonical identity and metadata before store
access, preserves exact evidence bytes, and returns the same verification
receipt as the CLI. Ranking is `ranking_unavailable` when the current runtime
does not supply a rank resolver. Context methods throw exported typed errors
with `GnoContextErrorCode`; snapshot/load/provenance codes are identical across
SDK and CLI JSON error details.

For saved Capsules using `active_tokenizer`, verification requires the exact
tokenizer fingerprint and deterministic accounting callback before any store
I/O. The default SDK runtime does not invent one: it throws
`tokenizer_unavailable` rather than accepting unverified `usedTokens`.

### Private retrieval trace metadata

When local tracing is enabled, retrieval results carry a non-enumerable symbol
instead of changing their serialized contract:

```ts
import { getRetrievalTraceMetadata } from "@gmickel/gno";

const results = await client.query("deployment decision");
const traceId = getRetrievalTraceMetadata(results)?.traceId;
const document = await client.get("work/decisions/deploy.md", {
  from: 40,
  limit: 20,
  traceId,
});
```

The symbol is available on `search`, `vsearch`, `query`, `ask`, `get`, and
`context` results. `JSON.stringify()` ignores it. Passing `traceId` to `get`
continues the open query lifecycle and records the exact returned lines;
disabled tracing performs no trace or fingerprint work.

Existing receipts remain manageable even when new recording is disabled:

```ts
const history = await client.listRetrievalTraces({ limit: 50 });
const detail = await client.getRetrievalTrace(history.traces[0].traceId, {
  detailLimit: 500,
});

await client.labelRetrievalTrace({
  traceId: detail.trace.traceId,
  label: "relevant",
  targetRef: "gno://work/decisions/deploy.md",
});

const exported = await client.exportRetrievalTraces({
  traceIds: [detail.trace.traceId],
});
await Bun.write("retrieval-receipt.json", JSON.stringify(exported.artifact));

await client.deleteRetrievalTrace(detail.trace.traceId);
const purge = await client.purgeRetrievalTraces();
```

History summaries never expose raw replay queries. Detail reads are bounded and
include exact totals and per-section truncation flags. Export rejects open
traces, sorts and deduplicates membership, and preserves completed, partial,
failed, and cancelled outcomes without inferred relevance. `purge` reports the
truthful SQLite/WAL physical-cleanup state.

### Get / Multi-Get / List

```ts
const doc = await client.get("notes/README.md");
const many = await client.multiGet(["notes/README.md", "notes/api/auth.md"]);
const listed = await client.list({ limit: 20 });
```

`get()` returns source metadata plus capability metadata, so embedded apps can tell whether a document is editable in place or should be treated as read-only converted source material.

Clients opened with a non-default `indexName` decorate returned `gno://` URIs
with `?index=<name>` so search/list results can round-trip back to the same
index. `get()` and `multiGet()` open the named database carried by an indexed
URI, even when the client was created for another index. Missing indexes fail
without creating a database. Every `multiGet()` batch must resolve to one index;
split mixed-index batches before calling it.

`indexName` uses the same filesystem-safe contract as the CLI: 1–64 UTF-16 code
units drawn from Unicode letters, marks, numbers, internal ASCII spaces, `.`,
`_`, or `-`; it starts with a letter or number, cannot end with a space or `.`,
and cannot contain `..`. Absolute paths, path separators, controls, and
platform-invalid punctuation are rejected even when a custom `dbPath` is
supplied. Case and canonically equivalent Unicode spellings share one
NFC/case-folded identity. Its 242-byte UTF-8 budget keeps the complete
`index-<identity>.sqlite` filename within the portable 255-byte component limit.

### Sections / Section Targets

```ts
const sections = await client.getSections("notes/pilot.md");

const created = await client.createSectionTarget("notes/pilot.md", {
  anchor: "setup",
});
// or: { line: 3 } — exactly one selector

const resolved = await client.resolveSectionTarget(
  "notes/pilot.md",
  created.target
);
if (resolved.status === "exact" || resolved.status === "recovered") {
  console.log(resolved.citation?.anchor, resolved.citation?.lineStart);
} else {
  console.log(resolved.status, resolved.diagnostics.reason);
}
```

`getSections()` stays backward compatible. `createSectionTarget` /
`resolveSectionTarget` share the same projection as the REST endpoints
(`section-target-create-result` / `section-target-resolve-result` schemas):
canonical stored URI, conservative status, and citation only when navigable.
Ambiguous, stale, and missing results never include citation/navigation fields.
Oversized navigable citations fail closed to `stale` with
`citation_exceeds_transport_bounds`. If the stored canonical document URI exceeds
transport `uri` maxLength, create/resolve throw SDK `VALIDATION` before
projection (never truncating `target.document.uri`). Diagnostics candidates are
filtered/capped (32 max) with explicit `candidateCount` / `candidatesTruncated`.

Readable Web UI `#anchor` links stay compatible and are the human default.
Durable targets are for citation-safe create/resolve — not a replacement for
`getSections()` navigation.

### Reference-Safe Rename and Move

Preview first, show or inspect the complete impact plan, then pass its exact
version and digest into apply:

```ts
const renamePlan = await client.previewRenameNote({
  ref: "gno://notes/old-note.md",
  name: "new-note.md",
});

if (!renamePlan.canApply) {
  console.error(renamePlan.safety.blockingReasons);
} else {
  const result = await client.renameNote({
    ref: "gno://notes/old-note.md",
    name: "new-note.md",
    schemaVersion: renamePlan.schemaVersion,
    planDigest: renamePlan.planDigest,
    confirmation: "apply",
  });
  console.log(result.status, result.filesystem, result.indexConvergence);
}
```

Move uses the same protocol:

```ts
const movePlan = await client.previewMoveNote({
  ref: "gno://notes/new-note.md",
  folderPath: "archive",
});

if (movePlan.canApply) {
  const moved = await client.moveNote({
    ref: "gno://notes/new-note.md",
    folderPath: "archive",
    schemaVersion: movePlan.schemaVersion,
    planDigest: movePlan.planDigest,
    confirmation: "apply",
  });
  console.log(moved.status);
}
```

`previewRenameNote()` and `previewMoveNote()` return the canonical
`GnoFileRefactorPreviewPlan`; `renameNote()` and `moveNote()` return the
canonical `GnoFileRefactorApplyResult` directly. The client rebuilds the plan
at apply time, so stale source/reference/target state cannot be silently
accepted. Supported wiki and Markdown destinations are rewritten with the file
move in one all-or-rollback filesystem transaction. Post-commit sync is a
separate boundary: `applied_with_sync_pending` means the files committed and
the caller should run `client.update()` to converge the index; it is not a
failed or rolled-back refactor.

Only editable source documents and same-collection moves are supported.
Ambiguous, malformed, unsupported, read-only, occupied, or truncated plans fail
closed. `duplicateNote()` and `createFolder()` retain their existing behavior
and do not retarget inbound references.

### Capture

Capture a note with provenance and receive the shared capture receipt.

```ts
const receipt = await client.capture({
  collection: "notes",
  content: "thought to remember",
  presetId: "person",
  source: {
    kind: "web",
    url: "https://example.com",
  },
  tags: ["inbox", "research"],
});

console.log(receipt.uri, receipt.sync.status, receipt.embed.status);
```

`client.capture()` writes into an editable collection, syncs the created file
directly, and returns `sync.status: "completed"` when ingestion succeeds.
Embedding is separate; `embed.status` remains `not_requested` until you run
`client.embed()` or `client.index()` without `noEmbed`. Capture content must be
text, `presetId` accepts `blank`, `project-note`, `research-note`,
`decision-note`, `prompt-pattern`, `source-summary`, `idea-original`, `person`,
`company-project`, or `meeting`, `collisionPolicy` is validated at runtime, and
`client.capture()` does not accept legacy `overwrite`. Capture writes use
exclusive create semantics so a late-arriving file fails instead of being
replaced.

Browser-clip receipts use this same capture contract and may include normalized
source fields plus closed `source.browserClip` provenance: extraction mode,
exact selection when applicable, extraction/final hashes, deterministic
clip/preview digests, browser metadata, capture time, and bounded warnings.
Existing `client.capture()` inputs remain compatible. For a browser clip,
`open_existing` opens only a note with the same stored `clipIdentity`; missing
or different provenance is an explicit conflict. Use `create_with_suffix` to
create a distinct note.

Use `client.createNote()` for lower-level raw note creation without provenance
capture semantics.

`createNote()` returns a discriminated union, because not every written path is
a document. A configured record container (a `.jsonl` export, a `.vtt`
transcript) is imported as N logical records at virtual `.gno/records/...`
paths and has no document at the path that was written, so no fetchable URI
exists for it:

```ts
const created = await client.createNote({
  collection: "notes",
  relPath: "exports/session.jsonl",
  content: jsonlBody,
});

if (created.kind === "document") {
  const doc = await client.get(created.uri); // always resolves
} else {
  console.log(created.reason, created.relPath);
  const first = await client.get(created.recordUris[0]!); // records are fetchable
}
```

The written file is identified by `path`/`relPath` in both cases. The
`record-container` shape has no `uri` field at all, so `created.uri` does not
type-check until you narrow on `kind` - a URI that `client.get()` cannot
resolve is not something the API hands back.

`reason` also discloses a **partial import**: an adapter that accepts one
record and rejects another still yields a non-error write, so the container
sentence alone would read as clean. It states how many records were rejected -
and, because this result carries no sync result, it says the per-record
failures are not on the response and names where they are: re-run the
collection sync with `gno update --verbose`, which re-imports the container
(containers are never skipped as unchanged) and prints each rejected record's
code, source locator, and message. Only the REST job handle
(`result.written`, see [API.md](API.md)) rides inside a `SyncResult`, so only
it points at `collections[].files[].recordImport.failures` directly.

`recordUris` is a **bounded page**, not the container's contents: it lists at
most the first 1,000 of `recordCount` records, and `recordUrisTruncated` says
how many it omits. One valid export can hold six figures of records, so the
result object never grows with the container. `recordCount` is exact, so you
always know how many records there are.

The records past the page are **not listed by this result** - but they are not
unreachable. There is no _dedicated_ per-container enumeration call, so when the
page is truncated `reason` states the limit and names no continuation offset;
it names the mechanisms that do reach the whole container instead:

```ts
// Every record URI shares the container's virtual record directory, so any URI
// from the page yields the prefix that scopes a listing to this container.
const sample = created.recordUris[0]!;
const scope = sample.slice(0, sample.lastIndexOf("/") + 1);
const page = await client.list({ scope, limit: 100, offset: 0 });
```

Or page the collection normally (`client.list({ scope: "notes" })`, REST
`GET /api/docs`) - every logical record comes back with `source.relPath`
projected from its container's path, so a client can select this container's
records itself.

`duplicateNote()` keeps its single `uri` field, so when the copy's destination
is a container extension it reports the same fact through `warnings` instead -
the copy is indexed as N records, and `uri` resolves to no document. REST
`POST /api/docs/:id/duplicate` and MCP `gno_duplicate_note` use the same
wording on their own warning channels.

An `open_existing` capture answers "is this file indexed?" by effective source
path, so opening an existing container reports `sync.status: "completed"` with
a `sync.reason` naming the records, not `skipped`. As with a container capture,
the receipt carries no `docid`.

`sync.reason` also discloses a **partial record import**. An adapter that
accepts at least one record while rejecting others produces an ordinary
non-error file status, so `sync.status` stays `completed`; the rejected records

- and a partial snapshot, whose unseen records were preserved rather than
  refreshed - are stated in `sync.reason` alongside the container sentence. A
  fully successful import is unchanged: no partial wording is added. `capture()`
  (SDK), `gno capture` (CLI), `gno_capture` (MCP), and the REST capture/create
  jobs share this wording.

### Status

```ts
const status = await client.status();
console.log(
  status.activeDocuments,
  status.embeddingBacklog,
  status.contentTypeBoost.rules,
  status.contentTypeBoost.rulesFingerprint
);
```

Status exposes normalized rule IDs/factors, not configured path prefixes.

### Changes, Structural Diff, and Impact

```ts
const page = await client.changes({ since: lastCursor, limit: 100 });
const delta = await client.diff("gno://notes/plan.md", page.changes[0]?.id);
const impact = await client.impact("gno://notes/plan.md", {
  maxDepth: 3,
  maxNodes: 100,
  maxEdges: 250,
});
```

These are read-only views over the bounded metadata journal and relationship
projection. They return the same versioned structures as CLI JSON, REST, and
MCP. Old source bodies are never stored or reconstructed. Impact results expose
deterministic evidence paths and explicit truncation when any cap is reached.

### Update / Embed / Index

```ts
await client.update();
await client.embed();
await client.index();
```

`update()` syncs files into the index without embedding. `index()` runs sync plus embedding unless `noEmbed: true` is set.

---

## Lifecycle

Always close the client when done:

```ts
await client.close();
```

After `close()`, further calls throw `GnoSdkError`.

---

## Download Policy

By default, SDK model calls respect the same environment-based download policy as the CLI.

If you want a consumer app to avoid automatic downloads:

```ts
const client = await createGnoClient({
  config,
  downloadPolicy: { offline: false, allowDownload: false },
});
```

This is useful for tests, CI, or applications that want explicit model installation flows.

---

## Public Surface

Current stable root import surface:

- `createGnoClient`
- `createDefaultConfig`
- `ConfigSchema`
- SDK/client/result types
- Context Capsule result, verification, and error types

The package root is the SDK entrypoint. The CLI remains available through the `gno` binary.

---

## Notes

- `search` works without local models.
- `query` and `ask` degrade gracefully if vector/rerank/generation models are unavailable, except when answer generation is explicitly requested.
- `vsearch` requires embeddings plus vector search support.
- Inline config is supported; writing YAML is optional.
- `query` and `ask` accept multi-line structured query documents. See [Structured Query Syntax](./SYNTAX.md).

---

## Related Docs

- [CLI](./CLI.md)
- [REST API](./API.md)
- [Structured Query Syntax](./SYNTAX.md)
- [Architecture](./ARCHITECTURE.md)
- [Configuration](./CONFIGURATION.md)
