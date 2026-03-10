---
layout: feature
title: SDK
headline: Embed GNO Directly
description: Import GNO into another Bun or TypeScript app. Open a store with inline config, run retrieval directly, and trigger update/index flows without CLI subprocesses or a local server.
keywords: gno sdk, bun sdk, typescript sdk, local search sdk, retrieval sdk
icon: code
slug: sdk
permalink: /features/sdk/
benefits:
  - Package-root import surface
  - Inline config support
  - Direct search/query/ask/get APIs
  - Programmatic update/embed/index flows
  - Explicit lifecycle via close()
commands:
  - "bun add @gmickel/gno"
  - "import { createGnoClient } from '@gmickel/gno'"
---

## Why This Matters

Some integrations do not want a CLI subprocess or a localhost server at all. They want a typed client they can call directly inside the same process.

The GNO SDK provides that path.

## Quick Example

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
const results = await client.query("JWT token", {
  noExpand: true,
  noRerank: true,
});

console.log(results.results[0]?.uri);
await client.close();
```

## Core Surface

The current stable SDK surface includes:

- `createGnoClient`
- `search`, `vsearch`, `query`, `ask`
- `get`, `multiGet`, `list`, `status`
- `update`, `embed`, `index`
- `close`

## Inline Config Or Existing Config

You can either:

- pass an inline config object and your own DB path
- or point at an existing `gno` config file and reuse the normal install layout

That makes the SDK work for both embedded apps and existing-user automation.

## No Forced YAML

Inline config is first-class. You do not need to write config files just to use GNO as a library.

## Learn More

- [SDK docs](/docs/SDK/)
- [Architecture](/docs/ARCHITECTURE/)
- [REST API](/docs/API/)
