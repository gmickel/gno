# T13.20: Thoroughness selector (search depth control)

**Migrated from:** gno-ub9.20
**Priority:** P2

## Description

## Summary

Add search depth control matching the web UI's ThoroughnessSelector.

## Options

| Mode     | Description       | API Params                                            |
| -------- | ----------------- | ----------------------------------------------------- |
| Fast     | BM25 only         | `noExpand: true, noRerank: true` or use `/api/search` |
| Balanced | Hybrid, no rerank | `noRerank: true`                                      |
| Thorough | Full hybrid       | default (expand + rerank)                             |

## Implementation Options

### Option A: Raycast Preference

```json
{
  "name": "searchDepth",
  "title": "Search Depth",
  "description": "Trade-off between speed and quality",
  "type": "dropdown",
  "default": "balanced",
  "data": [
    { "value": "fast", "title": "Fast (BM25)" },
    { "value": "balanced", "title": "Balanced (~2s)" },
    { "value": "thorough", "title": "Thorough (~5s)" }
  ]
}
```

### Option B: Action Menu

Add to search results ActionPanel:

- Cmd+1: Fast search
- Cmd+2: Balanced search
- Cmd+3: Thorough search

## API Mapping

```typescript
function getSearchParams(depth: "fast" | "balanced" | "thorough") {
  switch (depth) {
    case "fast":
      return { noExpand: true, noRerank: true };
    case "balanced":
      return { noRerank: true };
    case "thorough":
      return {}; // defaults
  }
}
```

## Notes

- For "fast" mode, could use `/api/search` (BM25) instead of `/api/query`
- Show timing indicator like web UI (~2s, ~5s)

## Acceptance Criteria

- [ ] Implementation complete
- [ ] Tests passing
