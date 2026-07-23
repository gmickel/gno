---
title: REST API
description: HTTP API for GNO search, retrieval, documents, graph data, model state, and workspace automation from the same local knowledge engine.
keywords: gno api, local search api, retrieval api, document api, local rag api, knowledge graph api
---

# REST API

Programmatic access to the same local knowledge workspace that powers the CLI, web UI, desktop shell, and agent integrations.

```bash
gno serve
# API available at http://localhost:3000/api/*
```

---

## Overview

The GNO REST API provides programmatic access to your local knowledge index. Use it to:

- Search documents from scripts and applications
- Build custom integrations
- Automate workflows
- Create dashboards and tools

All endpoints are JSON-based and run entirely on your machine.

---

## Quick Reference

### Read Operations

| Endpoint                 | Method | Description                                                 |
| :----------------------- | :----- | :---------------------------------------------------------- |
| `/api/health`            | GET    | Health check                                                |
| `/api/status`            | GET    | Index statistics, onboarding, health, background, bootstrap |
| `/api/capabilities`      | GET    | Available features                                          |
| `/api/collections`       | GET    | List collections                                            |
| `/api/connectors`        | GET    | Detect in-app connector install state                       |
| `/api/connectors/verify` | POST   | Explicit read-only connector retrieval proof                |
| `/api/docs`              | GET    | List documents                                              |
| `/api/docs/autocomplete` | GET    | Title/path suggestions for wiki-linking and quick switcher  |
| `/api/note-presets`      | GET    | List note presets and scaffold previews                     |
| `/api/doc`               | GET    | Get document content                                        |
| `/api/doc/:id/sections`  | GET    | Get extracted heading/section structure                     |
| `/api/events`            | GET    | Server-sent document change events                          |
| `/api/doc/:id/links`     | GET    | Get outgoing links from doc                                 |
| `/api/doc/:id/backlinks` | GET    | Get docs linking to this                                    |
| `/api/doc/:id/similar`   | GET    | Find semantically similar                                   |
| `/api/graph`             | GET    | Knowledge graph of links                                    |
| `/api/graph/query`       | POST   | Bounded typed-edge graph traversal                          |
| `/api/tags`              | GET    | List tags with counts                                       |
| `/api/search`            | POST   | BM25 keyword search                                         |
| `/api/query`             | POST   | Hybrid search                                               |
| `/api/query/diagnose`    | POST   | Diagnose why a target document does or does not retrieve    |
| `/api/ask`               | POST   | AI-powered Q&A                                              |
| `/api/context`           | POST   | Compile a deterministic, budgeted evidence Capsule          |
| `/api/context/verify`    | POST   | Verify a saved Capsule against the active index             |
| `/api/presets`           | GET    | List model presets                                          |
| `/api/presets`           | POST   | Switch preset                                               |
| `/api/models/status`     | GET    | Download status                                             |
| `/api/models/pull`       | POST   | Start model download                                        |

### Write Operations

| Endpoint                      | Method | Description                            |
| :---------------------------- | :----- | :------------------------------------- |
| `/api/collections`            | POST   | Add new collection                     |
| `/api/connectors/install`     | POST   | Install connector                      |
| `/api/connectors/verify`      | POST   | Verify configured MCP retrieval        |
| `/api/collections/:name`      | DELETE | Remove collection                      |
| `/api/sync`                   | POST   | Trigger re-index                       |
| `/api/capture`                | POST   | Capture note with provenance receipt   |
| `/api/docs`                   | POST   | Create new document                    |
| `/api/docs/:id`               | PUT    | Update document                        |
| `/api/docs/:id/refactor-plan` | POST   | Preview rename/move/duplicate warnings |
| `/api/docs/:id/move`          | POST   | Move editable document                 |
| `/api/docs/:id/duplicate`     | POST   | Duplicate editable document            |
| `/api/docs/:id/deactivate`    | POST   | Unindex document                       |
| `/api/folders`                | POST   | Create folder in collection            |
| `/api/jobs/active`            | GET    | Get active job                         |
| `/api/jobs/:id`               | GET    | Poll job status                        |

---

## Authentication & Security

The API binds to `127.0.0.1` only and is not accessible from the network.

### CSRF Protection

All mutating requests (POST, DELETE) require one of:

1. **Same-origin request**: No `Origin` header (curl, scripts)
2. **Valid Origin**: `Origin: http://localhost:<port>` or `http://127.0.0.1:<port>`
3. **API Token**: `X-GNO-Token` header (for non-browser clients)

Cross-origin requests from other domains are rejected with `403 Forbidden`.

### Token Authentication

For non-browser clients (Raycast, scripts), set the `GNO_API_TOKEN` environment variable:

```bash
export GNO_API_TOKEN="your-secret-token"
gno serve
```

Then include the token in requests:

```bash
curl -X POST http://localhost:3000/api/collections \
  -H "X-GNO-Token: your-secret-token" \
  -H "Content-Type: application/json" \
  -d '{"path": "/path/to/folder"}'
```

> **Note**: Token auth is optional. Requests without an `Origin` header (like curl) work without a token.

---

## Endpoints

### Health Check

```http
GET /api/health
```

This endpoint proves only that the local HTTP process is alive. Use
`GET /api/status` and its `activation` object for retrieval readiness.

**Response**:

```json
{
  "ok": true
}
```

---

### Index Status

```http
GET /api/status
```

Returns index statistics plus first-run onboarding, health-center state, background-service telemetry, and bootstrap/runtime-model provisioning state for the dashboard.

**Response**:

```json
{
  "indexName": "default",
  "configPath": "/Users/you/.config/gno/index.yml",
  "dbPath": "/Users/you/.local/share/gno/index-default.sqlite",
  "collections": [
    {
      "name": "notes",
      "path": "/Users/you/notes",
      "documentCount": 142,
      "chunkCount": 1853,
      "embeddedCount": 1853
    }
  ],
  "totalDocuments": 142,
  "totalChunks": 1853,
  "embeddingBacklog": 0,
  "recentErrors": 0,
  "lastUpdated": "2025-01-15T10:30:00Z",
  "healthy": true,
  "activation": {
    "schemaVersion": "1.0",
    "usable": true,
    "healthy": true,
    "collections": [
      {
        "collection": "notes",
        "ready": true,
        "generatedAt": "2026-07-22T10:30:00Z",
        "stages": {
          "index": {
            "status": "passed",
            "startedAt": "2026-07-22T10:29:59Z",
            "completedAt": "2026-07-22T10:30:00Z",
            "latencyMs": 3
          },
          "lexical": {
            "status": "passed",
            "startedAt": "2026-07-22T10:30:00Z",
            "completedAt": "2026-07-22T10:30:00Z",
            "latencyMs": 2
          },
          "semantic": {
            "status": "pending",
            "startedAt": null,
            "completedAt": null,
            "latencyMs": null,
            "code": "semantic_not_checked"
          },
          "connector": {
            "status": "skipped",
            "startedAt": null,
            "completedAt": null,
            "latencyMs": null,
            "code": "connector_not_requested"
          }
        },
        "semanticAvailability": {
          "status": "pending",
          "code": "semantic_not_checked",
          "command": "gno status"
        },
        "remediation": null
      }
    ],
    "connectors": [],
    "connectorProjection": {
      "total": 0,
      "projected": 0,
      "truncated": false
    }
  },
  "activePreset": {
    "id": "slim-tuned",
    "name": "GNO Slim Tuned (Default, ~1GB)"
  },
  "capabilities": {
    "bm25": true,
    "vector": true,
    "hybrid": true,
    "answer": true
  },
  "onboarding": {
    "ready": false,
    "stage": "indexing",
    "headline": "GNO is almost ready. Finish the first indexing run",
    "detail": "Run the first sync to populate the index from the folders you connected.",
    "suggestedCollections": [
      {
        "label": "Documents",
        "path": "/Users/you/Documents",
        "reason": "Good default for notes and docs"
      }
    ],
    "steps": [
      {
        "id": "folders",
        "title": "Pick folders",
        "status": "complete",
        "detail": "1 folder connected."
      }
    ]
  },
  "health": {
    "state": "needs-attention",
    "summary": "GNO works, but a few issues still need attention before it feels reliable.",
    "checks": [
      {
        "id": "models",
        "title": "Models",
        "status": "warn",
        "summary": "Balanced is usable, but answer models are still missing",
        "detail": "Core search is ready. Download the rest of the preset for best ranking and local AI answers.",
        "actionLabel": "Download models",
        "actionKind": "download-models"
      }
    ]
  },
  "background": {
    "watcher": {
      "expectedCollections": ["notes"],
      "activeCollections": ["notes"],
      "failedCollections": [],
      "queuedCollections": [],
      "syncingCollections": [],
      "lastEventAt": "2025-01-15T10:31:00Z",
      "lastSyncAt": "2025-01-15T10:31:02Z"
    },
    "embedding": {
      "available": true,
      "pendingDocCount": 0,
      "running": false,
      "nextRunAt": null,
      "lastRunAt": 1736937062000,
      "lastResult": {
        "embedded": 12,
        "errors": 0
      }
    },
    "events": {
      "connectedClients": 2,
      "retryMs": 2000
    }
  },
  "bootstrap": {
    "runtime": {
      "kind": "bun",
      "strategy": "manual-install-beta",
      "currentVersion": "1.3.6",
      "requiredVersion": ">=1.3.0",
      "ready": true,
      "managedByApp": false,
      "summary": "This beta runs on Bun 1.3.6.",
      "detail": "Current beta installs still expect Bun to be present on the machine. Final desktop packaging work is separate."
    },
    "policy": {
      "offline": false,
      "allowDownload": true,
      "source": "default",
      "summary": "Models can auto-download on first use."
    },
    "cache": {
      "path": "/Users/you/Library/Caches/gno",
      "totalSizeBytes": 2147483648,
      "totalSizeLabel": "2.0 GB"
    },
    "models": {
      "activePresetId": "slim-tuned",
      "activePresetName": "GNO Slim Tuned (Default, ~1GB)",
      "estimatedFootprint": "~1GB",
      "downloading": false,
      "cachedCount": 4,
      "totalCount": 4,
      "summary": "GNO Slim Tuned (Default, ~1GB) is fully cached.",
      "entries": []
    }
  }
}
```

