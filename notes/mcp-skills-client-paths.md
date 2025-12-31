# MCP & Skills Client Integration Paths

Research for extending `gno mcp install` and `gno skill install` to support additional AI clients.

## Summary

| Client | MCP Config | Skills | Project Scope |
|--------|------------|--------|---------------|
| Claude Desktop | ✅ | ❌ | ❌ |
| Claude Code | ✅ | ✅ | ✅ |
| Codex | ✅ | ❌ | ✅ |
| **Cursor** | ✅ | ❌ | ✅ |
| **Zed** | ✅ | ❌ | ❌ |
| **Windsurf** | ✅ | ❌ | ❌ |
| **OpenCode** | ✅ | ✅ | ✅ |
| **Amp** | ✅ | ✅ | ✅ |
| **Warp** | ⚠️ UI-only | ❌ | ❌ |
| **LM Studio** | ✅ | ❌ | ❌ |

---

## MCP Configuration Paths

### Cursor

**Type**: `McpTarget = 'cursor'`

| Scope | Platform | Path |
|-------|----------|------|
| user | macOS/Linux | `~/.cursor/mcp.json` |
| user | Windows | `%USERPROFILE%\.cursor\mcp.json` |
| project | all | `.cursor/mcp.json` |

**Config format** (same as Claude Desktop):
```json
{
  "mcpServers": {
    "gno": {
      "command": "/path/to/bun",
      "args": ["/path/to/gno", "mcp"]
    }
  }
}
```

**Notes**:
- Project-level config reported buggy in some versions
- Supports project scope ✅

