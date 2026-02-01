# EPIC 13: Raycast extension (macOS GUI layer)

**Migrated from:** gno-ub9
**Original type:** epic
**Priority:** P1

---

## Summary

A native macOS Raycast extension providing GUI access to GNO's core capabilities: search, semantic query, ask, quick capture, and **Finder integration for indexing folders**.

## ⚠️ CRITICAL: Review Web UI Epic First

**Before implementing ANY task in this epic, review gno-7tp (Web UI epic) for:**

- API contracts (error envelopes, field semantics)
- Error codes and handling patterns
- Path traversal protection patterns
- Document identity rules (encodeURIComponent)
- Stale detection (indexStale: boolean | null)
- Editability allowlist
- Atomic write patterns

See comments on this epic for extracted patterns, but **always check gno-7tp for the definitive source**.

## ⚠️ IMPORTANT: Frontend Design Plugin

**ALL UI work in this epic MUST use the frontend-design plugin** for any custom React components.

## Why Raycast

1. **Same tech stack** - React + TypeScript + Node
2. **Keyboard-first** - matches CLI power-user mindset
3. **Native performance** - instant access via hotkey
4. **Finder integration** - `getSelectedFinderItems()` for folder actions
5. **Rich UI primitives** - List, Detail, Form, Grid, Actions

## Integration Strategy: API-First

**Prefer REST API for all commands when server is running.** Fewer failure modes, consistent transport, model stays warm. CLI fallback only for graceful degradation when server unavailable.

| Feature         | Backend  | Why                                  |
| --------------- | -------- | ------------------------------------ |
| Search (BM25)   | REST API | Consistent transport, no CLI parsing |
| Semantic search | REST API | Model stays warm                     |
| AI answers      | REST API | Model stays loaded = 10x faster      |
| Add collection  | REST API | `POST /api/collections`              |
| Update index    | REST API | `POST /api/sync`                     |
| Quick capture   | REST API | `POST /api/docs`                     |

### CLI Fallback (Optional)

Only use CLI when server is unavailable. **CRITICAL**: Use `execFile` with args array, NOT `exec` with shell string. Include `--no-color` and `--` before query.

```typescript
import { execFile } from "child_process";
import { promisify } from "util";
const execFileAsync = promisify(execFile);

async function gnoSearchCLI(
  query: string,
  limit = 10
): Promise<SearchResult[]> {
  const gnoPath = getPreference<string>("gnoPath") || "gno";
  try {
    const { stdout } = await execFileAsync(
      gnoPath,
      ["search", "--json", "--no-color", "-n", String(limit), "--", query],
      { maxBuffer: 10 * 1024 * 1024 }
    );
    const result = JSON.parse(stdout);
    return result.results;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "GNO CLI not found. Install from: https://github.com/gmickel/gno"
      );
    }
    throw err;
  }
}
```

### REST API Client

**Default port is 3000.** Make port a Raycast preference.

```typescript
import { getPreferenceValues } from "@raycast/api";
import path from "path";

interface Preferences {
  gnoPath: string;
  serverPort: string;
  apiToken?: string;
  defaultCollection?: string;
}

function getApiBase(): string {
  const { serverPort } = getPreferenceValues<Preferences>();
  return `http://127.0.0.1:${serverPort || "3000"}`;
}

