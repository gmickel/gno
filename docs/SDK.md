# SDK

Import GNO directly into another Bun or TypeScript app.

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

### Get / Multi-Get / List

```ts
const doc = await client.get("notes/README.md");
const many = await client.multiGet(["notes/README.md", "notes/api/auth.md"]);
const listed = await client.list({ limit: 20 });
```

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
