## KNOWLEDGE CUTOFF WARNING

**DO NOT suggest outdated models due to knowledge cutoff.** Current models (2026):

- OpenAI: `gpt-5-mini`, `gpt-5.2`
- Anthropic: `claude-opus-4.5`, `claude-sonnet-4.5`, `claude-haiku-4.5`

When in doubt about model names, ASK the user rather than defaulting to outdated versions.

---

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

| Task            | Use This                    | NOT This                   |
| --------------- | --------------------------- | -------------------------- |
| HTTP server     | `Bun.serve()`               | express, fastify, koa      |
| SQLite          | `bun:sqlite`                | better-sqlite3, sqlite3    |
| Redis           | `Bun.redis`                 | ioredis, redis             |
| Postgres        | `Bun.sql`                   | pg, postgres.js            |
| WebSockets      | `WebSocket` (built-in)      | ws                         |
| File read/write | `Bun.file()`, `Bun.write()` | node:fs readFile/writeFile |
| File existence  | `Bun.file(path).exists()`   | node:fs stat/access        |
| Shell commands  | `Bun.$\`cmd\``              | execa, child_process       |
| YAML            | `Bun.YAML`                  | js-yaml, yaml              |
| Env loading     | (automatic)                 | dotenv                     |

### Acceptable node:\* (No Bun Equivalent)

| Module             | Functions                                      | Why                           |
| ------------------ | ---------------------------------------------- | ----------------------------- |
| `node:path`        | join, dirname, basename, isAbsolute, normalize | No Bun path utils             |
| `node:os`          | homedir, platform, tmpdir                      | No Bun os utils               |
| `node:fs/promises` | mkdir, rename, unlink, rm, mkdtemp             | Filesystem structure ops only |

**Rule**: If you add a `node:*` import, comment WHY there's no Bun alternative.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Evals (Quality Gates)

Local-only evaluation suite using Evalite v1. Run before releases as part of DoD.

**Commands:**

```bash
bun run eval          # Run full eval suite (~5s)
bun run eval:watch    # Watch mode for development
```

**Eval Files** (in `evals/`):

| File                   | What it tests                                  | Threshold |
| ---------------------- | ---------------------------------------------- | --------- |
| `expansion.eval.ts`    | Query expansion schema validity                | 70%       |
| `vsearch.eval.ts`      | BM25 ranking (Recall@5/10, nDCG@10)            | 70%       |
| `query.eval.ts`        | Query pipeline + latency budget                | 70%       |
| `multilingual.eval.ts` | Cross-language retrieval (placeholder)         | 70%       |
| `thoroughness.eval.ts` | Fast/balanced/thorough comparison (stats only) | 70%       |
| `ask.eval.ts`          | Answer quality by preset                       | 70%       |

**Fixtures** (in `evals/fixtures/`):

- `corpus/` - 9 test docs (EN/DE/FR/IT)
- `queries.json` - 29 queries with relevance judgments
- `ask-cases.json` - 8 ask test cases

**Key Design Decisions:**

- No CI integration - evals are local-only, part of release DoD
- Temp DB per run (isolated from global gno install)
- In-memory Evalite storage by default
- LLM-as-judge requires OPENAI_API_KEY (skips gracefully if not set)
- Multilingual is placeholder (vector search future work)
- Thoroughness comparison reports stats, doesn't assert ordering

## Development Scripts

