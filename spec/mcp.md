# GNO MCP Specification

**Version:** 1.0.0
**Last Updated:** 2026-04-24
**Protocol:** Model Context Protocol (MCP) 2025-11-25
**Transport:** JSON-RPC 2.0 over stdio or resident Streamable HTTP

This document specifies the MCP server interface for GNO.

## Server Information

| Property  | Value                |
| --------- | -------------------- |
| Name      | `gno`                |
| Version   | `1.0.0`              |
| Command   | `gno mcp`            |
| Transport | stdio (stdin/stdout) |

## Capabilities

```json
{
  "capabilities": {
    "tools": {
      "listChanged": false
    },
    "resources": {
      "subscribe": false,
      "listChanged": false
    }
  }
}
```

---

## Security Model

### Write Tool Gating

Write tools are **disabled by default**. Enable explicitly:

```bash
gno mcp --enable-write
# or
GNO_MCP_ENABLE_WRITE=1 gno mcp
```

When disabled, write tools are not registered and cannot be invoked.

### Collection Root Validation

`gno_add_collection` rejects dangerous roots to avoid indexing broad/system paths:

- `/` (root)
- `~` (entire home dir)
- `/etc`, `/usr`, `/bin`, `/var`, `/System`, `/Library`
- `~/.config`, `~/.local`, `~/.ssh`, `~/.gnupg`

### Write Lock

All write tools acquire an OS-backed advisory lock at `.mcp-write.lock` under the index directory.
If another process holds the lock, tools return `LOCKED`.
For async jobs, the lock is held for the full job duration.

### Resident Streamable HTTP boundary

`gno serve` and `gno daemon` mount the same stateful MCP surface at `/mcp`.
The default listener is the literal IPv4 loopback address `127.0.0.1`. Each
HTTP session owns one SDK server and transport while sharing the resident
store, jobs, and model lifecycle. POST, GET, and DELETE follow MCP 2025-11-25;
resumption is not advertised.

The external boundary runs before JSON parsing or SDK dispatch on every HTTP
method. It uses Bun `server.requestIP(request)` as the peer source and never
trusts `Forwarded` or `X-Forwarded-*`. Host and present Origin headers must
match exact allowlists. Loopback defaults allow only the selected port on
`127.0.0.1` and `localhost` (or explicit `::1`).

Wildcard and non-loopback binds fail startup unless all three controls exist:

- a bearer token file readable only by its owner (`0600` or stricter on POSIX),
- at least one exact Host value, and
- at least one exact HTTP(S) Origin.

An explicitly configured missing token file is generated with a random 256-bit
token and restrictive creation mode. The token is never printed or included in
errors. Rotation, deletion, invalid content, or permission relaxation revokes
existing authenticated sessions. Session IDs are bound to the identity that
initialized them, preventing reuse with a different bearer token.

Because `gno serve` shares this listener with its Web UI and REST API, it
remains loopback-only. Use the headless `gno daemon` command for an explicitly
authenticated non-loopback MCP listener.

HTTP MCP remains read-only unless `gateway.enableWrite: true` or
`--mcp-enable-write` is explicitly set. Bearer authentication alone does not
authorize mutation. Unauthorized calls to write tools fail with HTTP 403 before
SDK dispatch.

Boundary failures use the closed
[`mcp-http-error`](./output-schemas/mcp-http-error.schema.json) body with stable,
redacted statuses: 401 (authentication), 403 (peer/Host/Origin/write), 413
(declared or streamed body), 429 (rate/request/queue/session pressure), and 503
(shutdown, revoked credentials, or unavailable runtime). Defaults are 1 MiB per
POST body, 120 requests/minute per actual peer, 64 active requests, 16 queued
requests, 32 sessions, and a five-minute idle session timeout.

### Packaged gateway conformance

`bun run test:package` installs the generated npm tarball into an isolated
environment and exercises the shipped binary. It proves two concurrent HTTP
MCP clients plus one stdio client observe equivalent tools, resources, and
search results; repeated HTTP calls reuse the same resident store and model
lifecycle. The same run validates the redacted resident-status schema,
loopback-only app-status boundary, Host/Origin,
body-size, bearer-token, token-rotation, session-identity, and write-authorization
boundaries, daemon-only authenticated non-loopback binding, and detached
restart/shutdown behavior. Windows package and binary artifact jobs remain the
final platform-specific sweep for detach rejection and known interrupt exits.

## Collection Name Rules

Collection names are case-insensitive on input and normalized to lowercase in responses.

## Job Management

- Single active job per MCP server process
- Completed job retention: 1 hour, max 100 entries
- Jobs are in-memory per process (lost on restart)
- Poll with `gno_job_status`; if the job is missing after restart, return `NOT_FOUND`

## Tools

### Agent Retrieval Playbook

- Prefer `gno_context` when the agent needs a complete, bounded evidence handoff
  for one goal. It compiles exact source spans, coverage gaps, omissions, and
  verification fingerprints in one call.
- Prefer `gno_query` for normal questions. It is the default hybrid path and returns `uri`, `docid`, snippets, and `line` anchors for follow-up reads.
- Use `gno_search` for exact phrases, filenames, identifiers, error messages, and known symbols.
- Use `gno_vsearch` for semantic similarity when wording differs and embeddings are current.
- Use `intent` to disambiguate short or overloaded terms without changing the searched text.
- Use `queryModes` when the caller has typed retrieval text: `term` for lexical anchors, `intent` for disambiguation, and at most one `hyde` hypothetical answer/document.
- Use `gno_query_diagnose` when a specific important document is missing from results or when you need per-stage retrieval evidence before changing query strategy.
- Use `gno_graph_query` for bounded typed-edge traversal over `doc_edges`; keep `gno_graph_neighbors`/`gno_graph_path` for the legacy graph projection.
- After search/query returns a `line`, call `gno_get` with `fromLine` and `lineCount` before fetching whole documents.
- Use `gno_multi_get` to batch the top result refs. Keep `maxBytes` bounded to avoid flooding client context.
- Check `gno_status` when results look stale, vector search is unavailable, or embedding backlog may explain missing results.

### Private retrieval metadata

When local tracing is enabled, successful `gno_search`, `gno_vsearch`,
`gno_query`, `gno_get`, `gno_context`, and `gno_ask` results include
non-model-visible
top-level response metadata:

```json
{
  "_meta": {
    "gno": {
      "retrievalTrace": {
        "traceId": "..."
      }
    }
  }
}
```

`structuredContent` and model-visible `content` are unchanged. `gno_get`
accepts optional `traceId` to continue an open retrieval trace and records
evidence only when a valid exact line range is returned. Out-of-range and
failed gets never fabricate evidence. Disabled tracing omits `_meta` and does
no trace ID or fingerprint work.

Trace receipt management is split into read and mutation tool names so HTTP
authorization can reject mutations before dispatch:

| Tool               | Class    | Contract                                                   |
| ------------------ | -------- | ---------------------------------------------------------- |
| `gno_trace_list`   | read     | Bounded cursor page; summaries omit replay query/goal text |
| `gno_trace_show`   | read     | One bounded detail receipt with exact totals/truncation    |
| `gno_trace_label`  | mutation | Explicit relevant/irrelevant/missing_expected judgment     |
| `gno_trace_export` | mutation | Deterministic multi-trace `agentic-receipt`                |
| `gno_trace_delete` | mutation | Delete one trace and owned records                         |
| `gno_trace_purge`  | mutation | Delete all receipts; requires `confirm: true`              |

Read tools are always registered. Mutation tools are registered only when
`enableWrite` is true and every handler rechecks that state. HTTP MCP also
classifies all four mutation names in its pre-dispatch write set. A bearer
identity authenticates a principal but never grants trace-write authority.
Denied calls return `403`/`WRITE_DISABLED` without echoing trace content.

Relevant and irrelevant targets must resolve to exact recorded evidence.
`missing_expected` accepts only a safe document identity, never raw document
content or a filesystem path. Aggregate exports reject open/missing traces and
preserve each stored terminal state without treating partial, failed, or
cancelled as negative feedback.

### gno_ask

Generate and verify one answer against a closed Context Capsule. This is a
separate read-only tool; raw retrieval remains on `gno_query`, and trace
mutation authority is not widened.

Required input:

```json
{
  "query": "Who owns the launch decision?",
  "verify": true
}
```

`verify` must be the literal `true`; implicit or raw Ask requests are rejected.
Optional fields are `collection`, `limit` (default 5), `minScore`, `lang`,
`intent`, `candidateLimit`, `exclude`, `queryModes`, `tagsAll`, `tagsAny`,
`since`, `until`, `categories`, `author`, `graph`, `noGraph`, `noRerank`,
`maxAnswerTokens`, `contextBudgetTokens`, and `contextBudgetBytes`. Input
objects are closed.

`structuredContent` uses the
[`ask`](./output-schemas/ask.schema.json) contract. Its `verification` object
contains the canonical Capsule, freshness receipt, four-state per-claim
verdicts, exact support/conflict evidence IDs and line spans, coverage, gaps,
semantic verifier capability, and explicit abstention. Every substantive claim
must be supported; otherwise the draft is withheld and `answerStatus` is
`abstained`. Contradiction is never inferred from missing evidence.

Model-visible text renders the same answer status, coverage, semantic state,
per-claim verdicts, exact `gno://` line spans, evidence IDs, gaps, and cited
sources. Capability degradation comes from the Capsule's
requested/attempted/outcome states.

The server-owned effective index is used for both Capsule compilation and
freshness verification. One Ask-owned trace covers retrieval, Context,
generation, verification, and exact retained citations. The trace ID remains
transport-only in `_meta`; no dead ID is emitted after retention eviction.
Support/conflict spans are inspectable and explicitly labelable, but they do
not create implicit relevance judgments.

### gno_context

Compile a deterministic, extractive Context Capsule. The active MCP server
supplies the canonical index name; callers cannot switch indexes in the request.
The complete canonical payload—not each document independently—must fit the
requested token and optional byte budget.

Required input:

```json
{
  "goal": "Compare the launch proposals",
  "budgetTokens": 12000
}
```

Optional input fields are `query`, `collections`, `uriPrefix`, `queryModes`,
`tagsAll`, `tagsAny`, `categories`, `author`, `lang`, `intent`, `exclude`,
`minScore`, `since`, `until`, `graph`, `noRerank`, `limit`, `candidateLimit`,
`budgetBytes`, `safetyMarginTokens`,
`safetyMarginBytes`, `depthPolicy` (`fast`, `balanced`, or `thorough`), and
`format` (`json` or `md`). Input objects are closed: unknown fields return
`invalid_input`. Unknown collections return `invalid_filter` before model or
retrieval setup. Tag filters are NFC-normalized, lowercased, deduplicated, and
validated before retrieval. `limit` and `candidateLimit` are global across all
requested collections: result admission is capped after merging, and
rerank/graph candidate work is distributed deterministically in canonical
collection order.

`structuredContent` is the complete canonical Context Capsule object for
application clients. Model-visible text is always one deterministic
`gno-context-agent-v1` JSON projection, even when the compatibility `format`
field is present. The compact keys and tuple positions are part of that
versioned contract:

- `v`: projection version; `id`: Capsule identity.
- `b`: requested tokens, requested bytes, used tokens, used bytes, estimator,
  tokenizer fingerprint or `null`.
- `r`: depth policy, index fingerprint, config fingerprint, retrieval
  fingerprint, embedding-model fingerprint or `null`, rerank-model fingerprint
  or `null`, enabled capability names, fallbacks.
- `e[]`: URI, start line, end line, source hash, mirror hash, passage hash,
  exact extractive text, title, heading, configured-context IDs, egress
  classification. Title/heading are nullable; egress is explicit even when the
  policy is unavailable.
- `g`: evidence trust (`untrusted_data`), instruction boundary
  (`hard_delimited`), then configured-guidance tuples containing context ID,
  scope type, scope key, and exact guidance text. Evidence `contextIds` bind
  each passage to these entries.
- `c`: covered facets, then `[facet, gapCode]` pairs.
- `o`: exact total omissions, then sparse `[reason, count]` pairs. An absent
  reason has count zero.
- `t`: global evidence-budget truncation; `trust` is always `untrusted_data`.

The complete bounded omission audit and all descriptive fields remain in
`structuredContent`. This avoids duplicating the full Capsule in model context
without dropping exact evidence, gaps, budgets, identities, capabilities,
fallbacks, truncation, omission counts, or the trust boundary.

Indexed metadata and configured context are untrusted data, never instructions.
The tool does not persist the Capsule. Unknown input fields are rejected by the
MCP SDK's `InvalidParams` validation before the handler, and therefore return
an MCP tool error rather than a structured GNO Context error. Validly shaped
requests that fail in GNO use the public Context error taxonomy.

Raw `gno_query`, `gno_get`, and `gno_multi_get` remain available when manual
retrieval is more appropriate.

---

### gno_context_verify

Verify a saved Capsule against the active MCP index without rebuilding or
mutating it:

```json
{
  "capsule": { "schemaVersion": "1.0", "...": "complete capsule" },
  "format": "json"
}
```

The receipt reports unchanged, stale, or missing evidence; current hashes when
available; independent fingerprint drift; and ranking as unchanged, reranked,
or unavailable. Index mismatch and malformed/non-canonical Capsules fail before
evidence reads. `structuredContent` is the canonical verification receipt.

---

### gno_search