The activation object is identical to the `gno status --json`/doctor/Web model.
Lexical readiness is proven per collection; semantic availability remains
independent. Connector entries are fingerprint-current persisted receipts only.
If `connectorProjection.truncated` is true, omitted pairs have no claimed result
and health remains degraded. Status may perform a bounded local lexical proof on
a receipt miss, but it never starts connector children or remote inference.

`activePreset.name`, `bootstrap.models.estimatedFootprint`, and the footprint
text inside `bootstrap.models.summary` preserve legacy approximate labels from
the built-in preset name. They are not measurements of a clean download or the
current cache; use `bootstrap.cache.totalSizeBytes` for observed cache use.

### Verify Connector Retrieval

```http
POST /api/connectors/verify
Content-Type: application/json

{"connectorId":"cursor-mcp","collection":"notes"}
```

This is the explicit, read-only action that may start the configured local MCP
process. It requires a configured collection and returns a bounded verification
projection (`lexicalReady`, `connectorReady`, timestamp, and connector stage
only). `connectorReady` is true only when the explicit connector stage passes;
`lexicalReady` reports the prerequisite local proof separately. The proof checks
the tool list, `gno_status`, and a collection-scoped `gno_search`; it does not
edit client configuration. Skill-only targets return
`skipped/target_runtime_unverifiable` because file installation cannot prove
that the client loaded or executed the skill.

`onboarding.stage` is one of `add-collection`, `models`, `indexing`, or `ready`.

`health.checks` gives per-area status cards for folders, indexing, models,
vector runtime, and disk. When sqlite-vec cannot load, the `vector-runtime`
check preserves the loader error and recovery guidance while confirming that
BM25 remains available. Actions map to dashboard buttons such as add folder,
run sync, or download models.

`background` is the reliability block:

- `watcher` shows which collections are expected, actively watched, queued, syncing, or failed
- `embedding` reports pending/running background embedding state
- `events` reports current SSE clients and recommended reconnect retry

Concurrent requests for the same live server context share one in-flight status
build. Completed responses are not retained, so each later request still sees
fresh index and background state.

`bootstrap` is the install/runtime/model block:

- `runtime` explains the current beta runtime strategy and version
- `policy` explains whether models auto-download, stay offline, or require manual pull
- `cache` shows where models live and how much disk they use
- `models` shows active preset readiness role by role

**Example**:

```bash
curl http://localhost:3000/api/status | jq
```

---

### Capabilities

```http
GET /api/capabilities
```

Returns available features based on loaded models.

**Response**:

```json
{
  "bm25": true,
  "vector": true,
  "hybrid": true,
  "answer": true
}
```

| Field    | Description                    |
| :------- | :----------------------------- |
| `bm25`   | BM25 search (always true)      |
| `vector` | Vector search available        |
| `hybrid` | Hybrid search available        |
| `answer` | AI answer generation available |

---

### List Collections

```http
GET /api/collections
```

**Response**:

```json
[
  {
    "name": "notes",
    "path": "/Users/you/notes",
    "pattern": "**/*.md",
    "include": [],
    "exclude": [".git", "node_modules"],
    "models": {
      "embed": "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
    },
    "effectiveModels": {
      "embed": "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
      "rerank": "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf",
      "expand": "hf:guiltylemon/gno-expansion-slim-retrieval-v1/gno-expansion-auto-entity-lock-default-mix-lr95-f16.gguf",
      "gen": "hf:unsloth/Qwen3-1.7B-GGUF/Qwen3-1.7B-Q4_K_M.gguf"
    },
    "modelSources": {
      "embed": "override",
      "rerank": "preset",
      "expand": "preset",
      "gen": "preset"
    },
    "activePresetId": "slim-tuned"
  }
]
```

`effectiveModels` and `modelSources` exist so clients can show inherited-vs-overridden collection model state without re-implementing preset resolution logic.

---

### Add Collection

```http
POST /api/collections
```

Add a folder to the index as a new collection. Starts background indexing job.

**Request Body**:

```json
{
  "path": "/Users/you/notes",
  "name": "notes",
  "pattern": "**/*.md",
  "include": "docs/**",
  "exclude": "node_modules/**",
  "gitPull": false
}
```

| Field     | Type    | Required | Description                                 |
| :-------- | :------ | :------- | :------------------------------------------ |
| `path`    | string  | Yes      | Absolute path to folder                     |
| `name`    | string  | No       | Collection name (defaults to folder name)   |
| `pattern` | string  | No       | Glob pattern for files (default: `**/*.md`) |
| `include` | string  | No       | Additional include patterns                 |
| `exclude` | string  | No       | Exclude patterns                            |
| `gitPull` | boolean | No       | Run `git pull` before indexing              |

**Response** (202 Accepted):

```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "collection": {
    "name": "notes",
    "path": "/Users/you/notes"
  }
}
```

**Errors**:

| Code             | Status | Description                    |
| :--------------- | :----- | :----------------------------- |
| `VALIDATION`     | 400    | Missing or invalid path        |
| `PATH_NOT_FOUND` | 400    | Path does not exist            |
| `DUPLICATE`      | 409    | Collection name already exists |
| `CONFLICT`       | 409    | Another job is running         |

**Example**:

```bash
curl -X POST http://localhost:3000/api/collections \
  -H "Content-Type: application/json" \
  -d '{"path": "/Users/you/notes", "name": "notes"}'
```

---

### Delete Collection

```http
DELETE /api/collections/:name
```

Remove a collection from the config. Indexed documents remain in DB but won't appear in searches.

**Response**:

```json
{
  "success": true,
  "collection": "notes",
  "note": "Collection removed from config. Indexed documents remain in DB."
}
```

**Errors**:

| Code             | Status | Description                       |
| :--------------- | :----- | :-------------------------------- |
| `NOT_FOUND`      | 404    | Collection does not exist         |
| `HAS_REFERENCES` | 400    | Collection has context references |

**Example**:

```bash
curl -X DELETE http://localhost:3000/api/collections/notes
```

---

### Update Collection Model Overrides

```http
PATCH /api/collections/:name
```

Update per-collection model overrides without changing the global active preset.

**Request Body**:

```json
{
  "models": {
    "embed": "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
    "rerank": null
  }
}
```

Rules:

- omitted roles are left unchanged
- string values set/replace one override
- `null` clears one override and returns that role to preset inheritance

**Response**:

