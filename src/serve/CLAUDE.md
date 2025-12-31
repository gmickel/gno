# Web UI (gno serve)

Local web server for GNO search and document browsing.

## Architecture

Uses same **"Ports without DI"** pattern as CLI/MCP (see root CLAUDE.md):
- Adapters instantiated directly in `context.ts`
- Pipeline code receives port interfaces
- No dependency injection

```
src/serve/
├── server.ts          # Bun.serve() entry point
├── context.ts         # ServerContext with LLM ports
├── routes/
│   └── api.ts         # REST API handlers
└── public/            # React frontend (Bun HTML imports)
    ├── App.tsx        # Router
    ├── pages/         # Page components
    ├── components/    # UI components (ShadCN + AI Elements)
    └── hooks/         # Custom hooks (useApi, etc.)
```

## Key Patterns

### Ports (interfaces)
- `EmbeddingPort` - vector embeddings
- `GenerationPort` - LLM text generation
- `RerankPort` - cross-encoder reranking
- `VectorIndexPort` - vector search

### ServerContext
Created at startup, holds all LLM ports and capabilities:
```typescript
interface ServerContext {
  store: SqliteAdapter;
  config: Config;
  vectorIndex: VectorIndexPort | null;
  embedPort: EmbeddingPort | null;
  genPort: GenerationPort | null;
  rerankPort: RerankPort | null;
  capabilities: { bm25, vector, hybrid, answer };
}
```

### Shared Pipeline Code
Answer generation uses shared module to stay in sync with CLI:
- `src/pipeline/answer.ts` - generateGroundedAnswer, processAnswerResult

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/status` | GET | Index stats, collections |
| `/api/capabilities` | GET | Available features |
| `/api/collections` | GET | List collections |
| `/api/docs` | GET | List documents |
| `/api/doc` | GET | Get document content |
| `/api/search` | POST | BM25 search |
| `/api/query` | POST | Hybrid search |
| `/api/ask` | POST | AI answer with citations |
| `/api/presets` | GET | List model presets |
| `/api/presets` | POST | Switch preset (hot-reload) |
| `/api/models/status` | GET | Download progress |
| `/api/models/pull` | POST | Start model download |

## Frontend

- **Framework**: React (via Bun HTML imports)
- **Styling**: Tailwind CSS + ShadCN components
- **AI Elements**: Conversation, Message, Sources, CodeBlock, Loader
- **Routing**: Simple hash-free SPA routing in App.tsx

## Development

```bash
# Start dev server with HMR
bun run src/serve/index.ts

# Or via CLI
gno serve --port 3000
```

## Security

- Binds to `127.0.0.1` only (no LAN exposure)
- CSP headers on all responses
- CORS protection on POST endpoints
- No external font/script loading