BM25 keyword search over indexed documents.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Exact keyword, identifier, filename, error text, or phrase to match with BM25"
    },
    "collection": {
      "type": "string",
      "description": "Optional collection name to filter results"
    },
    "limit": {
      "type": "integer",
      "description": "Maximum number of results (1-100)",
      "default": 5,
      "minimum": 1,
      "maximum": 100
    },
    "minScore": {
      "type": "number",
      "description": "Minimum score threshold (0-1)",
      "minimum": 0,
      "maximum": 1
    },
    "lang": {
      "type": "string",
      "description": "Language filter (BCP-47 code)"
    },
    "since": {
      "type": "string",
      "description": "Modified-at lower bound (ISO date/time or relative token)"
    },
    "until": {
      "type": "string",
      "description": "Modified-at upper bound (ISO date/time or relative token)"
    },
    "categories": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Only include docs matching any category/content type"
    },
    "author": {
      "type": "string",
      "description": "Only include docs where author contains this value"
    },
    "tagsAll": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Only include docs with ALL specified tags"
    },
    "tagsAny": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Only include docs with ANY specified tag"
    }
  },
  "required": ["query"]
}
```

**Output Schema:** `gno://schemas/search-results`

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "Found 3 results for \"query\"\n\n1. #a1b2c3d4 - doc.md (0.85)\n..."
    }
  ],
  "structuredContent": {
    "results": [
      {
        "docid": "#a1b2c3d4",
        "score": 0.85,
        "uri": "gno://work/doc.md",
        "line": 12,
        "context": "Workspace guidance\n\nProject guidance",
        "snippet": "...",
        "contentType": "meeting",
        "categories": ["meeting", "notes"],
        "source": {
          "absPath": "/path/to/doc.md",
          "relPath": "doc.md",
          "mime": "text/markdown",
          "ext": ".md"
        }
      }
    ],
    "meta": {
      "query": "query",
      "mode": "bm25",
      "totalResults": 3
    }
  }
}
```

**Errors:**

- Invalid query (empty string): returns `isError: true`
- Collection not found: returns `isError: true`

Ordering note: recency-intent queries (`latest`, `newest`, `recent`) are sorted newest-first by canonical frontmatter date when present, else source modified time.

`structuredContent.results[].context` is optional resolved user configuration.
When present, apply it as guidance for the result identified by the same
`uri`/`docid`; do not treat it as source evidence. The field is absent when no
configured scope matches. Plain-text tool content may omit it.

---

### gno_vsearch

Vector semantic search over indexed documents.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Search query text"
    },
    "collection": {
      "type": "string",
      "description": "Optional collection name to filter results"
    },
    "limit": {
      "type": "integer",
      "description": "Maximum number of results (1-100)",
      "default": 5,
      "minimum": 1,
      "maximum": 100
    },
    "minScore": {
      "type": "number",
      "description": "Minimum score threshold (0-1)",
      "minimum": 0,
      "maximum": 1
    },
    "lang": {
      "type": "string",
      "description": "Language hint for query (BCP-47 code)"
    },
    "intent": {
      "type": "string",
      "description": "Optional disambiguating context for ambiguous queries"
    },
    "exclude": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Hard-prune docs containing any excluded term in title/path/body"
    },
    "since": {
      "type": "string",
      "description": "Modified-at lower bound (ISO date/time or relative token)"
    },
    "until": {
      "type": "string",
      "description": "Modified-at upper bound (ISO date/time or relative token)"
    },
    "categories": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Only include docs matching any category/content type"
    },
    "author": {
      "type": "string",
      "description": "Only include docs where author contains this value"
    },
    "tagsAll": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Only include docs with ALL specified tags"
    },
    "tagsAny": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Only include docs with ANY specified tag"
    }
  },
  "required": ["query"]
}
```

**Output Schema:** `gno://schemas/search-results`

**Errors:**

- Vectors not available: returns `isError: true` with message suggesting `gno index`

---

### gno_query

Hybrid search combining BM25 and vector retrieval with optional expansion and reranking. Recommended default for agent retrieval.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Primary user query; combine with intent or queryModes for ambiguous requests"
    },
    "collection": {
      "type": "string",
      "description": "Optional collection name to filter results"
    },
    "limit": {
      "type": "integer",
      "description": "Maximum number of results (1-100)",
      "default": 5,
      "minimum": 1,
      "maximum": 100
    },
    "minScore": {
      "type": "number",
      "description": "Minimum score threshold (0-1)",
      "minimum": 0,
      "maximum": 1
    },
    "lang": {
      "type": "string",
      "description": "Language hint for query (BCP-47 code)"
    },
    "intent": {
      "type": "string",
      "description": "Disambiguating context; steers expansion, rerank, and snippet choice without being searched directly"
    },
    "candidateLimit": {
      "type": "integer",
      "description": "Maximum candidates sent to reranking (1-100); raise for recall, lower for latency",
      "minimum": 1,
      "maximum": 100
    },
    "exclude": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Hard-prune docs containing any excluded term in title/path/body"
    },
    "since": {
      "type": "string",
      "description": "Modified-at lower bound (ISO date/time or relative token)"
    },
    "until": {
      "type": "string",
      "description": "Modified-at upper bound (ISO date/time or relative token)"
    },
    "categories": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Only include docs matching any category/content type"
    },
    "author": {
      "type": "string",
      "description": "Only include docs where author contains this value"
    },
    "queryModes": {
      "type": "array",
      "description": "Typed retrieval entries: term anchors, intent disambiguation, and at most one hyde hypothetical document",
      "items": {
        "type": "object",
        "properties": {
          "mode": {
            "type": "string",
            "enum": ["term", "intent", "hyde"]
          },
          "text": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": ["mode", "text"]
      }
    },
    "expand": {
      "type": "boolean",
      "description": "Enable query expansion (slower, better recall)",
      "default": false
    },
    "rerank": {
      "type": "boolean",
      "description": "Enable cross-encoder reranking",
      "default": true
    },
    "noGraph": {
      "type": "boolean",
      "description": "Compatibility no-op unless graph is also true",
      "default": false
    },
    "graph": {
      "type": "boolean",
      "description": "Enable bounded one-hop graph neighbor expansion",
      "default": false
    },
    "fast": {
      "type": "boolean",
      "description": "Fast mode: skip expansion and reranking (~0.7s)",
      "default": false
    },
    "thorough": {
      "type": "boolean",
      "description": "Thorough mode: enable expansion for broad research or missed recall (~5-8s)",
      "default": false
    },
    "tagsAll": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Only include docs with ALL specified tags"
    },
    "tagsAny": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Only include docs with ANY specified tag"
    }
  },
  "required": ["query"]
}
```

**Output Schema:** `gno://schemas/search-results`

Validation note: `queryModes[].text` is trimmed and must remain non-empty; only one `mode: "hyde"` entry is allowed.

Search result items include `contentType` when available and always include
`categories` as the category/content-type filter set. Text output remains
human-oriented; structured clients should read `structuredContent.results`.
Structured result items also preserve optional `context` guidance in
global-to-specific order without changing the result `uri` or `docid`.

Compatibility / migration notes:

