---
title: Installation
description: Install GNO with Bun, verify local runtime requirements, and get the local knowledge workspace ready on macOS, Linux, or Windows.
keywords: install gno, bun install gno, local knowledge workspace install, hybrid search install
---

# Installation

GNO currently requires [Bun](https://bun.sh/) as its JavaScript runtime.

> **Beta runtime note**: This is still the current beta path. GNO does not yet bundle Bun for end users. The app and API now surface this explicitly in the dashboard bootstrap panel so runtime assumptions are visible instead of implicit.

## Quick Install

```bash
# Install Bun (if not already installed)
curl -fsSL https://bun.sh/install | bash

# Install GNO
bun install -g @gmickel/gno

# Set up a real folder and prove an exact local lexical result
gno setup ~/notes --name notes
```

`gno setup` bootstraps an empty installation, creates or reuses one collection,
indexes it, and closes only after a corpus-derived BM25 probe returns an exact
`gno://` result. Rerun the same command safely. Semantic work is a separate
one-shot process; `--no-semantic` records skipped state without starting one.
The printed foreground `gno ... embed <collection>` command resumes work.

Optionally select agent handoffs after lexical proof:

```bash
gno setup ~/notes --name notes \
  --connector cursor-mcp \
  --connector codex-skill
```

Supported IDs: `claude-code-skill`, `claude-desktop-mcp`, `cursor-mcp`,
`codex-skill`, `opencode-skill`, `openclaw-skill`, and `hermes-skill`.
Repeated IDs dedupe. Existing config is reused without overwrite; malformed
config is preserved and reported as `completed_with_actions`. MCP targets run a
bounded retrieval smoke. Skill execution remains
`target_runtime_unverifiable`.

Release packages are smoke-tested with `bun run test:package`, which installs
the packed npm tarball into isolated temp paths. It verifies `gno setup`
first-run and idempotent rerun behavior, exact lexical evidence, private
receipts, all seven connector IDs, no-semantic ownership, and the production
resident gateway. The gateway proof still covers two clients, stdio/HTTP
parity, safe lifecycle status, security rejection, restart, and shutdown.

Without connector flags, JSON remains `setup-command-result@1.0`. With
connectors it becomes `setup-activation-result@1.0`, wrapping the unchanged
setup result plus bounded connector state. Argument or lexical failure keeps
the original nonzero exit code, emits `connectors: []`, and runs no connector
action. After lexical proof, connector failures/skips keep exit 0 and report
`completed_with_actions`.

Setup is always a direct standalone transaction. It never discovers, attaches
to, or enqueues work through `gno serve`, `gno daemon`, Web, or MCP.

If you want a guided setup after install, run `gno serve` and open `http://localhost:3000`. The first-run dashboard can add a folder, explain health, show bootstrap/runtime status, and trigger model downloads without more terminal work.

If you want a headless long-running process instead, run:

```bash
gno daemon
```

`gno daemon` keeps the same watch/sync/embed loop running without the Web UI or
desktop shell. It stays in the foreground; use `nohup`, launchd, or systemd if
you want supervision.

### SDK / Library Install

```bash
bun add @gmickel/gno
```

```ts
import { createGnoClient } from "@gmickel/gno";
```

> **macOS users**: Vector search requires Homebrew SQLite. See [macOS setup](#macos) below.

### Chromium Browser Clipper

The npm package includes a reproducible unpacked Manifest V3 extension at:

```text
<npm root -g>/@gmickel/gno/browser-extension/dist
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**,
and select that directory. Start `gno serve`, then pair through the extension's
visible five-minute approval flow. Updating GNO updates the packaged files;
reload the same extension directory afterward. Moving the unpacked directory
can change its Chromium extension ID and requires re-pairing.

The release also includes
`browser-extension/artifacts/gno-browser-clipper-v<VERSION>.zip` and its
adjacent `.zip.sha256`. This is a local unpacked Chromium distribution; GNO
does not claim Chrome Web Store availability or Firefox parity. See
[Browser Clipper](integrations/browser-clipper.md) for checksum, pairing,
privacy, provenance, and recovery details.

## Requirements

| Component | Version | Notes                                       |
| --------- | ------- | ------------------------------------------- |
| Bun       | 1.0+    | JavaScript runtime                          |
| macOS     | 12+     | Homebrew SQLite required for vector search  |
| Linux     | x64     | CLI supported; desktop remains experimental |
| Windows   | 11+ x64 | CLI supported; desktop packaging in beta    |

## Platform-Specific Setup

### macOS

Vector search requires Homebrew's SQLite (Apple's bundled SQLite lacks the extension API):

```bash
brew install sqlite3
```

GNO auto-detects Homebrew SQLite at `/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib`.

Run `gno doctor` to verify:

```bash
gno doctor
```

Expected output:

```
✓ config - Config loaded: ~/.config/gno/config/index.yml
✓ database - Database found: ~/.local/share/gno/index.sqlite
✓ sqlite-vec - sqlite-vec loaded (v0.1.9)
```

If sqlite-vec shows a warning, BM25 search still works but vector search is disabled.

### Linux

Current recommendation:

- `linux-x64` CLI is supported
- desktop shell on Linux is still experimental
- Ubuntu `22.04+` is the first sensible Linux desktop baseline if/when that
  path is published

No additional dependencies are required for the CLI path.

```bash
gno doctor
```

### Windows

Current recommendation:

- target `windows-x64`
- use the CLI today via Bun/global install
- treat packaged desktop artifacts as beta/runtime-validated, not broad GA
- `windows-arm64` is not supported yet

```bash
gno doctor
```

See also:

- [Packaging Matrix](PACKAGING.md)
- [Windows Support](WINDOWS.md)
- [Desktop Beta Rollout](DESKTOP-BETA-ROLLOUT.md)

## Capabilities Matrix

| Feature       | Requirements             | Command                    |
| ------------- | ------------------------ | -------------------------- |
| BM25 search   | None (works everywhere)  | `gno search <query>`       |
| Vector search | sqlite-vec extension     | `gno vsearch <query>`      |
| Hybrid search | sqlite-vec + embed model | `gno query <query>`        |
| Reranking     | rerank model cached      | `gno query` (auto-enabled) |
| AI answers    | gen model cached         | `gno ask <query> --answer` |

## Model Setup (Optional)

GNO downloads AI models on first use. Pre-download to avoid first-run delays:

```bash
# Download every role in the active slim-tuned preset
gno models pull --all

# Or download specific models
gno models pull --embed   # Required for vector search
gno models pull --rerank  # Optional, improves ranking
gno models pull --expand  # Required for local query expansion
gno models pull --gen     # Required for --answer
```

GNO validates cached/local `.gguf` files before loading them. If a network
proxy, firewall, captive portal, or Hugging Face HTML error page is cached
instead of a model, GNO removes the bad cached file and asks you to retry with
`gno models pull --force`.

Model presets select the model artifact used for each role. Actual download and
cache use depends on artifact versions, quantization, and files already cached:

| Preset     | Embed                   | Rerank                 | Expand                   | Answer        |
| ---------- | ----------------------- | ---------------------- | ------------------------ | ------------- |
| slim-tuned | Qwen3-Embedding-0.6B-Q8 | Qwen3-Reranker-0.6B-Q8 | GNO Slim Tuned expansion | Qwen3-1.7B-Q4 |
| slim       | Qwen3-Embedding-0.6B-Q8 | Qwen3-Reranker-0.6B-Q8 | Qwen3-1.7B-Q4            | Qwen3-1.7B-Q4 |
| balanced   | Qwen3-Embedding-0.6B-Q8 | Qwen3-Reranker-0.6B-Q8 | Qwen2.5-3B-Q4            | Qwen2.5-3B-Q4 |
| quality    | Qwen3-Embedding-0.6B-Q8 | Qwen3-Reranker-0.6B-Q8 | Qwen3-4B-Q4              | Qwen3-4B-Q4   |

Change preset in config:

```yaml
models:
  activePreset: slim-tuned
```

Or change it later in the web UI from the preset picker on the dashboard.

Need model overrides instead of a full preset switch?

- [Per-Collection Models](guides/per-collection-models.md)
- [Bring Your Own Models](guides/bring-your-own-models.md)
- [Code Embeddings](guides/code-embeddings.md)

The dashboard also shows:

- whether models will auto-download or stay manual/offline
- where the cache lives
- current cache size on disk
- which preset roles are still missing

## Verification

Run `gno doctor --json` to check all components:

```bash
gno doctor --json
```

```json
{
  "healthy": true,
  "activation": {
    "schemaVersion": "1.0",
    "usable": true,
    "healthy": true,
    "collections": [
      {
        "collection": "notes",
        "ready": true,
        "generatedAt": "2026-07-22T10:00:00Z",
        "stages": {
          "index": {
            "status": "passed",
            "startedAt": "2026-07-22T09:59:59Z",
            "completedAt": "2026-07-22T10:00:00Z",
            "latencyMs": 3
          },
          "lexical": {
            "status": "passed",
            "startedAt": "2026-07-22T10:00:00Z",
            "completedAt": "2026-07-22T10:00:00Z",
            "latencyMs": 2
          },
          "semantic": {
            "status": "pending",
            "startedAt": null,
            "completedAt": null,
            "latencyMs": null,
            "code": "semantic_not_checked"
          },
          "connector": {
            "status": "skipped",
            "startedAt": null,
            "completedAt": null,
            "latencyMs": null,
            "code": "connector_not_requested"
          }
        },
        "semanticAvailability": {
          "status": "pending",
          "code": "semantic_not_checked",
          "command": "gno status"
        },
        "remediation": null
      }
    ],
    "connectors": [],
    "connectorProjection": {
      "total": 0,
      "projected": 0,
      "truncated": false
    }
  },
  "checks": [
    { "name": "config", "status": "ok", "message": "Config loaded" },
    { "name": "database", "status": "ok", "message": "Database found" },
    {
      "name": "fts5-snowball",
      "status": "ok",
      "message": "fts5-snowball loaded"
    },
    { "name": "sqlite-vec", "status": "ok", "message": "sqlite-vec loaded" },
    { "name": "embed-model", "status": "ok", "message": "embed model cached" },
    {
      "name": "rerank-model",
      "status": "warn",
      "message": "rerank model not cached"
    },
    { "name": "gen-model", "status": "ok", "message": "gen model cached" },
    {
      "name": "embedding-fingerprint",
      "status": "ok",
      "message": "current abc123def456, 0 pending/stale, 0 legacy, 1 group"
    }
  ]
}
```

Status meanings:

- `ok` - Component working
- `warn` - Optional component missing (functionality limited)
- `error` - Required component failing

Doctor does not start connectors, initialize or download models, or invoke
remote inference. A failed lexical activation proof exits 2 after writing the
complete JSON result. Connector projection truncation is a warning: omitted
target/collection pairs have no claimed result, top-level `healthy` is false,
but the process still exits 0 when lexical proof and other required checks pass.

On Windows x64, `gno doctor --json` is also the quickest way to confirm the
packaged/runtime proof path: FTS5, vendored `fts5-snowball.dll`, and
`sqlite-vec` should all report `ok`.

## Troubleshooting

### "sqlite-vec not available" (macOS)

```bash
# Install Homebrew SQLite
brew install sqlite3

# Verify it's found
ls /opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib
```

### Models fail to download

Check network connectivity and available disk space. Use `gno models status`
and `gno models path` to inspect the active artifacts and real cache location;
do not infer required free space from an existing, possibly shared cache.

```bash
# Check model cache location
gno models path

# Clear and retry
gno models clear
gno models pull --all
```

### Permission errors

Ensure write access to:

- Config: `~/.config/gno/`
- Data: `~/.local/share/gno/`
- Cache: `~/Library/Caches/gno/` (macOS) or `~/.cache/gno/` (Linux)

## Uninstall

```bash
# Remove binary
bun remove -g @gmickel/gno

# Remove config and data (optional)
rm -rf ~/.config/gno
rm -rf ~/.local/share/gno
rm -rf ~/Library/Caches/gno  # macOS
rm -rf ~/.cache/gno          # Linux
```

## Next Steps

- [Quickstart Guide](QUICKSTART.md) - Index and search in 5 minutes
- [Daemon Mode](DAEMON.md) - Headless continuous indexing
- [CLI Reference](CLI.md) - Full command documentation
- [Configuration](CONFIGURATION.md) - Customize collections and settings
