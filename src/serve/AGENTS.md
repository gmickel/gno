# Web UI (gno serve)

Local web server for GNO search and document browsing.

## UI Development

**ALWAYS use the `frontend-design` plugin** for any UI component work. This ensures distinctive, high-quality designs that match the "Scholarly Dusk" aesthetic rather than generic AI-generated patterns.

```
/frontend-design:frontend-design <description of component>
```

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
  capabilities: { bm25; vector; hybrid; answer };
}
```

### Shared Pipeline Code

Answer generation uses shared module to stay in sync with CLI:

- `src/pipeline/answer.ts` - generateGroundedAnswer, processAnswerResult

## API Endpoints

| Endpoint             | Method | Description                |
| -------------------- | ------ | -------------------------- |
| `/api/health`        | GET    | Health check               |
| `/api/status`        | GET    | Index stats, collections   |
| `/api/capabilities`  | GET    | Available features         |
| `/api/collections`   | GET    | List collections           |
| `/api/docs`          | GET    | List documents             |
| `/api/doc`           | GET    | Get document content       |
| `/api/search`        | POST   | BM25 search                |
| `/api/query`         | POST   | Hybrid search              |
| `/api/ask`           | POST   | AI answer with citations   |
| `/api/presets`       | GET    | List model presets         |
| `/api/presets`       | POST   | Switch preset (hot-reload) |
| `/api/models/status` | GET    | Download progress          |
| `/api/models/pull`   | POST   | Start model download       |
| `/api/tags`          | GET    | List tags (with counts)    |

## Frontend

- **Framework**: React (via Bun HTML imports)
- **Styling**: Tailwind CSS + ShadCN components
- **AI Elements**: Conversation, Message, Sources, CodeBlock, Loader
- **Tag Components**: TagInput, TagFacets (filter sidebar)
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

## Bun.serve() Patterns

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server example:

```ts
import index from "./index.html";

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    },
  },
  development: {
    hmr: true,
    console: true,
  },
});
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx
import React from "react";

// import .css files directly and it works
import "./index.css";

import { createRoot } from "react-dom/client";

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.md`.

## Tag System

REST endpoints support tag filtering:

- `GET /api/tags` - List all tags with doc counts
- `POST /api/search`, `/api/query`, `/api/ask` - Accept `tags` array param

WebUI state:

- TagFacets component shows available tags with counts
- TagInput for adding/removing tags on documents
- Selected tags filter search results (AND logic)

Implementation:

- Tags stored in `doc_tags` junction table with `source` (frontmatter|user)
- Validation via `src/core/tags.ts`
- Frontmatter parsing in `src/ingestion/frontmatter.ts`