async function ensureServer(): Promise<boolean> {
  try {
    const res = await fetch(`${getApiBase()}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function apiHeaders(): HeadersInit {
  const { apiToken } = getPreferenceValues<Preferences>();
  const headers: HeadersInit = { "Content-Type": "application/json" };
  if (apiToken) headers["X-GNO-Token"] = apiToken;
  return headers;
}

async function apiRequest<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  if (!(await ensureServer())) {
    throw new Error("GNO server not running. Start with: gno serve");
  }
  const res = await fetch(`${getApiBase()}${endpoint}`, {
    ...options,
    headers: { ...apiHeaders(), ...options?.headers },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Request failed: ${res.status}`);
  }
  return res.json();
}
```

## Actual API Endpoints (Verified)

| Action         | Endpoint            | Method | Body                               | Response                             |
| -------------- | ------------------- | ------ | ---------------------------------- | ------------------------------------ |
| Add collection | `/api/collections`  | POST   | `{ path, name?, pattern? }`        | `202 { jobId, collection }`          |
| Sync/reindex   | `/api/sync`         | POST   | `{ collection? }`                  | `202 { jobId }` or `409 CONFLICT`    |
| Quick capture  | `/api/docs`         | POST   | `{ collection, relPath, content }` | `202 { uri, path, jobId }`           |
| Search (BM25)  | `/api/search`       | POST   | `{ query, limit?, collection? }`   | `200 SearchResults`                  |
| Hybrid search  | `/api/query`        | POST   | `{ query, limit?, collection? }`   | `200 SearchResults`                  |
| AI answer      | `/api/ask`          | POST   | `{ query, limit?, collection? }`   | `200 AskResult` or `503 UNAVAILABLE` |
| Job status     | `/api/jobs/:id`     | GET    | -                                  | `{ status, progress?, result? }`     |
| Collections    | `/api/collections`  | GET    | -                                  | `Collection[]`                       |
| Capabilities   | `/api/capabilities` | GET    | -                                  | `{ bm25, vector, hybrid, answer }`   |

## Async Job Model

**All write operations return 202 with a jobId.** Must poll for completion.

```typescript
interface JobStatus {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  progress?: { current: number; total: number };
  result?: unknown;
  error?: string;
}

async function pollJob(
  jobId: string,
  onProgress?: (p: JobStatus) => void
): Promise<JobStatus> {
  while (true) {
    const job = await apiRequest<JobStatus>(`/api/jobs/${jobId}`);
    onProgress?.(job);
    if (job.status === "completed" || job.status === "failed") return job;
    await new Promise((r) => setTimeout(r, 500));
  }
}

// Handle 409 CONFLICT - parse active job ID from error message
async function startSyncWithConflictHandling(
  onProgress?: (p: JobStatus) => void
): Promise<JobStatus> {
  try {
    const res = await fetch(`${getApiBase()}/api/sync`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({}),
    });
    if (res.status === 409) {
      const err = await res.json();
      // Parse: "Job <uuid> already running"
      const match = err.error?.message?.match(
        /Job ([a-f0-9-]+) already running/
      );
      if (match?.[1]) return pollJob(match[1], onProgress);
      throw new Error("Sync already in progress");
    }
    const { jobId } = await res.json();
    return pollJob(jobId, onProgress);
  } catch (err) {
    throw err;
  }
}
```

## Quick Capture Specification

**Note: Empty content is rejected by the server.** Always include at least a newline.

```typescript
interface CaptureRequest {
  collection: string; // Must exist
  relPath: string; // e.g., "inbox/20260102-1030-my-note.md"
  content: string; // CANNOT be empty - use "\n" minimum
  overwrite?: boolean;
}

// Path generation (filesystem-safe, no colons)
function generateCapturePath(title: string): string {
  const now = new Date();
  const ts = now
    .toISOString()
    .slice(0, 16)
    .replace(/[-:T]/g, "")
    .replace(/(\d{8})(\d{4})/, "$1-$2");
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 50)
    .replace(/-$/, "");
  return `inbox/${ts}-${slug || "untitled"}.md`;
}