```json
{
  "success": true,
  "collection": {
    "name": "notes",
    "path": "/Users/you/notes",
    "models": {
      "embed": "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
    },
    "effectiveModels": {
      "embed": "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
      "rerank": "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf",
      "expand": "hf:guiltylemon/gno-expansion-slim-retrieval-v1/gno-expansion-auto-entity-lock-default-mix-lr95-f16.gguf",
      "gen": "hf:unsloth/Qwen3-1.7B-GGUF/Qwen3-1.7B-Q4_K_M.gguf"
    },
    "modelSources": {
      "embed": "override",
      "rerank": "preset",
      "expand": "preset",
      "gen": "preset"
    },
    "activePresetId": "slim-tuned"
  }
}
```

**Errors**:

| Code         | Status | Description                        |
| :----------- | :----- | :--------------------------------- |
| `VALIDATION` | 400    | Invalid body or invalid role value |
| `NOT_FOUND`  | 404    | Collection does not exist          |

**Example**:

```bash
curl -X PATCH http://localhost:3000/api/collections/notes \
  -H "Content-Type: application/json" \
  -d '{"models":{"embed":"hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"}}'
```

---

### Clear Collection Embeddings

```http
POST /api/collections/:name/embeddings/clear
```

Clear embeddings for one collection.

**Request Body**:

```json
{
  "mode": "stale"
}
```

Modes:

- `stale` - remove embeddings for models other than the active embed model for that collection
- `all` - remove all embeddings for that collection

**Response**:

```json
{
  "success": true,
  "stats": {
    "collection": "notes",
    "mode": "stale",
    "deletedVectors": 24,
    "deletedModels": ["hf:old/model.gguf"],
    "protectedSharedVectors": 3
  },
  "note": "Some shared vectors were retained because other active collections still use the same content."
}
```

If `mode` is `all`, the response note points users to `gno embed --collection <name>`.

---

### Sync / Re-index

```http
POST /api/sync
```

Trigger re-indexing of all collections or a specific one.

**Note**: After sync completes, embeddings are automatically generated for any new/updated chunks (debounced, runs in background).

**Request Body**:

```json
{
  "collection": "notes",
  "gitPull": false
}
```

| Field        | Type    | Required | Description                                    |
| :----------- | :------ | :------- | :--------------------------------------------- |
| `collection` | string  | No       | Specific collection to sync (case-insensitive) |
| `gitPull`    | boolean | No       | Run `git pull` before sync                     |

**Response** (202 Accepted):

```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Error** (sync already running):

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Job 550e8400-e29b-41d4-a716-446655440000 already running",
    "details": {
      "activeJobId": "550e8400-e29b-41d4-a716-446655440000"
    }
  }
}
```

**Example**:

```bash
# Sync all collections
curl -X POST http://localhost:3000/api/sync

# Sync specific collection
curl -X POST http://localhost:3000/api/sync \
  -H "Content-Type: application/json" \
  -d '{"collection": "notes"}'
```

---

### Job Status

```http
GET /api/jobs/:id
```

Poll the status of a background job (indexing, sync).

**Response** (running):

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "type": "add",
  "status": "running",
  "createdAt": 1704067200000
}
```

**Response** (completed):

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "type": "sync",
  "status": "completed",
  "createdAt": 1704067200000,
  "result": {
    "collections": [
      {
        "collection": "notes",
        "filesProcessed": 42,
        "filesAdded": 5,
        "filesUpdated": 3,
        "filesUnchanged": 34,
        "filesErrored": 0,
        "filesSkipped": 0,
        "durationMs": 1250
      }
    ],
    "totalDurationMs": 1250,
    "totalFilesProcessed": 42,
    "totalFilesAdded": 5,
    "totalFilesUpdated": 3,
    "totalFilesErrored": 0,
    "totalFilesSkipped": 0
  }
}
```

**Response** (failed):

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "type": "add",
  "status": "failed",
  "createdAt": 1704067200000,
  "error": "Permission denied: /private/folder"
}
```

| Status      | Description               |
| :---------- | :------------------------ |
| `running`   | Job in progress           |
| `completed` | Job finished successfully |
| `failed`    | Job failed with error     |

**Example**:

```bash
# Poll until complete
JOB_ID="550e8400-e29b-41d4-a716-446655440000"
while true; do
  STATUS=$(curl -s "http://localhost:3000/api/jobs/$JOB_ID" | jq -r '.status')
  echo "Status: $STATUS"
  [ "$STATUS" != "running" ] && break
  sleep 1
done
```

---

### Active Job

```http
GET /api/jobs/active
```

Return the current active background job in structured form, or `null` when the
server is idle.

**Response** (idle):

```json
{
  "activeJob": null
}
```

**Response** (running):

```json
{
  "activeJob": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "type": "sync",
    "status": "running",
    "createdAt": 1704067200000
  }
}
```

Use this when a client needs the active job id without scraping it out of a
`409 CONFLICT` message.

---

### List Tags

```http
GET /api/tags?collection=notes&prefix=project
```

List all tags with document counts.

**Query Parameters**:

| Param        | Type   | Default | Description                         |
| :----------- | :----- | :------ | :---------------------------------- |
| `collection` | string | —       | Filter by collection name           |
| `prefix`     | string | —       | Filter by tag prefix (hierarchical) |

**Response**:

```json
{
  "tags": [
    { "tag": "work", "count": 15 },
    { "tag": "project/alpha", "count": 8 },
    { "tag": "urgent", "count": 3 }
  ],
  "meta": {
    "total": 3,
    "collection": "notes",
    "prefix": "project"
  }
}
```

**Example**:

```bash
# All tags
curl http://localhost:3000/api/tags | jq

# Tags in collection
curl "http://localhost:3000/api/tags?collection=notes" | jq

# Tags with prefix
curl "http://localhost:3000/api/tags?prefix=project" | jq
```

---

### List Documents

```http
GET /api/docs?collection=notes&limit=20&offset=0&tagsAll=work&tagsAny=urgent,meeting&sortField=published_at&sortOrder=desc
```

**Query Parameters**:

| Param        | Type   | Default  | Description                          |
| :----------- | :----- | :------- | :----------------------------------- |
| `collection` | string | —        | Filter by collection name            |
| `limit`      | number | 20       | Results per page (max 100)           |
| `offset`     | number | 0        | Pagination offset                    |
| `tagsAll`    | string | —        | Comma-separated tags (must have ALL) |
| `tagsAny`    | string | —        | Comma-separated tags (must have ANY) |
| `sortField`  | string | modified | `modified` or frontmatter date key   |
| `sortOrder`  | string | desc     | `asc` or `desc`                      |

**Response**:

```json
{
  "documents": [
    {
      "docid": "abc123def456",
      "uri": "gno://notes/projects/readme.md",
      "title": "Project README",
      "collection": "notes",
      "relPath": "projects/readme.md",
      "sourceExt": ".md",
      "sourceMime": "text/markdown",
      "updatedAt": "2025-01-15T09:00:00Z"
    }
  ],
  "total": 142,
  "limit": 20,
  "offset": 0,
  "availableDateFields": ["deadline", "published_at"],
  "sortField": "published_at",
  "sortOrder": "desc"
}
```

**Example**:

```bash
curl "http://localhost:3000/api/docs?collection=notes&limit=10" | jq
```

---

### Get Document

```http
GET /api/doc?uri=gno://notes/projects/readme.md
```

**Query Parameters**:

| Param | Type   | Required | Description  |
| :---- | :----- | :------- | :----------- |
| `uri` | string | Yes      | Document URI |

**Response**:

```json
{
  "docid": "abc123def456",
  "uri": "gno://notes/projects/readme.md",
  "title": "Project README",
  "content": "# Project\n\nThis is the full document content...",
  "contentAvailable": true,
  "collection": "notes",
  "relPath": "projects/readme.md",
  "tags": ["work", "project/alpha"],
  "source": {
    "absPath": "/Users/you/notes/projects/readme.md",
    "mime": "text/markdown",
    "ext": ".md",
    "modifiedAt": "2025-01-15T09:00:00Z",
    "sizeBytes": 4523,
    "sourceHash": "7b3c..."
  },
  "capabilities": {
    "editable": true,
    "tagsEditable": true,
    "tagsWriteback": true,
    "canCreateEditableCopy": false,
    "mode": "editable"
  }
}
```

For converted source formats such as PDF or DOCX, `capabilities.editable` is `false` and `capabilities.canCreateEditableCopy` is `true`. Those documents remain viewable/searchable, but GNO will not write converted markdown back into the original binary source file.

**Example**:

```bash
curl "http://localhost:3000/api/doc?uri=gno://notes/readme.md" | jq '.content'
```

---

### Document Autocomplete

```http
GET /api/docs/autocomplete?query=auth&collection=notes&limit=8
```

Returns lightweight document suggestions for title/path-driven UIs such as wiki-link autocomplete and the quick switcher.

---

### Document Events

```http
GET /api/events
```

Server-sent event stream used by the Web UI to refresh document/search state after local edits and external file changes.

---

### Get Document Links

```http
GET /api/doc/:id/links?type=wiki
```

Get outgoing links from a document (wiki links and markdown links).

**URL Parameters**:

| Param | Description                                                          |
| :---- | :------------------------------------------------------------------- |
| `:id` | Document ID (the `#hexhash` from docid, URL-encoded as `%23hexhash`) |