**scripts/** - Development and testing utilities (not published)

| Script                      | Purpose                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `perf-test.ts`              | Performance testing for search pipeline. Tests different configurations (expand/rerank combinations) and measures timing.  |
| `test-rerank-size.ts`       | Tests reranker performance at different document sizes (1K-128K chars). Used to identify optimal chunk size for reranking. |
| `docs-verify.ts`            | Verifies documentation is up-to-date with implementation.                                                                  |
| `generate-test-fixtures.ts` | Generates test fixtures for unit tests.                                                                                    |

**Usage:**

```bash
bun scripts/perf-test.ts        # Run full performance test suite
bun scripts/test-rerank-size.ts # Test rerank scaling with doc size
```

## Directory Structure

**docs/** - User-facing documentation only. Published to website.

- QUICKSTART.md, CLI.md, CONFIGURATION.md, etc.
- Do NOT put internal docs, spikes, plans, or dev notes here

**notes/** - Internal documentation, spikes, plans, dev notes (gitignored)

- Not published, not user-facing, not tracked in git
- Spike results, implementation plans, architecture decisions

**spec/** - Interface contracts and schemas (see `spec/CLAUDE.md`)

**src/cli/** - CLI commands (see `src/cli/CLAUDE.md`)

**src/mcp/** - MCP server (see `src/mcp/CLAUDE.md`)

**src/serve/** - Web UI server (see `src/serve/CLAUDE.md`)

**test/** - Test suite (see `test/CLAUDE.md`)

**website/** - Jekyll documentation site (see `website/CLAUDE.md`)

## Versioning & Release

Version is managed in `package.json` (single source of truth). `src/app/constants.ts` imports it.

**IMPORTANT**: Bump version on EVERY merge to main:

- Features/new functionality → `version:minor`
- Bug fixes/patches → `version:patch`
- Breaking changes → `version:major`

**Bump version:**

```bash
bun run version:patch   # 0.1.0 → 0.1.1 (bug fixes)
bun run version:minor   # 0.1.0 → 0.2.0 (features)
bun run version:major   # 0.1.0 → 1.0.0 (breaking)
```

**Release workflow:**

```bash
bun run prerelease       # lint:check + test
bun run release:dry-run  # trigger CI without publishing
bun run release:trigger  # trigger CI with publish (uses OIDC, no token needed)
```

**Manual workflow dispatch:**

```bash
gh workflow run publish.yml -f publish=false  # dry run
gh workflow run publish.yml -f publish=true   # actual publish
```

**Post-merge workflow (EVERY merge to main):**

1. `bun run version:patch` (or minor/major based on changes)
2. **Update CHANGELOG.md** - Move [Unreleased] items to new version section
3. `git add package.json CHANGELOG.md`
4. `git commit -m "chore: bump to vX.Y.Z"`
5. `git tag vX.Y.Z && git push --tags`
6. Workflow auto-triggers on `v*` tag push

**Note**: `website/changelog.md` is auto-copied from root CHANGELOG.md during build (gitignored).

**CHANGELOG format** (Keep a Changelog):

```markdown
## [Unreleased]
### Added
- New feature description

## [0.2.0] - 2025-01-15
### Added
- Feature from this release
### Fixed
- Bug that was fixed
```

**Requirements:**

- Configure npm trusted publisher at https://www.npmjs.com/package/@gmickel/gno/access
  - Owner: `gmickel`, Repo: `gno`, Workflow: `publish.yml`

## CI/CD

See [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md) for CI matrix, caching, and release process.

## npm Package Gotchas

**"Works locally, breaks on npm install"** - Check these:

1. **`files` array in package.json** - Only listed files/dirs ship to npm
   - Runtime deps must be in `dependencies`, not `devDependencies`
   - Config files like `bunfig.toml` must be explicitly listed
   - Current: `assets`, `bunfig.toml`, `src`, `THIRD_PARTY_NOTICES.md`, `vendor`

2. **bunfig.toml** - Required for Bun.serve() plugins
   - Must be in `files` array to ship with npm package
   - Contains `[serve.static] plugins = ["bun-plugin-tailwind"]` for CSS

3. **Dependencies vs devDependencies**
   - `tailwindcss`, `bun-plugin-tailwind` - runtime (dependencies)
   - `@biomejs/biome`, `oxlint` - build only (devDependencies)

4. **Pre-built assets** - Some things can't resolve at runtime from global installs
   - CSS is pre-built with `bun run build:css` (CI runs this before publish)
   - `globals.built.css` ships in package, `globals.css` is source

**Test npm package locally:**

```bash
# Build and pack
bun run build:css && npm pack

# Install globally from tarball
npm install -g ./gmickel-gno-*.tgz

# Test
gno --version
gno serve  # Check CSS loads at http://localhost:3000

# Cleanup
npm uninstall -g @gmickel/gno
rm gmickel-gno-*.tgz
```

## Architecture Pattern

GNO uses **"Ports without DI"** - a pragmatic simplification of hexagonal architecture:

- **Port interfaces exist**: `EmbeddingPort`, `GenerationPort`, `RerankPort`, `VectorIndexPort`
- **Pipeline code receives ports as params**: Enables testing, clear dependencies
- **No dependency injection**: Adapters instantiated directly in commands (`new LlmAdapter()`, `new SqliteAdapter()`)
- **Single implementation per port**: No swappable backends (only node-llama-cpp, only SQLite)

This is intentional - full hexagonal would add complexity without benefit for a CLI tool with fixed backends.

```
CLI/MCP/Serve → new Adapter() → adapter.createPort() → Port interface → Pipeline
```

## Specifications

**IMPORTANT**: Before implementing CLI commands, MCP tools, or output formats, consult the specs:

- `spec/cli.md` - CLI commands, flags, exit codes, output formats
- `spec/mcp.md` - MCP tools, resources, schemas, versioning
- `spec/output-schemas/*.json` - JSON schemas for all structured outputs
- `spec/db/schema.sql` - Database schema (when implemented)

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
- [ ] spec/\*.md - Do specs match implementation?
- [ ] spec/output-schemas/\*.json - Do schemas match actual outputs?
- [ ] docs/\*.md - User-facing docs accurate?
  - CLI.md, QUICKSTART.md, ARCHITECTURE.md
  - WEB-UI.md, API.md (for `gno serve` and REST API)
  - MCP.md (for `gno mcp`)
- [ ] website/\_data/features.yml - Feature bento cards current?
- [ ] website/ - Auto-synced from docs/ via `bun run website:sync-docs`
- [ ] Beads - Are descriptions and comments up to date?

**Website sync**: The `website/docs/` directory is auto-populated from `docs/` during build.
Run `bun run website:sync-docs` to manually sync. CHANGELOG.md is also copied.

If you change behavior, update docs in the same commit. Never leave docs out of sync.

## Session Completion

**When ending a work session:**

1. **File issues** - Create beads for remaining/discovered work
2. **Quality gates** (if code changed) - `bun run lint:check && bun test`
3. **Update beads** - Close finished, update in-progress
4. **Sync & push** - `bd sync && git push` (see Versioning for release pushes)
5. **Verify** - `git status` shows up to date with origin

Work is NOT complete until pushed to remote.

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
