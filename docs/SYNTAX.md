---
title: Structured Query Syntax
description: Use GNO's structured query syntax with term, intent, and hyde controls for explicit retrieval behavior.
keywords: gno syntax, structured query syntax, hyde query, intent query, retrieval controls
---

# Structured Query Syntax

GNO supports a first-class multi-line query document syntax for `query` and `ask` flows.

Use existing GNO naming only:

```text
auth flow
term: "refresh token" -oauth1
intent: how token rotation works
hyde: Refresh tokens rotate on each use and previous tokens are invalidated.
```

## Rules

- Structured syntax is only activated for multi-line input.
- Blank lines are ignored.
- Recognized typed lines are:
  - `term:`
  - `intent:`
  - `hyde:`
- At most one `hyde:` line is allowed.
- Unknown typed prefixes like `vector:` are rejected.

## Base Query

The query document still needs a base search query.

GNO resolves it in this order:

1. plain untyped lines joined together
2. otherwise all `term:` lines joined together
3. otherwise all `intent:` lines joined together

`hyde:` is never searched directly.

That means these are both valid:

```text
auth flow
term: "refresh token"
intent: token rotation
```

```text
term: "refresh token"
intent: token rotation
```

This is invalid:

```text
hyde: hypothetical answer only
```

## Compatibility

Structured query documents are additive:

- existing plain single-line queries still work
- existing `--query-mode` CLI flags still work
- existing API/MCP `queryModes` arrays still work

If both are supplied, GNO merges:

- query-document typed lines
- explicit `queryModes`

Validation still applies across the combined set, including the single-`hyde` rule.

## Supported Surfaces

Current rollout:

- CLI: `gno query`, `gno ask`
- REST API: `/api/query`, `/api/ask`
- MCP: `gno_query`
- Web UI: Search and Ask text boxes
- SDK: `client.query(...)`, `client.ask(...)`

## Examples

### CLI

```bash
gno query $'auth flow\nterm: "refresh token"\nintent: token rotation'
```

```bash
gno ask $'term: web performance budgets\nintent: latency and vitals' --no-answer
```

### REST API

```json
{
  "query": "auth flow\nterm: \"refresh token\"\nintent: token rotation"
}
```

### SDK

```ts
const result = await client.query(
  'auth flow\\nterm: "refresh token"\\nintent: token rotation'
);
```