**Query Parameters**:

| Param  | Type   | Default | Description                               |
| :----- | :----- | :------ | :---------------------------------------- |
| `type` | string | —       | Filter by link type: `wiki` or `markdown` |

**Response**:

```json
{
  "links": [
    {
      "targetRef": "Other Note",
      "targetRefNorm": "other note",
      "linkType": "wiki",
      "startLine": 5,
      "startCol": 1,
      "endLine": 5,
      "endCol": 17,
      "source": "parsed",
      "resolved": true,
      "resolvedDocid": "#def456",
      "resolvedUri": "gno://notes/other.md",
      "resolvedTitle": "Other Note"
    },
    {
      "targetRef": "./related.md",
      "targetRefNorm": "related.md",
      "targetAnchor": "section",
      "linkType": "markdown",
      "linkText": "see related",
      "startLine": 10,
      "startCol": 1,
      "endLine": 10,
      "endCol": 30,
      "source": "parsed"
    }
  ],
  "meta": {
    "docid": "#abc123",
    "totalLinks": 2,
    "resolvedCount": 1,
    "resolutionAvailable": true,
    "typeFilter": "wiki"
  }
}
```

| Field           | Description                                |
| :-------------- | :----------------------------------------- |
| `targetRef`     | Target path or wiki name                   |
| `linkType`      | `wiki` ([[Name]]) or `markdown` ([](path)) |
| `targetAnchor`  | Fragment/anchor without #                  |
| `linkText`      | Display text of the link                   |
| `source`        | `parsed`, `user`, or `suggested`           |
| `resolved`      | Whether target doc exists in index         |
| `resolvedDocid` | Docid of resolved target (if found)        |
| `resolvedUri`   | URI of resolved target (if found)          |
| `resolvedTitle` | Title of resolved target (if found)        |

Resolution fields are only included when `meta.resolutionAvailable` is true.

| Meta Field            | Description                           |
| :-------------------- | :------------------------------------ |
| `resolvedCount`       | Number of links resolved              |
| `resolutionAvailable` | Whether resolution completed normally |

**Example**:

```bash
# All links
curl "http://localhost:3000/api/doc/%23abc123/links" | jq

# Only wiki links
curl "http://localhost:3000/api/doc/%23abc123/links?type=wiki" | jq
```

---

### Get Document Backlinks

```http
GET /api/doc/:id/backlinks
```

Get documents that link TO this document.

**URL Parameters**:

| Param | Description                                                          |
| :---- | :------------------------------------------------------------------- |
| `:id` | Document ID (the `#hexhash` from docid, URL-encoded as `%23hexhash`) |

**Response**:

```json
{
  "backlinks": [
    {
      "sourceDocid": "#def456",
      "sourceUri": "gno://notes/source.md",
      "sourceTitle": "Source Document",
      "linkText": "see also",
      "startLine": 10,
      "startCol": 5
    }
  ],
  "meta": {
    "docid": "#abc123",
    "totalBacklinks": 1
  }
}
```

| Field         | Description                    |
| :------------ | :----------------------------- |
| `sourceDocid` | Docid of the linking document  |
| `sourceUri`   | URI of the linking document    |
| `sourceTitle` | Title of the linking document  |
| `linkText`    | Display text of the link       |
| `startLine`   | Line number where link appears |

**Example**:

```bash
curl "http://localhost:3000/api/doc/%23abc123/backlinks" | jq
```

---

### Find Similar Documents

```http
GET /api/doc/:id/similar?limit=5&threshold=0.7&crossCollection=true
```

Find semantically similar documents using vector embeddings. Uses the doc's
`seq=0` embedding (falls back to first chunk).

**URL Parameters**:

| Param | Description                                                          |
| :---- | :------------------------------------------------------------------- |
| `:id` | Document ID (the `#hexhash` from docid, URL-encoded as `%23hexhash`) |

**Query Parameters**:

| Param             | Type    | Default | Description                   |
| :---------------- | :------ | :------ | :---------------------------- |
| `limit`           | number  | 5       | Max results (1-20)            |
| `threshold`       | number  | 0.5     | Min similarity score (0-1)    |
| `crossCollection` | boolean | false   | Search across all collections |

**Response**:

```json
{
  "similar": [
    {
      "docid": "#def456",
      "uri": "gno://notes/similar.md",
      "title": "Similar Note",
      "collection": "notes",
      "score": 0.85
    },
    {
      "docid": "#ghi789",
      "uri": "gno://notes/related.md",
      "score": 0.72
    }
  ],
  "meta": {
    "docid": "#abc123",
    "totalResults": 2,
    "threshold": 0.7,
    "crossCollection": true
  }
}
```

| Field   | Description                                   |
| :------ | :-------------------------------------------- |
| `score` | Similarity score (0-1, higher = more similar) |

**Errors**:

| Code          | Status | Description                                  |
| :------------ | :----- | :------------------------------------------- |
| `NOT_FOUND`   | 404    | Document not found                           |
| `UNAVAILABLE` | 503    | Vector search not available. Run `gno embed` |

**Example**:

```bash
# Find similar docs in same collection
curl "http://localhost:3000/api/doc/%23abc123/similar?limit=10" | jq

# Find similar across all collections
curl "http://localhost:3000/api/doc/%23abc123/similar?crossCollection=true&threshold=0.6" | jq
```

---

### Get Knowledge Graph

```http
GET /api/graph
```

Returns a knowledge graph of document links (wiki links, markdown links, and optionally similarity edges).

**Query Parameters**:

| Param            | Type    | Default | Description                       |
| :--------------- | :------ | :------ | :-------------------------------- |
| `collection`     | string  | -       | Filter to single collection       |
| `limit`          | number  | 2000    | Max nodes (1-5000)                |
| `edgeLimit`      | number  | 10000   | Max edges (1-50000)               |
| `includeSimilar` | boolean | false   | Include similarity edges          |
| `threshold`      | number  | 0.7     | Similarity threshold (0-1)        |
| `linkedOnly`     | boolean | true    | Exclude isolated nodes (no links) |
| `similarTopK`    | number  | 5       | Similar docs per node (1-20)      |

> **Note**: When `collection` is specified, nodes are limited to that collection and edges are drawn only between those nodes, but node `degree` may reflect links to documents outside the filtered view.
> **Note**: Similarity edges use `seq=0` embeddings only (no fallback).

**Response**:

```json
{
  "nodes": [
    {
      "id": "#abc123",
      "uri": "gno://notes/readme.md",
      "title": "Project README",
      "collection": "notes",
      "relPath": "readme.md",
      "degree": 5,
      "communityId": "c1"
    }
  ],
  "links": [
    {
      "source": "#abc123",
      "target": "#def456",
      "type": "wiki",
      "weight": 1
    },
    {
      "source": "#abc123",
      "target": "#ghi789",
      "type": "similar",
      "weight": 0.85,
      "confidence": "similarity",
      "audit": { "resolution": "similarity", "score": 0.85 }
    }
  ],
  "report": {
    "hubs": [
      {
        "id": "#abc123",
        "uri": "gno://notes/readme.md",
        "title": "Project README",
        "collection": "notes",
        "relPath": "readme.md",
        "degree": 5
      }
    ],
    "bridgeCandidates": [],
    "isolated": { "total": 3, "examples": [] },
    "unresolvedLinks": {
      "total": 2,
      "byType": { "wiki": 2, "markdown": 0 }
    },
    "edgeTypes": { "wiki": 55, "markdown": 12, "similar": 0 },
    "edgeConfidence": {
      "explicit": 60,
      "inferred": 6,
      "ambiguous": 1,
      "similarity": 0
    },
    "audit": { "inferredEdges": 6, "ambiguousEdges": 1, "similarityEdges": 0 },
    "communities": {
      "total": 2,
      "algorithm": "deterministic-label-propagation",
      "skipped": false,
      "assignments": { "#abc123": "c1" },
      "top": [
        {
          "id": "c1",
          "label": "Project README",
          "size": 12,
          "edgeCount": 18,
          "density": 0.27,
          "topNodes": []
        }
      ]
    }
  },
  "meta": {
    "collection": null,
    "nodeLimit": 2000,
    "edgeLimit": 10000,
    "totalNodes": 42,
    "totalEdges": 67,
    "totalEdgesUnresolved": 0,
    "returnedNodes": 42,
    "returnedEdges": 67,
    "truncated": false,
    "linkedOnly": true,
    "includedSimilar": false,
    "similarAvailable": true,
    "similarTopK": 5,
    "similarTruncatedByComputeBudget": false,
    "warnings": []
  }
}
```

