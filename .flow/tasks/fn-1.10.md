# T13.3: REST API client module

**Migrated from:** gno-ub9.11
**Priority:** P1

## Description

Create REST API client for gno serve endpoints.

## File

src/lib/api.ts

## Constants

```typescript
const GNO_API = "http://127.0.0.1:3000";
```

## Functions

```typescript
// AI-powered answer (fast when models loaded)
async function apiAsk(query: string, limit?: number): Promise<AskResponse>;

// Hybrid search via API
async function apiQuery(query: string, limit?: number): Promise<SearchResult[]>;

// Create document (quick capture)
async function apiCreateDoc(
  collection: string,
  relPath: string,
  content: string
): Promise<CreateDocResponse>;

// Add collection (Finder integration)
async function apiAddCollection(
  path: string,
  name?: string
): Promise<{ jobId: string }>;

// Trigger sync/reindex
async function apiSync(collection?: string): Promise<{ jobId: string }>;

// Poll job status
async function apiGetJob(jobId: string): Promise<JobStatus>;

// List collections
async function apiCollections(): Promise<Collection[]>;

// Check if API is running
async function isApiRunning(): Promise<boolean>;
```

## Error Handling

Parse error envelope: `{ error: { code, message } }`

Error codes:

- NOT_FOUND (404)
- FILE_NOT_FOUND (404)
- NOT_EDITABLE (403)
- CONFLICT (409) - job already running
- FILE_TOO_LARGE (413)
- ENCODING_ERROR (422)

## Authentication

Optional X-GNO-Token header if GNO_API_TOKEN preference set

## Checklist

- [ ] apiAsk implementation
- [ ] apiQuery implementation
- [ ] apiCreateDoc implementation
- [ ] apiAddCollection implementation
- [ ] apiSync implementation
- [ ] apiGetJob implementation
- [ ] apiCollections implementation
- [ ] isApiRunning check
- [ ] Error envelope parsing
- [ ] Optional token auth

## Acceptance Criteria

- [ ] Implementation complete
- [ ] Tests passing