- Existing `gno_query` tool calls remain valid without `queryModes`.
- `intent` is orthogonal to `queryModes`: intent steers scoring/prompting, while query modes inject caller-provided retrieval expansions.
- `candidateLimit` tunes rerank cost without changing retrieval contracts.
- `exclude` hard-prunes matching docs after retrieval using title/path/body text.
- `gno_query` does not use graph expansion by default. Set `graph: true` to add capped one-hop graph neighbors after initial retrieval. Explicit links receive stronger treatment than inferred, ambiguous, or similarity edges.
- `queryModes` is optional; use it only when clients need explicit retrieval intent control.
- When `queryModes` is present, generated expansion is skipped and provided entries are used directly.

**Response structuredContent includes:**

```json
{
  "results": [
    {
      "docid": "#a1b2c3d4",
      "uri": "gno://work/doc.md",
      "context": "Workspace guidance\n\nProject guidance",
      "contentType": "meeting",
      "categories": ["meeting", "notes"],
      "score": 0.92
    }
  ],
  "meta": {
    "query": "query",
    "mode": "hybrid",
    "expanded": true,
    "reranked": true,
    "vectorsUsed": true,
    "totalResults": 5
  }
}
```

**Graceful Degradation:**

- If vectors unavailable: `mode: "bm25_only"`, `vectorsUsed: false`
- If expansion model unavailable: `expanded: false`
- If rerank model unavailable: `reranked: false`

---

### gno_query_diagnose

Targeted retrieval diagnostics for one named document. This read-only tool wraps
`diagnoseQueryTarget()` and uses the same query/filter controls as `gno_query`
plus a required `target` reference.

**Input Schema:** same fields as `gno_query`, plus:

```json
{
  "target": "gno://notes/people/alice.md"
}
```

- `target`: URI, `#docid`, or `collection/path` for the document to diagnose.
- `query`, filters, `queryModes`, `fast`/`thorough`, `graph`, and rerank/expand controls behave like `gno_query`.

**Output Schema:** `gno://schemas/query-diagnose@1.0`

Structured content includes `schemaVersion`, normalized `query`, `target`
metadata/status (`not_found`, `inactive`, `no_indexed_content`,
`filtered_out`, or `diagnosed`), `stages` for BM25/vector/fusion/graph/rerank,
the selected target `chunk`, and retrieval `meta`.

Use when an expected target is missing from `gno_query`, when filters may have
excluded it, or when an agent needs evidence before raising `candidateLimit`,
changing `queryModes`, enabling graph expansion, or fetching more context.
For low-latency or CPU-only diagnosis, `fast: true` keeps this MCP tool
BM25-only and avoids initializing embedding/rerank models.

---

### gno_get

Retrieve a single document by reference.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "ref": {
      "type": "string",
      "description": "Document reference: gno:// URI, collection/path, or #docid"
    },
    "fromLine": {
      "type": "integer",
      "description": "Start at line number (1-indexed); use search/query result line anchors",
      "minimum": 1
    },
    "lineCount": {
      "type": "integer",
      "description": "Number of lines to return; prefer a small range before fetching full docs",
      "minimum": 1
    },
    "lineNumbers": {
      "type": "boolean",
      "description": "Include line numbers in content",
      "default": true
    }
  },
  "required": ["ref"]
}
```

**Output Schema:** `gno://schemas/get`

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "1: # Document Title\n2: \n3: Content here..."
    }
  ],
  "structuredContent": {
    "docid": "#a1b2c3d4",
    "uri": "gno://work/doc.md",
    "title": "Document Title",
    "content": "# Document Title\n\nContent here...",
    "totalLines": 150,
    "returnedLines": { "start": 1, "end": 150 },
    "source": {
      "absPath": "/path/to/doc.md",
      "relPath": "doc.md",
      "mime": "text/markdown",
      "ext": ".md",
      "modifiedAt": "2025-12-23T10:00:00Z",
      "sizeBytes": 4096
    },
    "capabilities": {
      "editable": true,
      "tagsEditable": true,
      "tagsWriteback": true,
      "canCreateEditableCopy": false,
      "mode": "editable"
    }
  }
}
```

**Errors:**

- Document not found: returns `isError: true`
- Invalid ref format: returns `isError: true`
- Indexed URI names a missing index: returns `isError: true` without creating it

For `gno://...?...index=<name>` refs, the tool reads the named index rather than
the MCP server's active index.

`<name>` follows the CLI index-name contract: 1–64 UTF-16 code units drawn from
Unicode letters, marks, numbers, internal ASCII spaces, `.`, `_`, or `-`; it
starts with a letter or number, cannot end with a space or `.`, and cannot
contain `..`. Invalid names are rejected before filesystem access. NFC/case-
folded equivalents share one logical identity. The canonical identity is
limited to 242 UTF-8 bytes so `index-<identity>.sqlite` stays within the portable
255-byte filename-component limit.

---

### gno_multi_get

Retrieve multiple documents by pattern or list.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "refs": {
      "type": "array",
      "description": "Array of document references from search/query results (gno:// URIs or docids)",
      "items": {
        "type": "string"
      }
    },
    "pattern": {
      "type": "string",
      "description": "Glob pattern to match documents (alternative to refs)"
    },
    "maxBytes": {
      "type": "integer",
      "description": "Maximum bytes per document before truncation; lower when batching many refs",
      "default": 10240
    },
    "lineNumbers": {
      "type": "boolean",
      "description": "Include line numbers in content",
      "default": true
    }
  }
}
```

**Note:** Provide either `refs` or `pattern`, not both.

All refs in one request must resolve to one index. Explicit refs for different
indexes, or indexed refs mixed with unindexed refs from another active index,
return `isError: true`; callers must split the batch by index.

**Output Schema:** `gno://schemas/multi-get`

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "Retrieved 3 documents (1 skipped due to size limit)"
    }
  ],
  "structuredContent": {
    "documents": [...],
    "skipped": [
      {
        "ref": "gno://work/large.pdf",
        "reason": "exceeds maxBytes"
      }
    ],
    "meta": {
      "requested": 4,
      "returned": 3,
      "skipped": 1
    }
  }
}
```

---

### gno_status

Get index status and health information.

`structuredContent.resident` uses
`gno://schemas/resident-status@1.0`. HTTP sessions observe the shared
serve/daemon runtime counters. Stdio remains a standalone lifecycle and reports
`mode:"stdio"`, `resident:false`, no listener, and zero resident transport
counters; it never claims attachment to another process.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {}
}
```

**Output Schema:** `gno://schemas/status`

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "Index: default\nCollections: 2\nDocuments: 150\nChunks: 800\nEmbedding backlog: 0"
    }
  ],
  "structuredContent": {
    "indexName": "default",
    "collections": [
      {
        "name": "work",
        "documentCount": 100,
        "chunkCount": 500,
        "embeddedCount": 500
      }
    ],
    "totalDocuments": 150,
    "totalChunks": 800,
    "embeddingBacklog": 0,
    "healthy": true
  }
}
```

---

### gno_capture

Create a new document in a collection (write-enabled).

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "collection": {
      "type": "string",
      "description": "Target collection name"
    },
    "content": {
      "type": "string",
      "description": "Document content (markdown). Optional when presetId provides the scaffold."
    },
    "title": {
      "type": "string",
      "description": "Optional title used for filename generation"
    },
    "path": {
      "type": "string",
      "description": "Optional relative path within the collection"
    },
    "folderPath": {
      "type": "string",
      "description": "Optional folder path within the collection"
    },
    "collisionPolicy": {
      "type": "string",
      "enum": ["error", "open_existing", "create_with_suffix"],
      "description": "How to handle name collisions"
    },
    "presetId": {
      "type": "string",
      "enum": [
        "blank",
        "project-note",
        "research-note",
        "decision-note",
        "prompt-pattern",
        "source-summary",
        "idea-original",
        "person",
        "company-project",
        "meeting"
      ],
      "description": "Optional note preset scaffold"
    },
    "overwrite": {
      "type": "boolean",
      "description": "Overwrite existing file if true",
      "default": false
    },
    "tags": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Tags to apply to the document"
    },
    "source": {
      "type": "object",
      "description": "Optional provenance metadata; written under structured source frontmatter",
      "properties": {
        "kind": {
          "type": "string",
          "enum": [
            "direct",
            "web",
            "email",
            "meeting",
            "chat",
            "file",
            "api",
            "unknown"
          ]
        },
        "title": { "type": "string" },
        "url": { "type": "string", "format": "uri" },
        "uri": { "type": "string" },
        "docid": { "type": "string" },
        "mime": { "type": "string" },
        "ext": { "type": "string" },
        "author": { "type": "string" },
        "observedAt": { "type": "string", "format": "date-time" },
        "capturedAt": { "type": "string", "format": "date-time" },
        "externalId": { "type": "string" }
      }
    }
  },
  "required": ["collection"]
}
```

