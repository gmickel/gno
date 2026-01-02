# GNO MCP Specification

**Version:** 1.0.0
**Last Updated:** 2026-01-02
**Protocol:** Model Context Protocol (MCP) over stdio
**Transport:** JSON-RPC 2.0

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

## Collection Name Rules

Collection names are case-insensitive on input and normalized to lowercase in responses.

## Job Management

- Single active job per MCP server process
- Completed job retention: 1 hour, max 100 entries
- Jobs are in-memory per process (lost on restart)
- Poll with `gno_job_status`; if the job is missing after restart, return `NOT_FOUND`

## Tools

### gno_search

BM25 keyword search over indexed documents.

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
      "description": "Language filter (BCP-47 code)"
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
        "snippet": "...",
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

Hybrid search combining BM25 and vector retrieval with optional expansion and reranking.

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
    "fast": {
      "type": "boolean",
      "description": "Fast mode: skip expansion and reranking (~0.7s)",
      "default": false
    },
    "thorough": {
      "type": "boolean",
      "description": "Thorough mode: enable expansion (~5-8s)",
      "default": false
    }
  },
  "required": ["query"]
}
```

**Output Schema:** `gno://schemas/search-results`

**Response structuredContent includes:**

```json
{
  "results": [...],
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
      "description": "Start at line number (1-indexed)",
      "minimum": 1
    },
    "lineCount": {
      "type": "integer",
      "description": "Number of lines to return",
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
    }
  }
}
```

**Errors:**

- Document not found: returns `isError: true`
- Invalid ref format: returns `isError: true`

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
      "description": "Array of document references",
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
      "description": "Maximum bytes per document before truncation",
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
      "description": "Document content (markdown)"
    },
    "title": {
      "type": "string",
      "description": "Optional title used for filename generation"
    },
    "path": {
      "type": "string",
      "description": "Optional relative path within the collection"
    },
    "overwrite": {
      "type": "boolean",
      "description": "Overwrite existing file if true",
      "default": false
    }
  },
  "required": ["collection", "content"]
}
```

**Notes:**

- Paths must be relative, no `..` escapes, no NUL bytes
- Sensitive subpaths are rejected (`.ssh`, `.gnupg`, `.git`, `node_modules`, etc.)
- If `path` is omitted, a `.md` filename is generated from the title or heading

**Output Schema:** `gno://schemas/mcp-capture-result@1.0`

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

### gno://{collection}/{path}

Read document content by URI.

**URI Pattern:** `gno://{collection}/{relativePath}`

**Examples:**

- `gno://work/contracts/nda.docx`
- `gno://notes/2025/01/meeting.md`

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

| Option                  | Description                                                   | Default          |
| ----------------------- | ------------------------------------------------------------- | ---------------- |
| `-t, --target <target>` | Target client: `claude-desktop`, `claude-code`, `codex`       | `claude-desktop` |
| `-s, --scope <scope>`   | Scope: `user`, `project` (project only for claude-code/codex) | `user`           |
| `-f, --force`           | Overwrite existing configuration                              | `false`          |
| `--dry-run`             | Show what would be done without changes                       | `false`          |
| `--enable-write`        | Install config with `--enable-write` args                     | `false`          |
| `--json`                | JSON output                                                   | `false`          |

**Config Locations:**

| Target           | Scope   | macOS Path                                                        |
| ---------------- | ------- | ----------------------------------------------------------------- |
| `claude-desktop` | user    | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| `claude-code`    | user    | `~/.claude.json`                                                  |
| `claude-code`    | project | `./.mcp.json`                                                     |
| `codex`          | user    | `~/.codex.json`                                                   |
| `codex`          | project | `./.codex/.mcp.json`                                              |

**Example:**

```bash
# Install for Claude Desktop (default)
gno mcp install

# Install for Claude Code (user scope)
gno mcp install -t claude-code

# Install for Claude Code (project scope)
gno mcp install -t claude-code -s project

# Preview changes
gno mcp install --dry-run

# Install with write tools enabled
gno mcp install --enable-write
```

### gno mcp uninstall

Remove gno MCP server from client configurations.

**Synopsis:**

```bash
gno mcp uninstall [options]
```

**Options:**

| Option                  | Description   | Default          |
| ----------------------- | ------------- | ---------------- |
| `-t, --target <target>` | Target client | `claude-desktop` |
| `-s, --scope <scope>`   | Scope         | `user`           |
| `--json`                | JSON output   | `false`          |

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

**Example Output:**

```text
MCP Server Status
──────────────────────────────────────────────────

✓ Claude Desktop: configured
    Command: /path/to/bun
    Args: /path/to/gno mcp
    Config: ~/Library/Application Support/Claude/claude_desktop_config.json

✗ Claude Code: not configured
    Config: ~/.claude.json

2/5 targets configured
```

---

## See Also

- [CLI Specification](./cli.md)
- [Output Schemas](./output-schemas/)
- [MCP Protocol Specification](https://modelcontextprotocol.io/specification/)
