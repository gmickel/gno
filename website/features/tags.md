---
layout: feature
title: Tag System
headline: Classify and Filter Your Knowledge
description: Add tags to documents for instant filtering. Automatic frontmatter extraction, hierarchical tags, and powerful AND/OR filters across CLI, Web UI, and MCP.
keywords: document tags, tagging system, metadata filtering, hierarchical tags, frontmatter tags, tag autocomplete
icon: tag
slug: tags
permalink: /features/tags/
benefits:
  - Auto-extract from frontmatter
  - Hierarchical tags (project/api, status/review)
  - Filter with --tags-any (OR) or --tags-all (AND)
  - Tag autocomplete in Web UI
  - Write-back to markdown frontmatter
  - MCP tools for AI agents
commands:
  - "gno search 'query' --tags-any bug,feature"
  - "gno query 'topic' --tags-all status/active"
  - "gno tag set doc.md api,v2"
---

## What Are Tags?

Tags let you classify documents beyond their content. Filter search results by status, project, topic, or any category you define. GNO extracts tags automatically from markdown frontmatter.

```yaml
---
title: API Design Doc
tags:
  - project/api
  - status/review
  - priority/high
---
```

## Automatic Extraction

GNO reads tags from markdown frontmatter during indexing. No manual tagging required if your documents already have frontmatter.

Supported formats:

```yaml
# Array format
tags: [api, v2, internal]

# List format
tags:
  - api
  - v2
  - internal
```

## Hierarchical Tags

Use `/` to create tag hierarchies:

- `project/api`, `project/frontend`, `project/infra`
- `status/draft`, `status/review`, `status/published`
- `team/backend`, `team/design`

Hierarchical tags enable precise filtering while keeping related concepts grouped.

## Filtering Search Results

### Match Any Tag (OR)

```bash
gno search "authentication" --tags-any bug,feature
```

Returns documents tagged with `bug` OR `feature`.

### Match All Tags (AND)

```bash
gno query "API design" --tags-all status/review,priority/high
```

Returns only documents tagged with BOTH `status/review` AND `priority/high`.

### Combine with Collections

```bash
gno search "migration" -c work --tags-any urgent
```

## Managing Tags

### View Document Tags

```bash
gno tag get path/to/document.md
```

### Set Tags

```bash
gno tag set path/to/document.md api,v2,internal
```

For markdown files, GNO writes tags back to frontmatter.

### List All Tags

```bash
gno tag list
gno tag list --json
```

Shows all tags in your index with document counts.

## Web UI

The Web UI provides visual tag management:

### Tag Autocomplete

When editing documents, the tag input shows suggestions from existing tags as you type.

### Sidebar Facets

The search sidebar shows tag facets - click any tag to filter results instantly.

### Filter Chips

Active tag filters appear as removable chips above search results.

## MCP Integration

AI agents can filter searches by tags:

```json
{
  "tool": "gno_query",
  "arguments": {
    "query": "authentication flow",
    "tags_any": ["api", "security"]
  }
}
```

Available MCP tag tools:

| Tool             | Description               |
| ---------------- | ------------------------- |
| `gno_tag_list`   | List all tags with counts |
| `gno_tag_get`    | Get tags for a document   |
| `gno_tag_set`    | Set tags on a document    |
| `gno_tag_add`    | Add tags to existing      |
| `gno_tag_remove` | Remove specific tags      |

## Use Cases

- **Status tracking**: `status/draft`, `status/review`, `status/published`
- **Project organization**: `project/api`, `project/mobile`, `project/infra`
- **Priority management**: `priority/urgent`, `priority/backlog`
- **Content types**: `type/spec`, `type/meeting`, `type/decision`
- **Teams**: `team/backend`, `team/design`, `team/product`

## Getting Started

```bash
# Index documents with existing frontmatter tags
gno update

# List extracted tags
gno tag list

# Search with tag filter
gno search "topic" --tags-any project/api
```
