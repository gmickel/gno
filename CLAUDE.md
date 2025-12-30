**Note**: This project uses [bd (beads)](https://github.com/steveyegge/beads) for issue tracking. Use `bd` commands instead of markdown TODOs.

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

## Directory Structure

**docs/** - User-facing documentation only. Published to website.
- QUICKSTART.md, CLI.md, CONFIGURATION.md, etc.
- Do NOT put internal docs, spikes, plans, or dev notes here

**notes/** - Internal documentation, spikes, plans, dev notes
- Not published, not user-facing
- Spike results, implementation plans, architecture decisions

**spec/** - Interface contracts and schemas

## Versioning & Release

Version is managed in `package.json` (single source of truth). `src/app/constants.ts` imports it.

**Bump version:**
```bash
bun run version:patch   # 0.1.0 → 0.1.1
bun run version:minor   # 0.1.0 → 0.2.0
bun run version:major   # 0.1.0 → 1.0.0
```

**Release workflow:**
```bash
bun run prerelease       # lint + typecheck + test
bun run release:dry-run  # trigger CI without publishing
bun run release:trigger  # trigger CI with publish (requires NPM_TOKEN secret)
```

**Manual workflow dispatch:**
```bash
gh workflow run publish.yml -f publish=false  # dry run
gh workflow run publish.yml -f publish=true   # actual publish
```

**Full release process:**
1. `bun run version:patch` (or minor/major)
2. `git add package.json && git commit -m "chore: bump to vX.Y.Z"`
3. `git tag vX.Y.Z && git push --tags`
4. Workflow auto-triggers on `v*` tag push

**Requirements:**
- `NPM_TOKEN` secret in GitHub repo settings (Settings → Secrets → Actions)
- Uncomment publish job in `.github/workflows/publish.yml` when ready

## CI/CD

See [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md) for CI matrix, caching, and release process.

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

## Terminal Demos (VHS)

The documentation website includes animated terminal demos built with [VHS](https://github.com/charmbracelet/vhs).

### Structure

```
website/
├── demos/
│   ├── build-demos.sh       # Build script
│   └── tapes/               # VHS tape files
│       ├── hero.tape
│       ├── quickstart.tape
│       └── search-modes.tape
└── assets/demos/            # Generated GIFs
```

### Building Demos

```bash
# Build all demos
bun run website:demos

# Build specific demo
./website/demos/build-demos.sh hero

# List available tapes
./website/demos/build-demos.sh
```

### Creating New Demos

1. Create `website/demos/tapes/your-demo.tape`:

```tape
Output "your-demo.gif"
Set Theme "TokyoNight"
Set FontFamily "JetBrains Mono"
Set FontSize 16
Set Width 900
Set Height 500

# Hidden setup (not recorded)
Hide
Type `export DEMO_DIR=$(mktemp -d)`
Enter
# ... setup commands ...
Show

# Visible demo
Type "gno search 'query'"
Enter
Sleep 3s
```

2. Build: `./website/demos/build-demos.sh your-demo`

3. Use in docs:
```html
<div class="demo-container">
  <img src="/assets/demos/your-demo.gif" alt="Demo" class="demo-gif">
</div>
```

### Requirements

- VHS: `brew install charmbracelet/tap/vhs`
- GNO linked globally: `bun link`

<!-- BEGIN BEADS INTEGRATION -->
## Issue Tracking with bd (beads)

**IMPORTANT**: This project uses **bd (beads)** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

### Why bd?

- Dependency-aware: Track blockers and relationships between issues
- Git-friendly: Auto-syncs to JSONL for version control
- Agent-optimized: JSON output, ready work detection, discovered-from links
- Prevents duplicate tracking systems and confusion

### Quick Start

**Check for ready work:**

```bash
bd ready --json
```

**Create new issues:**

```bash
bd create "Issue title" --description="Detailed context" -t bug|feature|task -p 0-4 --json
bd create "Issue title" --description="What this issue is about" -p 1 --deps discovered-from:bd-123 --json
```

**Claim and update:**

```bash
bd update bd-42 --status in_progress --json
bd update bd-42 --priority 1 --json
```

**Complete work:**

```bash
bd close bd-42 --reason "Completed" --json
```

### Issue Types

- `bug` - Something broken
- `feature` - New functionality
- `task` - Work item (tests, docs, refactoring)
- `epic` - Large feature with subtasks
- `chore` - Maintenance (dependencies, tooling)

### Priorities

- `0` - Critical (security, data loss, broken builds)
- `1` - High (major features, important bugs)
- `2` - Medium (default, nice-to-have)
- `3` - Low (polish, optimization)
- `4` - Backlog (future ideas)

### Workflow for AI Agents

1. **Check ready work**: `bd ready` shows unblocked issues
2. **Claim your task**: `bd update <id> --status in_progress`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked issue:
   - `bd create "Found bug" --description="Details about what was found" -p 1 --deps discovered-from:<parent-id>`
5. **Complete**: `bd close <id> --reason "Done"`

### Auto-Sync

bd automatically syncs with git:

- Exports to `.beads/issues.jsonl` after changes (5s debounce)
- Imports from JSONL when newer (e.g., after `git pull`)
- No manual export/import needed!

### Important Rules

- ✅ Use bd for ALL task tracking
- ✅ Always use `--json` flag for programmatic use
- ✅ Link discovered work with `discovered-from` dependencies
- ✅ Check `bd ready` before asking "what should I work on?"
- ❌ Do NOT create markdown TODO lists
- ❌ Do NOT use external issue trackers
- ❌ Do NOT duplicate tracking systems

For more details, see README.md and docs/QUICKSTART.md.

<!-- END BEADS INTEGRATION -->
