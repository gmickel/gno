---
layout: feature
title: REST API
headline: Build Anything with Your Knowledge
description: HTTP API for programmatic access to GNO search and retrieval. Build custom tools, automate workflows, integrate with any language.
keywords: gno api, rest api, http api, search api, local api, programmatic search
icon: code
slug: api
permalink: /features/api/
benefits:
  - Full search capabilities via HTTP
  - JSON request/response format
  - Works with any language
  - No authentication required
  - Zero rate limits
commands:
  - "curl http://localhost:3000/api/status"
  - "curl -X POST /api/query -d '{...}'"
---

## Your Index, Programmable

Every GNO feature is accessible via REST API. Build custom dashboards, integrate with scripts, automate document workflows, all with simple HTTP calls.

```bash
gno serve
# API available at http://localhost:3000/api/*
```

## Quick Examples

### Search Documents

```bash
curl -X POST http://localhost:3000/api/query \
  -H "Content-Type: application/json" \
  -d '{"query": "authentication patterns", "limit": 10}'
```

### Get AI Answer

```bash
curl -X POST http://localhost:3000/api/ask \
  -H "Content-Type: application/json" \
  -d '{"query": "What is our deployment process?"}'
```

### Check Status

```bash
curl http://localhost:3000/api/status | jq
```

## Available Endpoints

| Endpoint             | Method   | Description                 |
| :------------------- | :------- | :-------------------------- |
| `/api/status`        | GET      | Index statistics            |
| `/api/search`        | POST     | BM25 keyword search         |
| `/api/query`         | POST     | Hybrid search (recommended) |
| `/api/ask`           | POST     | AI-powered Q&A              |
| `/api/docs`          | GET      | List documents              |
| `/api/doc`           | GET      | Get document content        |
| `/api/presets`       | GET/POST | Model preset management     |
| `/api/models/pull`   | POST     | Download models             |
| `/api/models/status` | GET      | Download progress           |

## Language Integrations

### Python

```python
import requests

def search(query: str) -> list:
    resp = requests.post(
        "http://localhost:3000/api/query",
        json={"query": query, "limit": 10}
    )
    return resp.json()["results"]

def ask(question: str) -> str:
    resp = requests.post(
        "http://localhost:3000/api/ask",
        json={"query": question}
    )
    return resp.json().get("answer")
```

### JavaScript

```javascript
async function search(query) {
  const resp = await fetch("http://localhost:3000/api/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit: 10 }),
  });
  const data = await resp.json();
  return data.results;
}
```

### Shell Script

```bash
#!/bin/bash
gno_search() {
  curl -s -X POST http://localhost:3000/api/query \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$1\"}" | jq '.results'
}

gno_search "project roadmap"
```

## Use Cases

### Raycast Commands

Create instant search from your launcher:

```bash
#!/bin/bash
# @raycast.title Search Notes
curl -s -X POST http://localhost:3000/api/query \
  -d "{\"query\": \"$1\"}" | jq -r '.results[].title'
```

### Obsidian Plugins

Query your external notes from within Obsidian.

### Custom Dashboards

Build team knowledge bases with your own frontend.

### CI/CD Integration

Search documentation as part of your pipeline.

## No Limits

- **No authentication**: It's your local machine
- **No rate limits**: Performance depends on hardware
- **No data limits**: Index as much as you want
- **No cloud**: Everything stays local

## Full Documentation

See the [API Reference](/docs/API/) for complete endpoint documentation, request/response schemas, and more examples.
