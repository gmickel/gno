# Troubleshooting Guide

Common issues and solutions for GNO.

## Error Messages

### "Collection not found"

This error occurs when searching a non-existent collection:

```
Error: Collection 'mydata' not found
```

**Solution**: List collections with `gno collection list` and verify the name.

### "sqlite-vec not available"

Vector search requires the sqlite-vec extension:

```
Error: sqlite-vec extension not loaded
```

**Solution**: On macOS, install Homebrew SQLite:
```bash
brew install sqlite
```

### "No documents indexed"

Search returns empty when no content is indexed:

**Solution**: Run `gno update` to index your collections.

## Diagnostics

Run `gno doctor` to check system health:

```bash
gno doctor --json
```

This checks:
- Configuration validity
- Database accessibility
- Extension availability
- Model cache status

## Performance Issues

### Slow Indexing

Large collections may take time to index. Tips:
- Use specific patterns (`--pattern "*.md"`)
- Exclude large directories (`--exclude node_modules`)

### Search Latency

If search is slow:
- Check index size with `gno stats`
- Consider using BM25 instead of vector search for speed