**Notes:**

- Paths must be relative, no `..` escapes, no NUL bytes
- Sensitive subpaths are rejected (`.ssh`, `.gnupg`, `.git`, `node_modules`, etc.)
- If `path` is omitted, a `.md` filename is generated from the title or heading
- `folderPath` lets clients create inside a specific subfolder
- `collisionPolicy` supports `error`, `open_existing`, or `create_with_suffix`
- Legacy `overwrite: true` overwrites an existing target path and returns
  `collisionPolicyResult: "overwritten"`; otherwise existing targets follow
  `collisionPolicy`
- `presetId` applies a structured note scaffold before write
- Content is required unless `presetId` can scaffold a non-empty note
- Content must be text; NUL or binary-like control bytes are rejected
- Default generated captures use `inbox/YYYY-MM-DD/capture-<body-hash>.md`
- Collision checks include indexed documents and disk-only files
- Non-overwrite captures fail instead of replacing a file that appears after
  planning
- Capture writes structured `source:` frontmatter with `kind`, `capturedAt`,
  and optional `url`, `uri`, `docid`, `mime`, `ext`, `author`, `observedAt`,
  `externalId`, and `title`
- Tags are validated and normalized to lowercase
- For Markdown files, tags are added to frontmatter
- For non-Markdown files, tags are stored as user-source in the database
- Receipts distinguish write result from sync and embedding state; capture does
  not imply embedding unless `embed.status` is `completed`
- Writes run under the MCP write lock and are only registered when the server
  starts with `--enable-write` or `GNO_MCP_ENABLE_WRITE=1`

**Output Schema:** `gno://schemas/mcp-capture-result@1.0`, compatible with the
shared `gno://schemas/capture-receipt@1.0` contract.

---

### gno_list_tags

List all tags with document counts.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "collection": {
      "type": "string",
      "description": "Filter by collection name"
    },
    "prefix": {
      "type": "string",
      "description": "Filter by tag prefix (e.g., 'work/' matches 'work/project')"
    }
  }
}
```

**Output Schema:** `gno://schemas/tags-list@1.0`

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "Found 5 tags:\n\n  work (10)\n  personal (5)\n  ..."
    }
  ],
  "structuredContent": {
    "tags": [
      { "tag": "work", "count": 10 },
      { "tag": "personal", "count": 5 }
    ],
    "meta": {
      "collection": null,
      "prefix": null,
      "totalTags": 5
    }
  }
}
```

---

### gno_links

Get outgoing links from a document.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "ref": {
      "type": "string",
      "description": "Document reference: gno:// URI, collection/path, or #docid"
    },
    "type": {
      "type": "string",
      "enum": ["wiki", "markdown"],
      "description": "Filter by link type"
    }
  },
  "required": ["ref"]
}
```

**Output Schema:** `gno://schemas/links@1.0`

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "Found 3 outgoing links in gno://notes/index.md:\n\n  [wiki] Target Note (line 5)\n  ..."
    }
  ],
  "structuredContent": {
    "links": [
      {
        "targetRef": "Target Note",
        "targetAnchor": "section-1",
        "targetCollection": "notes",
        "linkType": "wiki",
        "linkText": "see target",
        "position": { "startLine": 5, "startCol": 10 }
      }
    ],
    "meta": {
      "docid": "#a1b2c3d4",
      "uri": "gno://notes/index.md",
      "title": "Index",
      "totalLinks": 3,
      "filterType": null
    }
  }
}
```

**Errors:**

- Document not found: returns `isError: true`
- Invalid ref format: returns `isError: true`

---

### gno_backlinks

Get documents linking TO a document.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "ref": {
      "type": "string",
      "description": "Document reference: gno:// URI, collection/path, or #docid"
    },
    "collection": {
      "type": "string",
      "description": "Filter source documents by collection"
    }
  },
  "required": ["ref"]
}
```

**Output Schema:** `gno://schemas/backlinks@1.0`

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "Found 2 backlinks to gno://notes/target.md:\n\n  gno://notes/index.md \"Index\" (line 10)\n  ..."
    }
  ],
  "structuredContent": {
    "backlinks": [
      {
        "sourceDocUri": "gno://notes/index.md",
        "sourceDocTitle": "Index",
        "linkText": "Target Note",
        "position": { "startLine": 10, "startCol": 5 }
      }
    ],
    "meta": {
      "docid": "#a1b2c3d4",
      "uri": "gno://notes/target.md",
      "title": "Target Note",
      "totalBacklinks": 2,
      "filterCollection": null
    }
  }
}
```

**Errors:**

- Document not found: returns `isError: true`
- Collection not found: returns `isError: true`
- Invalid ref format: returns `isError: true`

---

### gno_similar

Find semantically similar documents using vector embeddings.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "ref": {
      "type": "string",
      "description": "Document reference: gno:// URI, collection/path, or #docid"
    },
    "limit": {
      "type": "integer",
      "description": "Maximum number of similar documents (1-50)",
      "default": 5,
      "minimum": 1,
      "maximum": 50
    },
    "threshold": {
      "type": "number",
      "description": "Minimum similarity score (0-1)",
      "minimum": 0,
      "maximum": 1
    },
    "crossCollection": {
      "type": "boolean",
      "description": "Include documents from other collections",
      "default": false
    }
  },
  "required": ["ref"]
}
```