| Field                     | Description                                                                            |
| :------------------------ | :------------------------------------------------------------------------------------- |
| `nodes[].id`              | Document ID (hash)                                                                     |
| `nodes[].uri`             | Virtual URI                                                                            |
| `nodes[].title`           | Document title                                                                         |
| `nodes[].collection`      | Source collection                                                                      |
| `nodes[].relPath`         | Relative path in collection                                                            |
| `nodes[].degree`          | Number of connections (in + out)                                                       |
| `nodes[].communityId`     | Optional deterministic community id                                                    |
| `links[].source`          | Source node ID                                                                         |
| `links[].target`          | Target node ID                                                                         |
| `links[].type`            | Link type: `wiki`, `markdown`, or `similar`                                            |
| `links[].weight`          | Edge weight (count for links, score for similar)                                       |
| `links[].confidence`      | `explicit`, `inferred`, `ambiguous`, or `similarity`                                   |
| `links[].audit`           | Resolution metadata such as exact title/path, fallback, ambiguity, or similarity score |
| `report.communities`      | Deterministic cluster summary; skipped with warning for very large returned graphs     |
| `report.hubs`             | Highest-degree documents                                                               |
| `report.bridgeCandidates` | Documents with both incoming and outgoing links                                        |
| `report.isolated`         | Count and examples of documents with no links                                          |
| `report.unresolvedLinks`  | Count of links whose target could not resolve                                          |
| `report.edgeTypes`        | Edge counts by `wiki`, `markdown`, and `similar`                                       |
| `report.edgeConfidence`   | Edge counts by confidence class                                                        |
| `report.audit`            | Rollups for inferred, ambiguous, and similarity edges                                  |
| `meta.truncated`          | True if results hit limit                                                              |
| `meta.similarAvailable`   | True if similarity edges can be computed                                               |

**Example**:

```bash
# Get graph for notes collection
curl "http://localhost:3000/api/graph?collection=notes" | jq

# Include similarity edges with 0.8 threshold
curl "http://localhost:3000/api/graph?includeSimilar=true&threshold=0.8" | jq

# Get all nodes including isolated ones
curl "http://localhost:3000/api/graph?linkedOnly=false&limit=500" | jq
```

---

### Query Typed Graph

```http
POST /api/graph/query
```

Bounded traversal over the typed `doc_edges` relationship layer from a resolved root document.

**Request Body**:

```json
{
  "doc": "gno://notes/people/alice.md",
  "direction": "both",
  "edgeType": "mentions",
  "maxDepth": 2,
  "maxNodes": 100,
  "frontierLimit": 100,
  "visitedLimit": 500
}
```

| Field           | Type   | Default | Description                                      |
| :-------------- | :----- | :------ | :----------------------------------------------- |
| `doc` / `root`  | string | —       | Root document ref (required)                     |
| `direction`     | string | `both`  | `out`, `in`, or `both`                           |
| `edgeType`      | string | —       | Semantic edge type filter                        |
| `relation`      | string | —       | Alias for `edgeType`; must match if both are set |
| `maxDepth`      | number | 2       | Traversal depth (1-6)                            |
| `depth`         | number | —       | Alias for `maxDepth`                             |
| `maxNodes`      | number | 100     | Returned node cap (1-1000)                       |
| `frontierLimit` | number | 100     | Per-depth frontier cap (1-1000)                  |
| `visitedLimit`  | number | 500     | SQL traversal visited-row cap (1-5000)           |

**Response**: `graph-query.schema.json`.

Top-level fields:

- `schemaVersion` - Graph query schema version
- `root` - Resolved root document node
- `nodes` - Returned graph nodes with depth and graph hints
- `edges` - Typed relationship edges with depth, confidence, and source
- `meta` - Direction, caps, returned counts, truncation flag, and warnings

**Example**:

```bash
curl -X POST http://localhost:3000/api/graph/query \
  -H "Content-Type: application/json" \
  -d '{"doc":"gno://notes/people/alice.md","direction":"both","edgeType":"mentions","maxDepth":2}' | jq
```

---

### Capture Note

```http
POST /api/capture
```

Capture a note into an editable collection with structured provenance. This is
the API equivalent of `gno capture`; use `/api/docs` for lower-level raw note
creation without capture semantics.

**Request Body**:

```json
{
  "collection": "notes",
  "content": "thought to remember",
  "presetId": "person",
  "source": {
    "kind": "web",
    "url": "https://example.com"
  },
  "tags": ["inbox", "research"]
}
```

Path defaults match the CLI: without `relPath`, `folderPath`, or `title`, GNO
writes to `inbox/YYYY-MM-DD/capture-<body-hash>.md` using UTC capture time.
`presetId` accepts `blank`, `project-note`, `research-note`, `decision-note`,
`prompt-pattern`, `source-summary`, `idea-original`, `person`,
`company-project`, or `meeting`; content is optional when the preset scaffolds
a note.
`collisionPolicy` accepts `error`, `open_existing`, or `create_with_suffix`;
`/api/capture` does not accept legacy `overwrite`. Collision checks include
indexed documents and disk-only files. Capture content must be text, and capture
writes use exclusive create semantics so a late-arriving file fails instead of
being replaced.

**Response** (202 Accepted):

The response is the shared capture receipt. `sync.status` is usually `pending`
with a `jobId` because the REST API syncs asynchronously; poll
`/api/jobs/:id` for completion. `embed.status` is `not_requested` unless a
separate embed job completes.

```json
{
  "uri": "gno://notes/inbox/2026-06-04/capture-abc123.md",
  "collection": "notes",
  "relPath": "inbox/2026-06-04/capture-abc123.md",
  "created": true,
  "openedExisting": false,
  "createdWithSuffix": false,
  "contentHash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "source": {
    "kind": "web",
    "url": "https://example.com",
    "capturedAt": "2026-06-04T12:34:56.000Z"
  },
  "tags": ["inbox", "research"],
  "sync": { "status": "pending", "jobId": "..." },
  "embed": { "status": "not_requested" },
  "collisionPolicyResult": "created"
}
```

---

### Create Document

```http
POST /api/docs
```

Create a new document file in a collection. Triggers background sync to index it.

**Request Body**:

```json
{
  "collection": "notes",
  "relPath": "ideas/new-feature.md",
  "content": "# New Feature\n\nDescription of the feature...",
  "overwrite": false
}
```

| Field        | Type    | Required | Description                          |
| :----------- | :------ | :------- | :----------------------------------- |
| `collection` | string  | Yes      | Target collection name               |
| `relPath`    | string  | Yes      | Relative path within collection      |
| `content`    | string  | Yes      | File content (markdown)              |
| `overwrite`  | boolean | No       | Overwrite if exists (default: false) |

**Response** (202 Accepted):

```json
{
  "uri": "file:///Users/you/notes/ideas/new-feature.md",
  "path": "/Users/you/notes/ideas/new-feature.md",
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "note": "File created. Sync job started - poll /api/jobs/:id for status."
}
```

**Errors**:

| Code         | Status | Description                             |
| :----------- | :----- | :-------------------------------------- |
| `VALIDATION` | 400    | Missing collection, relPath, or content |
| `NOT_FOUND`  | 404    | Collection does not exist               |
| `CONFLICT`   | 409    | File exists and overwrite=false         |

**Path Validation**:

- `relPath` must be relative (no leading `/`)
- Path traversal (`..`) is rejected
- Null bytes are rejected

**Example**:

```bash
curl -X POST http://localhost:3000/api/docs \
  -H "Content-Type: application/json" \
  -d '{
    "collection": "notes",
    "relPath": "journal/2025-01-01.md",
    "content": "# January 1st\n\nNew year, new notes!"
  }'
```