**Source**: [Cursor MCP Docs](https://cursor.com/docs/context/mcp)

---

### Zed

**Type**: `McpTarget = 'zed'`

| Scope | Platform | Path |
|-------|----------|------|
| user | macOS | `~/.config/zed/settings.json` |
| user | Linux | `$XDG_CONFIG_HOME/zed/settings.json` or `~/.config/zed/settings.json` |
| user | Windows | N/A (Zed not available on Windows) |

**Config format** (different key - `context_servers`, not `mcpServers`):
```json
{
  "context_servers": {
    "gno": {
      "command": "/path/to/bun",
      "args": ["/path/to/gno", "mcp"]
    }
  }
}
```

**Notes**:
- Uses `context_servers` key, not `mcpServers`
- Config is within main settings.json, need to merge carefully
- No project scope support
- No Windows support (Zed is macOS/Linux only)

**Source**: [Zed MCP Docs](https://zed.dev/docs/ai/mcp)

---

### Windsurf

**Type**: `McpTarget = 'windsurf'`

| Scope | Platform | Path |
|-------|----------|------|
| user | macOS/Linux | `~/.codeium/windsurf/mcp_config.json` |
| user | Windows | `%USERPROFILE%\.codeium\windsurf\mcp_config.json` |

**Config format** (same as Claude Desktop):
```json
{
  "mcpServers": {
    "gno": {
      "command": "/path/to/bun",
      "args": ["/path/to/gno", "mcp"]
    }
  }
}
```

**Notes**:
- No project scope documented
- Same format as Claude Desktop

**Source**: [Windsurf MCP Docs](https://docs.windsurf.com/windsurf/cascade/mcp)

---

### OpenCode

**Type**: `McpTarget = 'opencode'`

| Scope | Platform | Path |
|-------|----------|------|
| user | macOS/Linux | `~/.config/opencode/config.json` |
| user | Windows | `%USERPROFILE%\.config\opencode\config.json` |
| project | all | `opencode.json` or `opencode.jsonc` |

**Config format** (different - uses `mcp` key with nested structure):
```json
{
  "mcp": {
    "gno": {
      "type": "local",
      "command": ["/path/to/bun", "/path/to/gno", "mcp"],
      "enabled": true
    }
  }
}
```

**Notes**:
- Uses `mcp` key, not `mcpServers`
- `command` is an array, not separate `command` + `args`
- Has `type: "local"` field
- Supports project scope ✅

**Source**: [OpenCode MCP Docs](https://opencode.ai/docs/mcp-servers/)

---

### Amp (Sourcegraph)

**Type**: `McpTarget = 'amp'`

| Scope | Platform | Path |
|-------|----------|------|
| user | macOS/Linux | `~/.config/amp/settings.json` |
| user | Windows | `%USERPROFILE%\.config\amp\settings.json` |

**Config format** (different key - `amp.mcpServers`):
```json
{
  "amp.mcpServers": {
    "gno": {
      "command": "/path/to/bun",
      "args": ["/path/to/gno", "mcp"]
    }
  }
}
```

**Notes**:
- Uses `amp.mcpServers` key
- Config is within main settings.json, need to merge carefully
- CLI alternative: `amp mcp add gno <url>`

**Source**: [Amp Manual](https://ampcode.com/manual)

---

### Warp

**Type**: `McpTarget = 'warp'` (⚠️ special handling needed)

| Scope | Platform | Path |
|-------|----------|------|
| - | - | No standard config file |

**Notes**:
- **Primarily UI-driven** - no single config file to modify
- Can pass via CLI: `warp --mcp '{"mcpServers": {...}}'` or `warp --mcp ./config.json`
- Agent configs use `warp-agent.json` but that's for agents, not general MCP
- MCP data stored in platform-specific locations (for logs, not config):
  - macOS: `~/Library/Group Containers/2BBY89MBSN.dev.warp/...`
  - Linux: `~/.local/state/warp-terminal/mcp`
  - Windows: `%LOCALAPPDATA%\warp\Warp\data\logs\mcp`

**Recommendation**: Skip automated install, document manual UI setup instead.

**Source**: [Warp MCP Docs](https://docs.warp.dev/knowledge-and-collaboration/mcp)

---

### LM Studio

**Type**: `McpTarget = 'lmstudio'`

| Scope | Platform | Path |
|-------|----------|------|
| user | macOS/Linux | `~/.lmstudio/mcp.json` |
| user | Windows | `%USERPROFILE%\.lmstudio\mcp.json` |

**Config format** (same as Cursor/Claude Desktop):
```json
{
  "mcpServers": {
    "gno": {
      "command": "/path/to/bun",
      "args": ["/path/to/gno", "mcp"]
    }
  }
}
```

**Notes**:
- Uses Cursor's mcp.json notation
- Auto-reloads on file save
- No project scope

**Source**: [LM Studio MCP Docs](https://lmstudio.ai/docs/app/mcp)

---

## Skills Paths

### OpenCode Skills

| Scope | Path |
|-------|------|
| project | `.opencode/skill/<name>/SKILL.md` |
| user | `~/.config/opencode/skill/<name>/SKILL.md` |
| compat | `.claude/skills/<name>/SKILL.md` (reads Claude skills!) |

**Format**: SKILL.md with YAML frontmatter
```markdown
---
name: gno
description: Search local knowledge base
---

# GNO Skill

Instructions for using gno...
```

**Notes**:
- OpenCode already reads `.claude/skills/` - may work automatically!
- Name must match folder name
- Pattern: lowercase alphanumeric with hyphens

**Source**: [OpenCode Skills Docs](https://opencode.ai/docs/skills/)

---

### Amp Skills

| Scope | Path |
|-------|------|
| project | `.agents/skills/<name>/SKILL.md` |
| user | `~/.config/agents/skills/<name>/SKILL.md` |
| compat | `.claude/skills/<name>/SKILL.md` (reads Claude skills!) |

**Format**: Same SKILL.md format as OpenCode

**CLI**:
```bash
amp skill add <repo/name>
amp skill list
amp skill remove <name>
```

**Notes**:
- Amp also reads `.claude/skills/` - may work automatically!
- Same format as OpenCode and Claude Code

**Source**: [Amp Manual](https://ampcode.com/manual)

---

## Implementation Notes

### Config Format Groups

**Group A - Standard `mcpServers` format**:
- Claude Desktop, Claude Code, Codex
- Cursor
- Windsurf
- LM Studio

**Group B - Different key/format**:
- Zed: `context_servers` key
- OpenCode: `mcp` key with array command
- Amp: `amp.mcpServers` key

**Group C - Special handling**:
- Warp: UI-only, skip automated install

### Skills Compatibility

Both OpenCode and Amp read from `.claude/skills/`, so existing gno skill installation for Claude Code may already work! Test before adding explicit support.

### Type Definitions

```typescript
type McpTarget =
  | 'claude-desktop'
  | 'claude-code'
  | 'codex'
  | 'cursor'
  | 'zed'
  | 'windsurf'
  | 'opencode'
  | 'amp'
  // | 'warp'  // Skip - UI only
  | 'lmstudio';

type McpScope = 'user' | 'project';

// Targets supporting project scope
const TARGETS_WITH_PROJECT_SCOPE: McpTarget[] = [
  'claude-code',
  'codex',
  'cursor',
  'opencode',
];

// Targets with non-standard config format
const TARGETS_WITH_CUSTOM_FORMAT: McpTarget[] = [
  'zed',      // context_servers
  'opencode', // mcp + array command
  'amp',      // amp.mcpServers
];
```

---

## Documentation Updates Needed

After implementation:

1. **docs/MCP.md** - Add new targets to setup instructions
2. **spec/cli.md** - Add new `--target` values
3. **website/features/mcp-integration.md** - Update supported clients list
4. **assets/skill/cli-reference.md** - Update MCP section

For skills:
1. **docs/SKILLS.md** or equivalent - Note OpenCode/Amp compatibility
2. Test if `.claude/skills/gno/` works in OpenCode and Amp without changes
