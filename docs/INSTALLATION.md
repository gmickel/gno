# Installation

GNO requires [Bun](https://bun.sh/) as its JavaScript runtime.

## Quick Install

```bash
# Install Bun (if not already installed)
curl -fsSL https://bun.sh/install | bash

# Install GNO
bun install -g @gmickel/gno

# Verify installation
gno doctor
```

## Requirements

| Component | Version | Notes |
|-----------|---------|-------|
| Bun | 1.0+ | JavaScript runtime |
| macOS | 12+ | Homebrew SQLite required for vector search |
| Linux | Any | Works out of box |
| Windows | 10+ | Experimental, some tests may fail |

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
✓ config - Config loaded: ~/.config/gno/config.yml
✓ database - Database found: ~/.local/share/gno/index.sqlite
✓ sqlite-vec - sqlite-vec loaded (vv0.1.7-alpha.2)
```

If sqlite-vec shows a warning, BM25 search still works but vector search is disabled.

### Linux

Works out of box. No additional dependencies needed.

```bash
gno doctor
```

### Windows

Experimental support. Core functionality works, but some tests may fail.

```bash
gno doctor
```

## Capabilities Matrix

| Feature | Requirements | Command |
|---------|--------------|---------|
| BM25 search | None (works everywhere) | `gno search <query>` |
| Vector search | sqlite-vec extension | `gno vsearch <query>` |
| Hybrid search | sqlite-vec + embed model | `gno query <query>` |
| Reranking | rerank model cached | `gno query` (auto-enabled) |
| AI answers | gen model cached | `gno ask <query> --answer` |

## Model Setup (Optional)

GNO downloads AI models on first use. Pre-download to avoid first-run delays:

```bash
# Download all models (slim preset, ~1GB)
gno models pull --all

# Or download specific models
gno models pull --embed   # Required for vector search
gno models pull --rerank  # Optional, improves ranking
gno models pull --gen     # Required for --answer
```

Model presets control disk usage:

| Preset | Disk | Embed | Rerank | Gen |
|--------|------|-------|--------|-----|
| slim | ~1GB | bge-m3-Q4 | bge-reranker-v2-m3-Q4 | Qwen3-1.7B-Q4 |
| balanced | ~2GB | bge-m3-Q4 | bge-reranker-v2-m3-Q4 | SmolLM3-3B-Q4 |
| quality | ~2.5GB | bge-m3-Q4 | bge-reranker-v2-m3-Q4 | Qwen3-4B-Q4 |

Change preset in config:
```yaml
models:
  activePreset: balanced
```

## Verification

Run `gno doctor --json` to check all components:

```bash
gno doctor --json
```

```json
{
  "healthy": true,
  "checks": [
    { "name": "config", "status": "ok", "message": "Config loaded" },
    { "name": "database", "status": "ok", "message": "Database found" },
    { "name": "sqlite-vec", "status": "ok", "message": "sqlite-vec loaded" },
    { "name": "embed-model", "status": "ok", "message": "embed model cached" },
    { "name": "rerank-model", "status": "warn", "message": "rerank model not cached" },
    { "name": "gen-model", "status": "ok", "message": "gen model cached" }
  ]
}
```

Status meanings:
- `ok` - Component working
- `warn` - Optional component missing (functionality limited)
- `error` - Required component failing

## Troubleshooting

### "sqlite-vec not available" (macOS)

```bash
# Install Homebrew SQLite
brew install sqlite3

# Verify it's found
ls /opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib
```

### Models fail to download

Check network connectivity and disk space (~2GB needed for all models).

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
- [CLI Reference](CLI.md) - Full command documentation
- [Configuration](CONFIGURATION.md) - Customize collections and settings
