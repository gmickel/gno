# MCP Server

GNO's Model Context Protocol server for AI agent integration.

## Architecture

```
src/mcp/
├── server.ts          # MCP server setup, stdio transport
├── tools/             # Tool implementations
│   ├── index.ts       # Tool registry
│   ├── search.ts      # gno_search (BM25)
│   ├── vsearch.ts     # gno_vsearch (vector)
│   ├── query.ts       # gno_query (hybrid)
│   ├── get.ts         # gno_get (single doc)
│   ├── multi-get.ts   # gno_multi_get (batch)
│   └── status.ts      # gno_status
└── resources/         # Resource implementations
    └── index.ts       # gno:// URI scheme
```

## Specification

See `spec/mcp.md` for full MCP specification including:

- Tool schemas and responses
- Resource URI schemes
- Error codes
- Versioning

**Always update spec/mcp.md first** when adding/modifying tools.

## Tool Pattern

Each tool follows this structure:

```typescript
export const toolName: Tool = {
  name: "gno_toolname",
  description: "What this tool does",
  inputSchema: {
    type: "object",
    properties: {
      /* ... */
    },
    required: ["query"],
  },
};

export async function handleToolName(
  args: ToolArgs,
  store: SqliteAdapter
  // ... other ports
): Promise<CallToolResult> {
  // 1. Validate args
  // 2. Execute operation
  // 3. Return { content: [...], structuredContent: {...} }
}
```

## Response Format

All tools return both human-readable and structured content:

```typescript
return {
  content: [{ type: "text", text: "Human readable summary" }],
  structuredContent: {
    // Machine-readable data matching spec schemas
  },
};
```

## Resources

Resources use `gno://` URI scheme:

- `gno://work/path/to/doc.md` - Document content
- `gno://collections` - List collections
- `gno://schemas/*` - JSON schemas

## Testing

MCP tests in `test/mcp/`:

```bash
bun test test/mcp/
```

## Tag Tools

Tag management via MCP:

- `gno.list_tags` - List all tags with doc counts, optional collection filter
- `gno.tag` - Add/remove tags from documents

```typescript
// gno.list_tags
{ collection?: string }  // optional filter
// Returns: { tags: [{ name, count }] }

// gno.tag
{ action: "add" | "remove", path: string, tags: string[] }
// Returns: { success, tags: [...current tags] }
```

- Tags in search/query tools: `--tags` param filters by tag (AND logic)
- Validation via `src/core/tags.ts`: normalizeTag(), validateTag()
- Storage: `doc_tags` junction table with `source` column (frontmatter|user)
