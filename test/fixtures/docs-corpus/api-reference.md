# API Reference

Complete reference for GNO commands and options.

## Authentication

GNO supports secure authentication for API access:

- Token-based authentication for API calls
- Session management for long-running operations
- Secure credential storage

## Search Commands

### BM25 Search

```bash
gno search <query> [options]
```

Options:
- `-n, --limit <n>` - Limit results
- `--json` - JSON output
- `--files` - URI list output

### Vector Search

```bash
gno vsearch <query> [options]
```

Requires sqlite-vec extension for vector operations.

## Collection Management

```bash
gno collection add <path> --name <name>
gno collection list
gno collection remove <name>
```

## Configuration

Configuration stored in `~/.config/gno/config.yml`:

```yaml
collections:
  - name: notes
    path: ~/notes
    pattern: "**/*.md"
```