---

### Update Document

```http
PUT /api/docs/:id
```

Update an existing document's content. Triggers background sync to re-index.

**URL Parameters**:

| Param | Description                                                          |
| :---- | :------------------------------------------------------------------- |
| `:id` | Document ID (the `#hexhash` from docid, URL-encoded as `%23hexhash`) |

**Request Body**:

```json
{
  "content": "# Updated Content\n\nNew document content...",
  "tags": ["work", "project/alpha", "urgent"]
}
```

| Field     | Type     | Required | Description                                      |
| :-------- | :------- | :------- | :----------------------------------------------- |
| `content` | string   | No\*     | New file content                                 |
| `tags`    | string[] | No\*     | Tags to set (replaces frontmatter tags on write) |

\*At least one of `content` or `tags` must be provided.

When `tags` is provided, the tags are written to the document's YAML frontmatter. If the document has no frontmatter, one is added. If it already has a `tags:` field, it is replaced.

**Response**:

```json
{
  "success": true,
  "docId": "#abc123",
  "uri": "file:///Users/you/notes/projects/readme.md",
  "path": "/Users/you/notes/projects/readme.md",
  "jobId": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Errors**:

| Code             | Status | Description                             |
| :--------------- | :----- | :-------------------------------------- |
| `VALIDATION`     | 400    | Missing or invalid content              |
| `READ_ONLY`      | 409    | Source format cannot be edited in place |
| `NOT_FOUND`      | 404    | Document not found in index             |
| `FILE_NOT_FOUND` | 404    | Source file no longer exists            |
| `CONFLICT`       | 409    | Sync job already running                |
| `RUNTIME`        | 500    | Failed to write file                    |

**Example**:

```bash
# Note: # must be URL-encoded as %23
curl -X PUT "http://localhost:3000/api/docs/%23abc123" \
  -H "Content-Type: application/json" \
  -d '{"content": "# Updated\n\nNew content here."}'
```

For read-only converted documents, create a markdown note instead:

```http
POST /api/docs/:id/editable-copy
```

This creates a new markdown document using the converted content plus source provenance frontmatter. The original PDF/DOCX/etc. is left untouched.

---

### Deactivate Document

```http
POST /api/docs/:id/deactivate
```

Remove a document from the index. The file remains on disk.

**URL Parameters**:

| Param | Description                                                          |
| :---- | :------------------------------------------------------------------- |
| `:id` | Document ID (the `#hexhash` from docid, URL-encoded as `%23hexhash`) |

**Response**:

```json
{
  "success": true,
  "docId": "#abc123",
  "path": "gno://notes/old-file.md",
  "warning": "File still exists on disk. Will be re-indexed unless excluded."
}
```

**Errors**:

| Code        | Status | Description        |
| :---------- | :----- | :----------------- |
| `NOT_FOUND` | 404    | Document not found |

**Example**:

```bash
# Note: # must be URL-encoded as %23
curl -X POST "http://localhost:3000/api/docs/%23abc123/deactivate"
```

> **Note**: The document will be re-indexed on next sync unless you add it to the collection's exclude pattern.

---

### BM25 Search

```http
POST /api/search
```

Keyword search using BM25 algorithm.

**Request Body**:

```json
{
  "query": "authentication",
  "limit": 10,
  "minScore": 0.1,
  "collection": "notes",
  "intent": "web authentication and session security",
  "exclude": "hiring,reviews",
  "since": "last month",
  "until": "today",
  "category": "meeting,notes",
  "author": "gordon",
  "tagsAll": "work,project",
  "tagsAny": "urgent,high"
}
```

| Field        | Type   | Default | Description                                                                                         |
| :----------- | :----- | :------ | :-------------------------------------------------------------------------------------------------- |
| `query`      | string | —       | Search query (required)                                                                             |
| `limit`      | number | 10      | Max results (max 50)                                                                                |
| `minScore`   | number | —       | Minimum score threshold (0-1)                                                                       |
| `collection` | string | —       | Filter by collection                                                                                |
| `intent`     | string | —       | Disambiguating context for ambiguous queries; steers snippet choice without being searched directly |
| `exclude`    | string | —       | Comma-separated exclusion terms; matching docs are hard-pruned by title/path/body                   |
| `since`      | string | —       | Modified-at lower bound (ISO date/time or token)                                                    |
| `until`      | string | —       | Modified-at upper bound (ISO date/time or token)                                                    |
| `category`   | string | —       | Comma-separated category/content-type filters (ANY match)                                           |
| `author`     | string | —       | Author contains value (case-insensitive)                                                            |
| `tagsAll`    | string | —       | Comma-separated tags (must have ALL)                                                                |
| `tagsAny`    | string | —       | Comma-separated tags (must have ANY)                                                                |

If query text includes recency intent (`latest`, `newest`, `recent`), results are ordered newest-first by canonical frontmatter date when present, otherwise by source modified time.

Structured search results may include `context`, resolved from matching global,
collection, and path-prefix configuration. It is trusted user guidance for the
same `uri`/`docid`, not retrieved evidence or a ranking signal. The optional
field is omitted when no configured scope matches.

**Response**:

```json
{
  "query": "authentication",
  "mode": "bm25",
  "results": [
    {
      "docid": "abc123",
      "uri": "gno://notes/auth.md",
      "line": 42,
      "context": "Company knowledge base\n\nReviewed security documentation",
      "title": "Authentication Guide",
      "collection": "notes",
      "contentType": "meeting",
      "categories": ["meeting", "notes"],
      "tags": ["backend", "auth"],
      "score": 0.87,
      "chunk": {
        "text": "...relevant text snippet...",
        "index": 2
      }
    }
  ],
  "meta": {
    "totalResults": 5
  }
}
```

**Example**:

```bash
curl -X POST http://localhost:3000/api/search \
  -H "Content-Type: application/json" \
  -d '{"query": "handleAuth", "limit": 5}'
```

---

### Context Capsule

```http
POST /api/context
```

Compiles exact indexed evidence for one goal into a deterministic Context
Capsule. The server supplies its active canonical index; the request cannot
switch indexes. The budget covers the complete canonical payload, including
evidence, retrieval plan, provenance, gaps, fallbacks, and bounded omission
details. The endpoint does not persist the Capsule.

```json
{
  "goal": "Compare the launch proposals",
  "query": "launch proposal owner risks",
  "collections": ["work"],
  "queryModes": [{ "mode": "term", "text": "launch owner" }],
  "author": "Mina",
  "lang": "en",
  "graph": false,
  "limit": 8,
  "candidateLimit": 32,
  "budgetTokens": 12000,
  "budgetBytes": 48000,
  "depthPolicy": "balanced",
  "format": "json"
}
```

Additional filters are `uriPrefix`, `tagsAll`, `tagsAny`, `categories`,
`since`, and `until`; optional safety margins are `safetyMarginTokens` and
`safetyMarginBytes`. `depthPolicy: "fast"` avoids model setup. Closed input
validation rejects unknown fields. Unknown collections fail before retrieval or
model setup. Tag filters are NFC-normalized, lowercased, deduplicated, and
validated. `limit` caps the merged result pool across all collections;
`candidateLimit` is distributed across collection retrievals so rerank and
graph work remains one global budget.

JSON responses are the canonical Capsule bytes. `format: "md"` returns the
shared readable Markdown projection (`text/markdown`) with exact passage bytes
inside collision-resistant Markdown fences and the complete canonical
manifest. Fence width and character are derived from each untrusted block, so
source text cannot forge a closing boundary. Indexed title, heading, and
configured-context values remain escaped untrusted data in separate fenced
blocks.

Errors use `{ "error": { "code": "...", "message": "..." } }` and preserve
the public Context runtime, Capsule, evidence, and verifier code taxonomy.
Messages come from a fixed public catalog; internal error text, paths, causes,
and stack traces are never returned.
Input/filter/budget/identity errors return `400`; no evidence returns `404`;
source, index, context, mutation, or stored-provenance conflicts return `409`;
an unavailable tokenizer returns `503`; retrieval, load, snapshot, and unknown
runtime failures return `500`.

### Verify Context Capsule

```http
POST /api/context/verify
```

```json
{
  "capsule": { "schemaVersion": "1.0", "...": "complete capsule" },
  "format": "json"
}
```