**Output Schema:** `gno://schemas/similar@1.0`

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "Found 3 similar documents for gno://notes/readme.md:\n\n  [#def5678] gno://notes/guide.md (0.85)\n  ..."
    }
  ],
  "structuredContent": {
    "similar": [
      {
        "docid": "#def5678",
        "uri": "gno://notes/guide.md",
        "title": "Guide",
        "score": 0.85,
        "absPath": "/path/to/notes/guide.md"
      }
    ],
    "meta": {
      "docid": "#a1b2c3d4",
      "uri": "gno://notes/readme.md",
      "title": "README",
      "totalSimilar": 3,
      "threshold": null,
      "crossCollection": false
    }
  }
}
```

**Algorithm:**

1. Get all chunks for the source document
2. Retrieve embeddings for each chunk from content_vectors
3. Compute average embedding across all chunks
4. Search for nearest neighbors using sqlite-vec
5. Exclude self and filter by collection if not crossCollection
6. Return top N similar documents with scores

**Errors:**

- Document not found: returns `isError: true`
- Document has no content: returns `isError: true`
- Document has no embeddings: returns `isError: true`
- Vector search unavailable (sqlite-vec not loaded): returns `isError: true`
- Invalid ref format: returns `isError: true`

---

### gno_graph

Get knowledge graph of document connections plus graph-health report fields.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "collection": {
      "type": "string",
      "description": "Filter to single collection"
    },
    "limit": {
      "type": "integer",
      "description": "Maximum nodes (1-5000)",
      "default": 2000,
      "minimum": 1,
      "maximum": 5000
    },
    "edgeLimit": {
      "type": "integer",
      "description": "Maximum edges (1-50000)",
      "default": 10000,
      "minimum": 1,
      "maximum": 50000
    },
    "includeSimilar": {
      "type": "boolean",
      "description": "Include semantic similarity edges",
      "default": false
    },
    "threshold": {
      "type": "number",
      "description": "Similarity threshold (0-1)",
      "default": 0.7,
      "minimum": 0,
      "maximum": 1
    },
    "linkedOnly": {
      "type": "boolean",
      "description": "Exclude isolated nodes (no connections)",
      "default": true
    },
    "similarTopK": {
      "type": "integer",
      "description": "Similar documents per node (1-20)",
      "default": 5,
      "minimum": 1,
      "maximum": 20
    }
  },
  "required": []
}
```

**Output Schema:** `gno://schemas/graph@1.0`

The structured response includes `report.hubs`, `report.bridgeCandidates`,
`report.isolated`, `report.unresolvedLinks`, `report.edgeTypes`,
`report.edgeConfidence`, `report.communities`, node `communityId` assignments,
and per-edge `confidence` / `audit` metadata so agents can assess graph health,
clusters, and trust before deeper traversal.

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "Knowledge Graph: 150 nodes, 320 edges\n\nTop nodes by degree:\n  [#abc123] gno://notes/readme.md \"README\" (degree: 12)\n  ..."
    }
  ],
  "structuredContent": {
    "nodes": [
      {
        "id": "#abc123",
        "uri": "gno://notes/readme.md",
        "title": "README",
        "collection": "notes",
        "relPath": "readme.md",
        "degree": 12,
        "communityId": "c1"
      }
    ],
    "links": [
      {
        "source": "#abc123",
        "target": "#def456",
        "type": "wiki",
        "weight": 1
      }
    ],
    "meta": {
      "collection": null,
      "nodeLimit": 2000,
      "edgeLimit": 10000,
      "totalNodes": 150,
      "totalEdges": 320,
      "returnedNodes": 150,
      "returnedEdges": 320,
      "truncated": false,
      "linkedOnly": true,
      "includedSimilar": false
    }
  }
}
```

**Edge Types:**

- `wiki`: Wiki link (`[[Target]]`)
- `markdown`: Markdown link (`[text](path.md)`)
- `similar`: Semantic similarity (only when `includeSimilar: true`)

**Errors:**

- Collection not found: returns `isError: true`

---

### gno_graph_query

Bounded typed-edge traversal over the `doc_edges` relationship layer. This
read-only tool wraps the shared graph-query core.

**Input Schema:**

```json
{
  "ref": "gno://notes/people/alice.md",
  "direction": "both",
  "edgeType": "works_at",
  "maxDepth": 2,
  "maxNodes": 100,
  "frontierLimit": 100,
  "visitedLimit": 500
}
```

- `ref`: root document ref (URI, `#docid`, or `collection/path`).
- `direction`: `out`, `in`, or `both` (default `both`).
- `edgeType`: optional semantic edge type filter.
- `relation`: alias for `edgeType`; if both are set they must match.
- `maxDepth`: 1-6, default 2.
- `maxNodes`: 1-1000, default 100.
- `frontierLimit`: 1-1000, default 100.
- `visitedLimit`: 1-5000, default 500.

**Output Schema:** `gno://schemas/graph-query@1.0`

Structured content includes `schemaVersion`, resolved `root`, typed `nodes`
with graph hints, typed `edges` with `edgeType`/`relationType`/`confidence`/
`edgeSource`, and `meta` with direction, caps, returned counts, warnings, and
`truncated`.

Use for explicit relationship questions over typed edges such as `works_at`,
`attended`, or `mentions` after a seed ref is known. Use `gno_query` first if
the seed document is unknown.

---

### gno_graph_neighbors

Find incoming and outgoing graph neighbors for one document/node.

**Input Schema:** same graph filter fields as `gno_graph`, plus:

```json
{
  "ref": "notes/readme.md",
  "direction": "both"
}
```

- `ref`: URI, `#docid`, `collection/path`, `relPath`, or exact title.
- `direction`: `both`, `out`, or `in` (default: `both`).

Use for relationship questions, missed related docs, and corpus navigation after
`gno_query` finds a seed document. Follow with `gno_get` for evidence.

---

### gno_graph_path

Find the shortest relationship path between two documents/nodes.

**Input Schema:** same graph filter fields as `gno_graph`, plus:

```json
{
  "from": "notes/a.md",
  "to": "notes/b.md",
  "maxDepth": 6
}
```

- `from`, `to`: URI, `#docid`, `collection/path`, `relPath`, or exact title.
- `maxDepth`: maximum hops to search (1-12, default: 6).

Use for "how are X and Y connected?" prompts. Run `gno_query` first when either
endpoint is unknown, then read path nodes with `gno_get`.

---

### gno_add_collection

Add a folder as a new collection and start indexing (write-enabled).

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Absolute or ~-expanded folder path"
    },
    "name": {
      "type": "string",
      "description": "Optional collection name (defaults to folder name)"
    },
    "pattern": {
      "type": "string",
      "description": "Glob pattern (default: **/*.md)"
    },
    "include": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Additional include patterns"
    },
    "exclude": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Exclude patterns"
    },
    "gitPull": {
      "type": "boolean",
      "description": "Run git pull before indexing",
      "default": false
    }
  },
  "required": ["path"]
}
```

**Output Schema:** `gno://schemas/mcp-add-collection-result@1.0`

---

### gno_create_folder

