# Phase 6: Link Documentation & Website

**Migrated from:** gno-d0v
**Original type:** task
**Priority:** P1

---

Documentation for Note Linking feature (following tags docs pattern exactly).

## High Priority (Core User Experience)

### Specs

- [ ] spec/cli.md - Add `gno links`, `gno backlinks`, `gno similar` commands
- [ ] spec/mcp.md - Add `gno_links`, `gno_backlinks`, `gno_similar` tools
- [ ] spec/db/schema.sql - Document doc_links table
- [ ] spec/output-schemas/links-list.schema.json (NEW)
- [ ] spec/output-schemas/backlinks.schema.json (NEW)
- [ ] spec/output-schemas/similar.schema.json (NEW)

### User Docs

- [ ] docs/CLI.md - Link commands section with examples
- [ ] docs/API.md - /api/doc/:id/links, /backlinks, /similar endpoints
- [ ] docs/MCP.md - gno_links, gno_backlinks, gno_similar tool examples
- [ ] docs/WEB-UI.md - Backlinks panel, Related Notes sidebar, [[autocomplete
- [ ] docs/QUICKSTART.md - Note linking workflow example

### Root

- [ ] README.md - Add note linking to feature list
- [ ] CHANGELOG.md - Add to [Unreleased]

## Medium Priority (Website & Marketing)

### Website Features

- [ ] website/\_data/features.yml - Add Note Linking feature entry
- [ ] website/\_layouts/home.html - Add Note Linking to features grid
- [ ] website/features/note-linking.md (NEW) - Dedicated feature page
- [ ] website/features/hybrid-search.md - Mention similar docs uses same pipeline
- [ ] website/features/web-ui.md - Backlinks/related notes section
- [ ] website/index.md - Feature highlights if prominent

### Skill/Agent Docs

- [ ] assets/skill/SKILL.md - Add link tools, use cases for AI agents
- [ ] assets/skill/cli-reference.md - gno links/backlinks/similar commands
- [ ] assets/skill/mcp-reference.md - gno_links, gno_backlinks, gno_similar tools
- [ ] assets/skill/examples.md - Note linking workflow example

## Lower Priority (Context & Glossary)

- [ ] docs/GLOSSARY.md - Wiki link, Backlink, Similar docs definitions
- [ ] docs/HOW-SEARCH-WORKS.md - Similar docs algorithm section
- [ ] docs/TROUBLESHOOTING.md - Link-related issues (broken links, resolution)

## Internal Docs

- [ ] src/core/CLAUDE.md or comment - Link parsing patterns
- [ ] src/cli/CLAUDE.md - Link command implementation notes
- [ ] src/mcp/CLAUDE.md - Link tool implementation notes
- [ ] src/serve/CLAUDE.md - REST/WebUI link state, caching
- [ ] test/CLAUDE.md - Link contract test patterns

## Documentation Templates

### CLI Command (from tags pattern)

```markdown
### gno links

List outgoing links from a document.

**Synopsis:**

\`\`\`bash
gno links [list] <doc> [--type <wiki|markdown|url>] [--json] [--md]
\`\`\`

**Arguments:**

- `<doc>` - Document reference (docid #abc123 or URI gno://collection/path)

**Options:**

| Option   | Type   | Default | Description         |
| -------- | ------ | ------- | ------------------- |
| `--type` | string | all     | Filter by link type |
| `--json` | flag   |         | JSON output         |
| `--md`   | flag   |         | Markdown output     |

**Examples:**

\`\`\`bash

# List all links

gno links '#abc123'

# JSON output

gno links 'gno://notes/doc.md' --json

# Wiki links only

gno links '#abc123' --type wiki
\`\`\`
```

### API Endpoint (from tags pattern)

```markdown
### Get Document Links

\`\`\`http
GET /api/doc/:id/links?type=wiki
\`\`\`

Returns outgoing links from a document.

**Path Parameters:**

| Param | Type   | Description |
| :---- | :----- | :---------- |
| `id`  | string | Document ID |

**Query Parameters:**

| Param  | Type   | Default | Description                 |
| :----- | :----- | :------ | :-------------------------- |
| `type` | string | all     | Filter: wiki, markdown, url |

**Response:**

\`\`\`json
{
"links": [
{ "targetPath": "other.md", "linkType": "wiki", "targetDocid": "#xyz789" }
],
"meta": { "totalLinks": 1, "docid": "#abc123" }
}
\`\`\`
```

## Acceptance Criteria

- [ ] All spec files updated with correct formats
- [ ] All user docs updated with examples
- [ ] README.md mentions note linking feature
- [ ] Website has Note Linking feature page
- [ ] Home page features grid includes Note Linking
- [ ] Skill docs enable AI agents to use link tools
- [ ] CHANGELOG.md updated
- [ ] No stale docs referencing old behavior
- [ ] All internal CLAUDE.md files updated