// Ensure non-empty content
function prepareContent(content: string, title?: string): string {
  const trimmed = content.trim();
  if (trimmed) return trimmed;
  // Empty content - create minimal valid content
  return title ? `# ${title}\n` : "\n";
}
```

## Error Handling

**All API errors return JSON envelope:**

```json
{ "error": { "code": "ERROR_CODE", "message": "Human readable" } }
```

**Error codes (from api.ts):**
| Code | Status | Description |
|------|--------|-------------|
| VALIDATION | 400 | Invalid request body |
| NOT_FOUND | 404 | Resource not found |
| FILE_NOT_FOUND | 404 | Doc in index but file missing |
| CONFLICT | 409 | Job running / file exists |
| RUNTIME | 500 | Server error |
| UNAVAILABLE | 503 | Model not loaded for /api/ask |

**CLI errors** use codes like `QUERY_FAILED`, `GET_FAILED`. Handle generically:

```typescript
if (result.error) throw new Error(result.error.message || "Command failed");
```

## Security Model

- Server binds to `127.0.0.1` only (loopback)
- Requests WITHOUT `Origin` header are allowed (Node fetch)
- **Recommendation**: Use `X-GNO-Token` for explicit auth
- Set `GNO_API_TOKEN` env when starting `gno serve` to enable

## Finder Integration: Absolute Paths

Search results include `relPath` but not `absPath`. Use `path.resolve` with validation:

```typescript
import path from "path";

async function getCollectionPaths(): Promise<Map<string, string>> {
  const collections =
    await apiRequest<Array<{ name: string; path: string }>>("/api/collections");
  return new Map(collections.map((c) => [c.name, c.path]));
}

function resolveAbsPath(relPath: string, collectionPath: string): string {
  const abs = path.resolve(collectionPath, relPath);
  // Defense-in-depth: ensure result is within collection
  const normalized = path.normalize(collectionPath);
  if (!abs.startsWith(normalized + path.sep) && abs !== normalized) {
    throw new Error("Path escapes collection root");
  }
  return abs;
}
```

## Raycast Preferences

```json
{
  "preferences": [
    {
      "name": "gnoPath",
      "title": "GNO CLI Path",
      "description": "Path to gno executable (default: gno)",
      "type": "textfield",
      "default": "gno",
      "required": false
    },
    {
      "name": "serverPort",
      "title": "Server Port",
      "description": "Port for gno serve (default: 3000)",
      "type": "textfield",
      "default": "3000",
      "required": false
    },
    {
      "name": "apiToken",
      "title": "API Token",
      "description": "Optional token for X-GNO-Token auth",
      "type": "password",
      "required": false
    },
    {
      "name": "defaultCollection",
      "title": "Default Collection",
      "description": "Collection for quick capture",
      "type": "textfield",
      "required": false
    }
  ]
}
```

## Commands

### 1. Search (`gno search`)

- **Backend**: REST API `/api/search`
- **Fallback**: CLI if server unavailable

### 2. Semantic Search (`gno query`)

- **Backend**: REST API `/api/query`

### 3. Ask Question (`gno ask`)

- **Backend**: REST API `/api/ask`
- **Note**: Handle 503 UNAVAILABLE (model not loaded)

### 4. Quick Capture

- **Backend**: REST API `POST /api/docs`
- **Path**: `inbox/YYYYMMDD-HHmm-<slug>.md`
- **Note**: Content cannot be empty

### 5. Add Folder (Finder)

- **Backend**: REST API `POST /api/collections`
- **UX**: Prompt for collection name

### 6. Update Index

- **Backend**: REST API `POST /api/sync`
- **UX**: Poll job, handle 409 by polling active job

### 7. Browse Collections

- **Backend**: REST API

## Package Structure

```
gno-raycast/
├── package.json
├── src/
│   ├── search.tsx
│   ├── semantic-search.tsx
│   ├── ask.tsx
│   ├── capture.tsx
│   ├── add-folder.tsx
│   ├── update.tsx
│   ├── browse.tsx
│   └── lib/
│       ├── api.ts          # REST client + job polling
│       ├── cli.ts          # execFile fallback (optional)
│       └── types.ts
└── assets/
    └── icon.png            # 512x512 required
```

## Resources

- [Raycast Developer Docs](https://developers.raycast.com)
- [GNO API Docs](docs/API.md)
- [GNO Output Schemas](spec/output-schemas/)