Verification is read-only and does not rebuild the Capsule. It reports each
evidence item as unchanged, stale, or missing, retains current hashes when
available, separates fingerprint drift from ranking state, and reports ranking
as unchanged, reranked, or unavailable. Index mismatch and malformed or
non-canonical Capsules fail before evidence-store reads. Markdown uses the same
trust boundaries and includes the complete canonical receipt.

---

### Hybrid Search

```http
POST /api/query
```

Combined BM25 + vector search with optional reranking. **Recommended for best results.**

**Request Body**:

```json
{
  "query": "how to handle authentication errors",
  "limit": 20,
  "minScore": 0.1,
  "collection": "notes",
  "lang": "en",
  "intent": "web authentication and request latency",
  "candidateLimit": 12,
  "exclude": "hiring,reviews",
  "since": "2025-01-01",
  "until": "today",
  "category": "backend,meeting",
  "author": "gordon",
  "queryModes": [
    { "mode": "term", "text": "\"refresh token\" -oauth1" },
    { "mode": "intent", "text": "how token rotation is implemented" },
    {
      "mode": "hyde",
      "text": "Refresh tokens are rotated on every use and prior tokens are invalidated."
    }
  ],
  "noExpand": false,
  "noRerank": false,
  "graph": false,
  "tagsAll": "backend",
  "tagsAny": "auth,security"
}
```

| Field            | Type    | Default | Description                                                                                                                      |
| :--------------- | :------ | :------ | :------------------------------------------------------------------------------------------------------------------------------- |
| `query`          | string  | —       | Search query (required)                                                                                                          |
| `limit`          | number  | 20      | Max results (max 50)                                                                                                             |
| `minScore`       | number  | —       | Minimum score threshold (0-1)                                                                                                    |
| `collection`     | string  | —       | Filter by collection                                                                                                             |
| `lang`           | string  | auto    | Query language hint                                                                                                              |
| `intent`         | string  | —       | Disambiguating context for ambiguous queries; steers expansion, reranking, and snippet selection without being searched directly |
| `candidateLimit` | number  | 20      | Max candidates sent to reranking (max 100)                                                                                       |
| `exclude`        | string  | —       | Comma-separated exclusion terms; matching docs are hard-pruned by title/path/body                                                |
| `since`          | string  | —       | Modified-at lower bound (ISO date/time or token)                                                                                 |
| `until`          | string  | —       | Modified-at upper bound (ISO date/time or token)                                                                                 |
| `category`       | string  | —       | Comma-separated category/content-type filters (ANY match)                                                                        |
| `author`         | string  | —       | Author contains value (case-insensitive)                                                                                         |
| `queryModes`     | array   | —       | Optional structured mode entries (`term`, `intent`, `hyde`)                                                                      |
| `noExpand`       | boolean | false   | Disable query expansion                                                                                                          |
| `noRerank`       | boolean | false   | Disable cross-encoder reranking                                                                                                  |
| `graph`          | boolean | false   | Enable bounded one-hop graph neighbor expansion                                                                                  |
| `noGraph`        | boolean | false   | Compatibility no-op unless `graph` is also true                                                                                  |
| `tagsAll`        | string  | —       | Comma-separated tags (must have ALL)                                                                                             |
| `tagsAny`        | string  | —       | Comma-separated tags (must have ANY)                                                                                             |

**Compatibility notes:**

- Existing `/api/query` payloads remain valid.
- `intent` is orthogonal to `queryModes`: intent steers scoring/prompting, while query modes inject caller-provided retrieval expansions.
- `queryModes` is optional and only needed for explicit retrieval intent control.
- If `queryModes` is provided, generated expansion is skipped and provided entries are used directly.
- By default, `/api/query` does not expand through the document graph. Set `graph` to `true` to add capped one-hop graph neighbors after initial retrieval. Explicit links are weighted above inferred, ambiguous, and similarity edges.
- `query` can also be a multi-line structured query document using `term:`, `intent:`, and `hyde:` lines. See [Structured Query Syntax](./SYNTAX.md).

**Response**:

```json
{
  "query": "how to handle authentication errors",
  "mode": "hybrid",
  "queryLanguage": "en",
  "results": [
    {
      "docid": "abc123",
      "uri": "gno://notes/auth.md",
      "context": "Company knowledge base\n\nReviewed security documentation",
      "title": "Authentication Guide",
      "collection": "notes",
      "contentType": "meeting",
      "categories": ["meeting", "notes"],
      "tags": ["backend", "auth"],
      "score": 0.92,
      "chunk": {
        "text": "...relevant text snippet...",
        "index": 2
      }
    }
  ],
  "meta": {
    "expanded": true,
    "reranked": true,
    "vectorsUsed": true,
    "totalResults": 12
  }
}
```

JSON search/query results include `contentType` when a configured content type
or built-in heuristic is available, plus the full `categories` array used by
category filters. Plain text, CSV, Markdown, and XML formatters keep their
existing shapes. They also preserve optional configured `context` guidance and
the exact source `uri`/`docid`; grounded Ask delimits that trusted guidance from
untrusted retrieved document content.

**Example**:

```bash
curl -X POST http://localhost:3000/api/query \
  -H "Content-Type: application/json" \
  -d '{"query": "error handling best practices", "limit": 10}'

curl -X POST http://localhost:3000/api/query \
  -H "Content-Type: application/json" \
  -d '{"query": "auth flow\nterm: \"refresh token\"\nintent: token rotation"}'
```

---

### Diagnose Query Target

```http
POST /api/query/diagnose
```

Explains why a named target document does or does not appear in a query result. Uses the same filters and retrieval controls as `/api/query`, plus a required `target` document ref.

**Request Body**:

```json
{
  "query": "Alice Acme",
  "target": "gno://notes/people/alice.md",
  "limit": 20,
  "collection": "notes",
  "category": "person",
  "tagsAll": "crm",
  "noExpand": true,
  "noRerank": true,
  "graph": false
}
```

**Response**: `query-diagnose.schema.json`.

Top-level fields:

- `schemaVersion` - Query diagnose schema version
- `query` - Normalized query text
- `target` - Resolved target metadata, status, filters, and graph hints
- `stages` - BM25/vector/fusion/graph/rerank survival, rank, score, and drop reason
- `chunk` - Target chunk and line range when diagnosed
- `meta` - Retrieval mode, vector/rerank usage, and result count

The response includes `target.status` (`not_found`, `inactive`, `no_indexed_content`, `filtered_out`, or `diagnosed`) plus per-stage retrieval status for BM25, vector, fusion, graph expansion, and rerank.

**Example**:

```bash
curl -X POST http://localhost:3000/api/query/diagnose \
  -H "Content-Type: application/json" \
  -d '{"query":"Alice Acme","target":"gno://notes/people/alice.md","noExpand":true,"noRerank":true}' | jq
```

---

### AI Answer

```http
POST /api/ask
```

Get an AI-generated answer with citations from your documents.

**Request Body**:

```json
{
  "query": "What is our authentication strategy?",
  "limit": 5,
  "collection": "notes",
  "lang": "en",
  "intent": "web authentication and request latency",
  "candidateLimit": 12,
  "exclude": "hiring,reviews",
  "queryModes": [
    { "mode": "term", "text": "\"refresh token\" -oauth1" },
    { "mode": "intent", "text": "how token rotation is implemented" }
  ],
  "since": "last month",
  "until": "today",
  "category": "backend,notes",
  "author": "gordon",
  "maxAnswerTokens": 512,
  "noExpand": false,
  "noRerank": false,
  "tagsAll": "backend",
  "tagsAny": "auth,security"
}
```

| Field             | Type    | Default | Description                                                                       |
| :---------------- | :------ | :------ | :-------------------------------------------------------------------------------- |
| `query`           | string  | —       | Question (required)                                                               |
| `limit`           | number  | 5       | Number of sources to consider (max 20)                                            |
| `collection`      | string  | —       | Filter by collection                                                              |
| `lang`            | string  | auto    | Query language hint                                                               |
| `intent`          | string  | —       | Disambiguating context for ambiguous questions without searching on that text     |
| `candidateLimit`  | number  | 20      | Max candidates sent to reranking (max 100)                                        |
| `exclude`         | string  | —       | Comma-separated exclusion terms; matching docs are hard-pruned by title/path/body |
| `queryModes`      | array   | —       | Optional structured mode entries (`term`, `intent`, `hyde`)                       |
| `since`           | string  | —       | Modified-at lower bound (ISO date/time or token)                                  |
| `until`           | string  | —       | Modified-at upper bound (ISO date/time or token)                                  |
| `category`        | string  | —       | Comma-separated category/content-type filters (ANY match)                         |
| `author`          | string  | —       | Author contains value (case-insensitive)                                          |
| `maxAnswerTokens` | number  | 512     | Max tokens in answer                                                              |
| `noExpand`        | boolean | false   | Disable query expansion                                                           |
| `noRerank`        | boolean | false   | Disable cross-encoder reranking                                                   |
| `tagsAll`         | string  | —       | Comma-separated tags (must have ALL)                                              |
| `tagsAny`         | string  | —       | Comma-separated tags (must have ANY)                                              |