Create a folder inside an existing collection (write-enabled).

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "collection": { "type": "string" },
    "name": { "type": "string" },
    "parentPath": { "type": "string" }
  },
  "required": ["collection", "name"]
}
```

---

### gno_rename_note

Rename an editable note in place (write-enabled).

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "ref": { "type": "string" },
    "name": { "type": "string" }
  },
  "required": ["ref", "name"]
}
```

---

### gno_move_note

Move an editable note to another folder in the same collection (write-enabled).

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "ref": { "type": "string" },
    "folderPath": { "type": "string" },
    "name": { "type": "string" }
  },
  "required": ["ref", "folderPath"]
}
```

---

### gno_duplicate_note

Duplicate an editable note into the current or another folder (write-enabled).

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "ref": { "type": "string" },
    "folderPath": { "type": "string" },
    "name": { "type": "string" }
  },
  "required": ["ref"]
}
```

---

### gno_sync

Reindex one or all collections (write-enabled).

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "collection": {
      "type": "string",
      "description": "Collection to sync (all if omitted)"
    },
    "gitPull": {
      "type": "boolean",
      "description": "Run git pull before indexing",
      "default": false
    },
    "runUpdateCmd": {
      "type": "boolean",
      "description": "Run updateCmd before indexing (default: false for MCP)",
      "default": false
    }
  }
}
```

**Output Schema:** `gno://schemas/mcp-sync-result@1.0`

---

### gno_embed

Generate embeddings for unembedded chunks (write-enabled). Runs as background job.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "collection": {
      "type": "string",
      "description": "Optional collection name to embed"
    }
  }
}
```

**Output Schema:** `gno://schemas/mcp-embed-result@1.0`

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "Job: <uuid>\nStatus: started\nModel: <model-uri>"
    }
  ],
  "structuredContent": {
    "jobId": "<uuid>",
    "status": "started",
    "model": "<model-uri>"
  }
}
```

**Notes:**

- Requires `--enable-write` flag
- Fails fast if embedding model not cached (run `gno models pull embed` first)
- Poll job status with `gno_job_status`

---

### gno_clear_collection_embeddings

Clear stale or all embeddings for one collection (write-enabled).

**Input Schema:**

```json
{
  "type": "object",
  "required": ["collection"],
  "properties": {
    "collection": {
      "type": "string",
      "description": "Collection name"
    },
    "mode": {
      "type": "string",
      "enum": ["stale", "all"],
      "default": "stale"
    }
  }
}
```

---

### gno_index

Full index: sync files + generate embeddings (write-enabled). Runs as background job.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "collection": {
      "type": "string",
      "description": "Collection to index (all if omitted)"
    },
    "gitPull": {
      "type": "boolean",
      "description": "Run git pull before sync",
      "default": false
    }
  }
}
```

**Output Schema:** `gno://schemas/mcp-index-result@1.0`

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "Job: <uuid>\nStatus: started\nCollections: work, notes\nPhases: sync → embed"
    }
  ],
  "structuredContent": {
    "jobId": "<uuid>",
    "status": "started",
    "collections": ["work", "notes"],
    "phases": ["sync", "embed"],
    "options": {
      "gitPull": false,
      "runUpdateCmd": false
    }
  }
}
```

**Notes:**

- Requires `--enable-write` flag
- Runs sync phase first, then embed phase
- `runUpdateCmd` is always false for MCP (security)
- Fails fast if embedding model not cached
- Poll job status with `gno_job_status`

---

### gno_remove_collection

Remove a collection from config (write-enabled). Indexed data is retained.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "collection": {
      "type": "string",
      "description": "Collection name to remove"
    }
  },
  "required": ["collection"]
}
```

**Output Schema:** `gno://schemas/mcp-remove-result@1.0`

---

### gno_job_status

Get status of a background job.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "jobId": {
      "type": "string",
      "description": "Job identifier"
    }
  },
  "required": ["jobId"]
}
```

**Output Schema:** `gno://schemas/mcp-job-status@1.0`

---

### gno_list_jobs

List active and recent jobs.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "limit": {
      "type": "integer",
      "description": "Max recent jobs to return",
      "default": 10
    }
  }
}
```

**Output Schema:** `gno://schemas/mcp-job-list@1.0`

---

## Resources

### gno://tags

List all tags with document counts. Supports query parameters for filtering.

**URI Pattern:** `gno://tags` or `gno://tags?collection=x&prefix=work/`

**Query Parameters:**

| Parameter    | Description                           |
| ------------ | ------------------------------------- |
| `collection` | Filter tags by collection name        |
| `prefix`     | Filter tags by prefix (e.g., `work/`) |

**Response:**

MIME type: `application/json`

```json
{
  "tags": [
    { "tag": "work", "count": 10 },
    { "tag": "personal", "count": 5 }
  ],
  "meta": {
    "collection": null,
    "prefix": null,
    "totalTags": 2
  }
}
```

---

### gno://{collection}/{path}

Read document content by URI.

**URI Pattern:** `gno://{collection}/{relativePath}[?index={name}]`

**Examples:**

- `gno://work/contracts/nda.docx`
- `gno://notes/2025/01/meeting.md`
- `gno://notes/2025/01/meeting.md?index=research`

**Response:**

MIME type: `text/markdown`

Content includes optional header comment:

```markdown
<!-- gno://work/contracts/nda.docx
     docid: #a1b2c3d4
     source: /abs/path/to/nda.docx
     mime: application/vnd.openxmlformats-officedocument.wordprocessingml.document
-->

1: # Contract
2:
3: This Non-Disclosure Agreement...
```

**Header Fields:**
| Field | Description |
|-------|-------------|
| URI | Full gno:// URI |
| docid | Document ID |
| source | Absolute path to source file |
| mime | Source file MIME type |
| language | Document language hint (if available) |

**Behavior:**

- Returns Markdown mirror content (converted from source)
- Line numbers included by default for agent friendliness
- Header is display-only, not part of indexed content
- An `index` query opens that named database; a missing index errors without
  creating an empty database

**Errors:**

- Document not found: standard MCP resource error
- Collection not found: standard MCP resource error

---

## URI Encoding

Special characters in URIs are URL-encoded per RFC 3986:

| Character | Encoded |
| --------- | ------- |
| Space     | `%20`   |
| `#`       | `%23`   |
| `?`       | `%3F`   |
| `%`       | `%25`   |

Path separators (`/`) are preserved.

**Example:**

- File: `My Documents/file name.pdf`
- URI: `gno://work/My%20Documents/file%20name.pdf`

---

## Error Handling

Tool errors return:

```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "Error: Document not found: #invalid"
    }
  ]
}
```

Resource errors use standard MCP error responses.

### MCP Error Codes (Write Tools)

- `NOT_FOUND` — Resource not found
- `DUPLICATE` — Resource already exists
- `CONFLICT` — Conflict with existing resource
- `HAS_REFERENCES` — Collection referenced by contexts
- `INVALID_PATH` — Path violates safety rules
- `PATH_NOT_FOUND` — Path does not exist
- `JOB_CONFLICT` — Another job is already running
- `LOCKED` — Another MCP process holds the write lock

