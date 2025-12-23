**Note**: This project uses [bd (beads)](https://github.com/steveyegge/beads) for issue tracking. Use `bd` commands instead of markdown TODOs. See AGENTS.md for workflow details.

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## APIs - BUN FIRST!

**CRITICAL**: Always prefer Bun native APIs over Node.js equivalents. Search for Bun alternatives before using `node:*` imports.

### Must Use Bun

| Task | Use This | NOT This |
|------|----------|----------|
| HTTP server | `Bun.serve()` | express, fastify, koa |
| SQLite | `bun:sqlite` | better-sqlite3, sqlite3 |
| Redis | `Bun.redis` | ioredis, redis |
| Postgres | `Bun.sql` | pg, postgres.js |
| WebSockets | `WebSocket` (built-in) | ws |
| File read/write | `Bun.file()`, `Bun.write()` | node:fs readFile/writeFile |
| File existence | `Bun.file(path).exists()` | node:fs stat/access |
| Shell commands | `Bun.$\`cmd\`` | execa, child_process |
| YAML | `Bun.YAML` | js-yaml, yaml |
| Env loading | (automatic) | dotenv |

### Acceptable node:* (No Bun Equivalent)

| Module | Functions | Why |
|--------|-----------|-----|
| `node:path` | join, dirname, basename, isAbsolute, normalize | No Bun path utils |
| `node:os` | homedir, platform, tmpdir | No Bun os utils |
| `node:fs/promises` | mkdir, rename, unlink, rm, mkdtemp | Filesystem structure ops only |

**Rule**: If you add a `node:*` import, comment WHY there's no Bun alternative.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Specifications

**IMPORTANT**: Before implementing CLI commands, MCP tools, or output formats, consult the specs:

- `spec/cli.md` - CLI commands, flags, exit codes, output formats
- `spec/mcp.md` - MCP tools, resources, schemas, versioning
- `spec/output-schemas/*.json` - JSON schemas for all structured outputs
- `spec/db/schema.sql` - Database schema (when implemented)
- `docs/prd.md` - Full product requirements (§14-16 for interface contracts)

Contract tests in `test/spec/schemas/` validate outputs against schemas. Run `bun test` to verify compliance.

When adding new commands or modifying outputs:
1. Update the relevant spec first
2. Add/update JSON schema if output shape changes
3. Add contract tests for the schema
4. Implement the feature
5. Verify tests pass

### Avoiding Documentation Drift

**CRITICAL**: After completing any task, verify documentation is current:

- [ ] README.md - Does it reflect current capabilities?
- [ ] CLAUDE.md / AGENTS.md - Are instructions still accurate?
- [ ] spec/*.md - Do specs match implementation?
- [ ] spec/output-schemas/*.json - Do schemas match actual outputs?
- [ ] docs/prd.md - Mark completed items with ✓
- [ ] Beads - Are descriptions and comments up to date?

If you change behavior, update docs in the same commit. Never leave docs out of sync.

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

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
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";

// import .css files directly and it works
import './index.css';

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