**Compatibility notes:**

- Existing `/api/ask` payloads remain valid.
- `queryModes` is optional and only needed for explicit retrieval steering during Q&A.
- If `queryModes` is provided, generated expansion is skipped and provided entries are used directly.
- `query` can also be a multi-line structured query document using `term:`, `intent:`, and `hyde:` lines. See [Structured Query Syntax](./SYNTAX.md).

**Response**:

```json
{
  "query": "What is our authentication strategy?",
  "mode": "hybrid",
  "queryLanguage": "en",
  "answer": "Based on your documents, the authentication strategy uses JWT tokens with refresh rotation. Key points:\n\n1. Access tokens expire in 15 minutes [1]\n2. Refresh tokens are rotated on each use [2]\n3. Sessions are stored in Redis [1]",
  "citations": [
    { "docid": "#abc123", "uri": "gno://notes/auth.md" },
    { "docid": "#def456", "uri": "gno://notes/security.md" }
  ],
  "results": [...],
  "meta": {
    "expanded": true,
    "reranked": true,
    "vectorsUsed": true,
    "answerGenerated": true,
    "totalResults": 5,
    "answerContext": {
      "strategy": "adaptive_coverage_v1",
      "targetSources": 4,
      "facets": ["authentication strategy", "session storage"],
      "selected": [
        {
          "docid": "#abc123",
          "uri": "gno://notes/auth.md",
          "score": 0.94,
          "queryTokenHits": 4,
          "facetHits": 2,
          "reason": "new_facet_coverage"
        }
      ],
      "dropped": []
    }
  }
}
```

**Example**:

```bash
curl -X POST http://localhost:3000/api/ask \
  -H "Content-Type: application/json" \
  -d '{"query": "What did we decide about caching?"}'
```

> **Note**: Returns `503` if generation model not loaded. Run `gno models pull` to download.

---

### List Presets

```http
GET /api/presets
```

**Response**:

```json
{
  "presets": [
    {
      "id": "slim-tuned",
      "name": "GNO Slim Tuned (Default, ~1GB)",
      "embed": "hf:...Qwen3-Embedding-0.6B-Q8_0...",
      "rerank": "hf:...reranker-Q4...",
      "expand": "hf:...gno-expansion-auto-entity-lock-default-mix...",
      "gen": "hf:...qwen3-4b-Q4...",
      "active": true
    },
    {
      "id": "slim",
      "name": "Slim (~1GB)",
      "active": false
    },
    {
      "id": "balanced",
      "name": "Balanced (~2GB)",
      "active": false
    }
  ],
  "activePreset": "slim-tuned"
}
```

---

### Switch Preset

```http
POST /api/presets
```

Switch to a different model preset. Reloads models automatically.

The `name` strings shown above contain legacy approximate size labels. Treat
them as display labels, not authoritative download or cache measurements.

**Request Body**:

```json
{
  "presetId": "quality"
}
```

**Response**:

```json
{
  "success": true,
  "activePreset": "quality",
  "embedModelChanged": true,
  "note": "Embedding model changed. Existing collections may need gno embed so vector results catch up.",
  "capabilities": {
    "bm25": true,
    "vector": true,
    "hybrid": true,
    "answer": true
  }
}
```

If `embedModelChanged` is `true`, old vectors are kept but no longer count toward
the active embedding model's backlog/readiness. Run `gno embed` (or re-index in
the Web UI) so vector and hybrid search catch up.

**Example**:

```bash
curl -X POST http://localhost:3000/api/presets \
  -H "Content-Type: application/json" \
  -d '{"presetId": "quality"}'
```

---

### Model Download Status

```http
GET /api/models/status
```

Check the status of model downloads.

**Response**:

```json
{
  "active": true,
  "currentType": "embed",
  "progress": {
    "downloadedBytes": 104857600,
    "totalBytes": 524288000,
    "percent": 20
  },
  "completed": [],
  "failed": [],
  "startedAt": 1706000000000
}
```

| Field         | Description                                |
| :------------ | :----------------------------------------- |
| `active`      | Whether download is in progress            |
| `currentType` | Current model: `embed`, `gen`, or `rerank` |
| `progress`    | Download progress for current model        |
| `completed`   | Successfully downloaded model types        |
| `failed`      | Failed downloads with error messages       |

---

### Start Model Download

```http
POST /api/models/pull
```

Start downloading models for the active preset. Returns immediately and downloads in background. Poll `/api/models/status` for progress.

**Response**:

```json
{
  "started": true,
  "message": "Download started. Poll /api/models/status for progress."
}
```

**Error** (download already in progress):

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Download already in progress"
  }
}
```

**Example**:

```bash
# Start download
curl -X POST http://localhost:3000/api/models/pull

# Poll status until complete
while true; do
  curl -s http://localhost:3000/api/models/status | jq
  sleep 2
done
```

---

## Error Responses

All errors follow a consistent format:

```json
{
  "error": {
    "code": "VALIDATION",
    "message": "Missing or invalid query"
  }
}
```

| Code             | HTTP Status | Description                                              |
| :--------------- | :---------- | :------------------------------------------------------- |
| `VALIDATION`     | 400         | Invalid request parameters                               |
| `PATH_NOT_FOUND` | 400         | Specified path does not exist                            |
| `HAS_REFERENCES` | 400         | Resource has dependencies (e.g., collection in contexts) |
| `CSRF_VIOLATION` | 403         | Cross-origin request rejected                            |
| `NOT_FOUND`      | 404         | Resource not found                                       |
| `DUPLICATE`      | 409         | Resource already exists                                  |
| `CONFLICT`       | 409         | Operation already in progress                            |
| `UNAVAILABLE`    | 503         | Feature not available (model not loaded)                 |
| `RUNTIME`        | 500         | Internal error                                           |

---

## Usage Examples

### Search from a Script

```bash
#!/bin/bash
# search.sh - Search GNO from command line

QUERY="$1"
curl -s -X POST http://localhost:3000/api/query \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"$QUERY\", \"limit\": 5}" \
  | jq -r '.results[] | "\(.score | tostring | .[0:4]) \(.title)"'
```

### Python Integration

```python
import requests

def search_gno(query: str, limit: int = 10) -> list:
    """Search GNO index."""
    resp = requests.post(
        "http://localhost:3000/api/query",
        json={"query": query, "limit": limit}
    )
    resp.raise_for_status()
    return resp.json()["results"]

def ask_gno(question: str) -> str:
    """Get AI answer from GNO."""
    resp = requests.post(
        "http://localhost:3000/api/ask",
        json={"query": question}
    )
    resp.raise_for_status()
    return resp.json().get("answer", "No answer generated")

# Usage
results = search_gno("authentication patterns")
answer = ask_gno("What is our deployment process?")
```

### JavaScript/TypeScript

```typescript
async function searchGno(query: string): Promise<SearchResult[]> {
  const resp = await fetch("http://localhost:3000/api/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit: 10 }),
  });
  const data = await resp.json();
  return data.results;
}

async function askGno(question: string): Promise<string> {
  const resp = await fetch("http://localhost:3000/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: question }),
  });
  const data = await resp.json();
  return data.answer ?? "No answer generated";
}
```

### Raycast Script Command

```bash
#!/bin/bash
# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Search Notes
# @raycast.mode fullOutput
# @raycast.argument1 { "type": "text", "placeholder": "Query" }

curl -s -X POST http://localhost:3000/api/query \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"$1\", \"limit\": 5}" \
  | jq -r '.results[] | "• \(.title)\n  \(.chunk.text | .[0:100])...\n"'
```

---

## Rate Limits

None. The API runs locally with no rate limiting. Performance depends on your hardware and model configuration.

---

## See Also

- [Web UI Guide](./WEB-UI.md): Visual interface documentation
- [CLI Reference](./CLI.md): Command-line interface
- [MCP Integration](./MCP.md): AI assistant integration
