# GNO MCP Reference

GNO provides an MCP (Model Context Protocol) server for AI integration.

## Setup

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gno": {
      "command": "gno",
      "args": ["mcp"]
    }
  }
}
```

Config location:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

### Start Server

```bash
gno mcp
```

Runs JSON-RPC 2.0 over stdio.

## Tools

### gno.search

BM25 keyword search.

```json
{
  "query": "search terms",
  "collection": "optional-collection",
  "limit": 5,
  "minScore": 0.5,
  "lang": "en"
}
```

### gno.vsearch

Vector semantic search. Same parameters as `gno.search`.

### gno.query

Hybrid search (best quality).

```json
{
  "query": "search terms",
  "collection": "optional-collection",
  "limit": 5
}
```

**Search modes** (via parameters):

| Mode | Parameters | Time |
|------|------------|------|
| Fast | `fast: true` | ~0.7s |
| Default | (none) | ~2-3s |
| Thorough | `thorough: true` | ~5-8s |

Default skips expansion, with reranking. Use `thorough: true` for best recall.

**Agent retry strategy**: Use default mode first. If no relevant results:
1. Rephrase the query (free, often effective)
2. Then try `thorough: true` for better recall

### gno.get

Retrieve document by reference.

```json
{
  "ref": "gno://collection/path or #docid",
  "fromLine": 1,
  "lineCount": 100,
  "lineNumbers": true
}
```

### gno.multi_get

Retrieve multiple documents.

```json
{
  "refs": ["gno://work/doc1.md", "#a1b2c3d4"],
  "maxBytes": 10240,
  "lineNumbers": true
}
```

Or by pattern:

```json
{
  "pattern": "work/**/*.md",
  "maxBytes": 10240
}
```

### gno.status

Get index status.

```json
{}
```

## Resources

Documents accessible as MCP resources:

```
gno://{collection}/{path}
```

Examples:
- `gno://work/contracts/nda.docx`
- `gno://notes/2025/01/meeting.md`

Returns Markdown content with line numbers.

## Response Format

All tools return:

```json
{
  "content": [
    { "type": "text", "text": "Human-readable summary" }
  ],
  "structuredContent": {
    "results": [...],
    "meta": { "query": "...", "mode": "hybrid" }
  }
}
```

## Error Handling

Errors return:

```json
{
  "isError": true,
  "content": [
    { "type": "text", "text": "Error: Document not found" }
  ]
}
```

## Graceful Degradation

`gno.query` degrades gracefully:
- No vectors → BM25 only
- No expansion model → skips expansion
- No rerank model → skips reranking