---

## Versioning

### Tool Versioning

Tools are versioned via the server version. Breaking changes require major version bump.

**Compatibility Rules:**

- New optional input parameters: minor version
- New output fields: minor version
- Removing/renaming parameters: major version
- Changing output structure: major version

### Schema Versioning

Output schemas include version in `$id`:

- `gno://schemas/search-result@1.0`
- `gno://schemas/capture-receipt@1.0`

Clients should check schema version for compatibility.

---

## Session Behavior

- DB connection kept open for server lifetime
- No persistent state between tool calls
- Each tool call is independent
- Server handles concurrent requests sequentially

---

## CLI Commands

GNO provides CLI commands to manage MCP server installation.

### gno mcp install

Install gno as an MCP server in client configurations.

**Synopsis:**

```bash
gno mcp install [options]
```

**Options:**

| Option                  | Description                                                                                                   | Default                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `-t, --target <target>` | One of the 10 supported automatic clients                                                                     | `claude-desktop`                  |
| `-s, --scope <scope>`   | `user` or `project`; project is supported by Claude Code, Codex, Cursor, OpenCode, and project-only LibreChat | Target default (otherwise `user`) |
| `-f, --force`           | Overwrite existing configuration                                                                              | `false`                           |
| `--dry-run`             | Show what would be done without changes                                                                       | `false`                           |
| `--enable-write`        | Install config with `--enable-write` args                                                                     | `false`                           |
| `--json`                | JSON output                                                                                                   | `false`                           |

**Config Locations:**

| Target           | Scope(s)      | Config path                                                           |
| ---------------- | ------------- | --------------------------------------------------------------------- |
| `claude-desktop` | user          | `~/Library/Application Support/Claude/claude_desktop_config.json`     |
| `claude-code`    | user, project | `~/.claude.json`, `./.mcp.json`                                       |
| `codex`          | user, project | `~/.codex/config.toml`, `./.codex/config.toml`                        |
| `cursor`         | user, project | `~/.cursor/mcp.json`, `./.cursor/mcp.json`                            |
| `zed`            | user          | `~/.config/zed/settings.json`; Windows: `%APPDATA%\Zed\settings.json` |
| `windsurf`       | user          | `~/.codeium/windsurf/mcp_config.json`                                 |
| `opencode`       | user, project | `~/.config/opencode/opencode.json`, `./opencode.json`                 |
| `amp`            | user          | `~/.config/amp/settings.json`                                         |
| `lmstudio`       | user          | `~/.lmstudio/mcp.json`                                                |
| `librechat`      | project       | `./librechat.yaml`                                                    |

**Example:**

```bash
# Install for Claude Desktop (default)
gno mcp install

# Install for Claude Code (user scope)
gno mcp install -t claude-code

# Install for Claude Code (project scope)
gno mcp install -t claude-code -s project

# Install for project-only LibreChat
gno mcp install -t librechat -s project

# Preview changes
gno mcp install --dry-run

# Install with write tools enabled
gno mcp install --enable-write
```

**Installed entry contract:** The command is the absolute current Bun
executable. Arguments are `run`, the absolute `src/index.ts` from the currently
installed GNO package, `--index <active>`, `--config <absolute>`, then `mcp`.
`--enable-write`, when requested, follows `mcp`. The config path is the active
explicit, environment-selected, or default config resolved to an absolute path.
Entries also pin absolute `GNO_DATA_DIR` and `GNO_CACHE_DIR` values under `env`
(`environment` for OpenCode). No other environment keys are accepted by status
or activation verification, and all values must be absolute paths without
control characters. Codex uses native `[mcp_servers.gno]` and nested
`[mcp_servers.gno.env]` TOML tables; install, update, and uninstall preserve
unrelated TOML and comments. The index, config, data, and cache identity are
always pinned because GUI clients do not reliably inherit the installing
shell's `PATH` or environment. Invalid or empty index names fail before the
target client config is written.
JSON/JSONC targets preserve comments, trailing commas, and unrelated layout;
OpenCode and Amp reuse supported existing `.jsonc` alternates rather than
creating duplicate `.json` configs. `--dry-run --json` returns normalized
command, argument, and workspace values rather than a target-specific persisted
wrapper. Previewing an existing entry requires `--force --dry-run --json`.

Standard JSON/YAML entries use this shape (with target-specific outer keys):

```json
{
  "command": "/absolute/path/to/bun",
  "args": [
    "run",
    "/absolute/path/to/@gmickel/gno/src/index.ts",
    "--index",
    "default",
    "--config",
    "/absolute/path/to/index.yml",
    "mcp"
  ],
  "env": {
    "GNO_DATA_DIR": "/absolute/path/to/data",
    "GNO_CACHE_DIR": "/absolute/path/to/cache"
  }
}
```

OpenCode stores the same executable and arguments in its `command` array and
uses `environment`, not `env`. Codex stores the equivalent native TOML:

```toml
[mcp_servers.gno]
command = "/absolute/path/to/bun"
args = ["run", "/absolute/path/to/@gmickel/gno/src/index.ts", "--index", "default", "--config", "/absolute/path/to/index.yml", "mcp"]

[mcp_servers.gno.env]
GNO_DATA_DIR = "/absolute/path/to/data"
GNO_CACHE_DIR = "/absolute/path/to/cache"
```

### gno mcp uninstall

Remove gno MCP server from client configurations.

**Synopsis:**

```bash
gno mcp uninstall [options]
```

**Options:**

| Option                  | Description                          | Default          |
| ----------------------- | ------------------------------------ | ---------------- |
| `-t, --target <target>` | Target client                        | `claude-desktop` |
| `-s, --scope <scope>`   | Scope; LibreChat defaults to project | Target default   |
| `--json`                | JSON output                          | `false`          |

### gno mcp status

Show MCP server installation status across all targets.

**Synopsis:**

```bash
gno mcp status [options]
```

**Options:**

| Option                  | Description                 | Default |
| ----------------------- | --------------------------- | ------- |
| `-t, --target <target>` | Filter by target (or `all`) | `all`   |
| `-s, --scope <scope>`   | Filter by scope (or `all`)  | `all`   |
| `--json`                | JSON output                 | `false` |

**Example Output (abbreviated; unfiltered status enumerates 14 target/scope
pairs):**

```text
MCP Server Status
──────────────────────────────────────────────────

✓ Claude Desktop: configured
    Command: /path/to/bun
    Args: run /path/to/@gmickel/gno/src/index.ts --index default --config /absolute/path/to/index.yml mcp
    Config: ~/Library/Application Support/Claude/claude_desktop_config.json

✗ Claude Code: not configured
    Config: ~/.claude.json

1/14 targets configured
```

---

## See Also

- [CLI Specification](./cli.md)
- [Output Schemas](./output-schemas/)
- [MCP Protocol Specification](https://modelcontextprotocol.io/specification/)
