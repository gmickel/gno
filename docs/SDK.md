---
title: SDK
description: Embed GNO directly in Bun or TypeScript apps with in-process search, retrieval, document access, and indexing.
keywords: gno sdk, local search sdk, retrieval sdk, bun sdk, typescript knowledge sdk
---

# SDK

Import GNO directly into another Bun or TypeScript app and reuse the same local search, retrieval, and indexing engine in-process.

No CLI subprocesses. No local server required.

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

const retrievalOnlyStructured = await client.ask(
  "term: web performance budgets\\nintent: latency and vitals",
  {
    noAnswer: true,
    noExpand: true,
    noRerank: true,
  }
);
```

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
The returned `GnoContextResult` includes exact evidence text and line ranges,
source/mirror/passage hashes, configured-context bindings, coverage gaps,
omission counts, capability fallbacks, and exact final payload accounting.
`depthPolicy: "fast"` avoids model loading. The normalized request persists
author, language, structured query modes, effective result/candidate limits,
and graph intent. Capability states distinguish `not_requested`,
`not_attempted`, `used`, and attempted `unavailable`; fallbacks describe only
actual unavailable attempts. Unknown collections throw `invalid_filter` before
retrieval or model setup.

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

Use `client.createNote()` for lower-level raw note creation without provenance
capture semantics.

### Status

```ts
const status = await client.status();
console.log(status.activeDocuments, status.embeddingBacklog);
```

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
