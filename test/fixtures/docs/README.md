# Test Fixtures Documentation

These markdown files are designed for testing gno's search capabilities.

## Contents

| File | Topics | Languages | Purpose |
|------|--------|-----------|---------|
| authentication.md | JWT, OAuth, sessions, passwords | TypeScript | Auth flows, security |
| database-queries.md | SQL, pooling, N+1, indexing | TypeScript, SQL | Database patterns |
| error-handling.md | Result types, retries, errors | TypeScript | Error strategies |
| rest-api-design.md | HTTP, REST, status codes | TypeScript, JSON | API contracts |
| testing-strategies.md | Unit, integration, E2E, mocking | TypeScript | Test patterns |
| caching-patterns.md | Redis, TTL, stampede, multi-level | TypeScript | Cache strategies |
| python-async.md | asyncio, coroutines, generators | Python | Async Python |
| go-concurrency.md | goroutines, channels, WaitGroup | Go | Go concurrency |
| docker-deployment.md | Dockerfile, compose, health | Dockerfile, YAML | Container ops |
| security-checklist.md | XSS, RBAC, encryption, secrets | TypeScript | Security audit |

## Usage

### Manual Testing

```bash
# Initialize collection
gno init test/fixtures/docs --name fixtures

# Index content
gno update

# BM25 search (keyword matching)
gno search "JWT token authentication"
gno search "database connection pool"
gno search "goroutine channel"

# Semantic search (requires embeddings)
gno embed
gno vsearch "how to handle user login"
gno vsearch "making database queries faster"
gno vsearch "running code in parallel"
```

### Test Queries

**BM25-specific** (exact keyword matches):
- `"bcrypt password"` → authentication.md
- `"N+1 query"` → database-queries.md
- `"asyncio.gather"` → python-async.md
- `"WaitGroup"` → go-concurrency.md
- `"multi-stage build"` → docker-deployment.md

**Semantic-specific** (concept matching):
- `"verify user identity"` → authentication.md
- `"speed up data access"` → caching-patterns.md
- `"run tests automatically"` → testing-strategies.md
- `"protect against hackers"` → security-checklist.md
- `"deploy to production"` → docker-deployment.md

**Cross-document queries** (multiple relevant results):
- `"error handling"` → error-handling.md, rest-api-design.md
- `"concurrency"` → python-async.md, go-concurrency.md
- `"security"` → authentication.md, security-checklist.md

### Language Filter Testing

```bash
# Filter by code block language
gno search "async" --lang python
gno search "channel" --lang go
gno vsearch "database query" --lang typescript
gno vsearch "container" --lang dockerfile
```

## Design Notes

Files are designed with:
- **Distinct keywords** for BM25 precision testing
- **Overlapping concepts** for semantic recall testing
- **Multiple languages** for --lang filter testing
- **Various structures** (code, tables, lists, headings)
- **Related but different terminology** to test embedding similarity
