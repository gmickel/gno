# MCP Install Command Plan

## Overview

Add `gno mcp install` command to configure gno as an MCP server in various clients. Similar pattern to `gno skill install` but modifies JSON config files instead of copying files.

## Targets & Config Locations

### Claude Desktop

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

Format:

```json
{
  "mcpServers": {
    "gno": {
      "command": "gno",
      "args": ["mcp"]
    }
  }
}
```

### Claude Code

- **User scope**: `~/.claude.json` (mcpServers section)
- **Project scope**: `./.mcp.json` (project root)

Format (same as Desktop):

```json
{
  "mcpServers": {
    "gno": {
      "command": "gno",
      "args": ["mcp"]
    }
  }
}
```

### Codex

- **User scope**: `~/.codex.json` or similar
- **Project scope**: `./.codex/.mcp.json`

(Need to verify exact paths)

### ChatGPT Desktop

**Different model**: ChatGPT requires remote HTTPS MCP servers, not local stdio.

- Requires `ngrok` or `cloudflare tunnel` to expose local server
- Not suitable for simple `gno mcp install`
- **Skip for v1** - document manual setup in docs

## CLI Design

```bash
# Install to Claude Desktop (default)
gno mcp install

# Install to specific target
gno mcp install --target claude-desktop
gno mcp install --target claude-code
gno mcp install --target codex

# Scope (for claude-code/codex)
gno mcp install --target claude-code --scope user    # ~/.claude.json
gno mcp install --target claude-code --scope project # ./.mcp.json

# Other flags
gno mcp install --force    # Overwrite existing gno entry
gno mcp install --json     # JSON output
gno mcp install --dry-run  # Show what would be done

# Uninstall
gno mcp uninstall --target claude-desktop

# Show status
gno mcp status  # Show which targets have gno configured
```

## File Structure

```
src/cli/commands/mcp/
├── index.ts           # Command group (already exists as mcp.ts)
├── install.ts         # Install command
├── uninstall.ts       # Uninstall command
├── status.ts          # Status command
└── paths.ts           # Path resolution for all targets
```

## Implementation Details

### paths.ts

```typescript
export type McpTarget = "claude-desktop" | "claude-code" | "codex";
export type McpScope = "user" | "project";

interface McpPaths {
  configPath: string;
  serverName: string;
}

function resolveClaudeDesktopPath(): string {
  const platform = process.platform;
  const home = homedir();

  if (platform === "darwin") {
    return join(
      home,
      "Library/Application Support/Claude/claude_desktop_config.json"
    );
  } else if (platform === "win32") {
    return join(process.env.APPDATA || "", "Claude/claude_desktop_config.json");
  } else {
    return join(home, ".config/Claude/claude_desktop_config.json");
  }
}

function resolveClaudeCodePath(scope: McpScope): string {
  if (scope === "user") {
    return join(homedir(), ".claude.json");
  }
  return join(process.cwd(), ".mcp.json");
}
```

### install.ts

1. Resolve config path for target
2. Read existing config (or create empty `{}`)
3. Parse JSON safely (handle malformed files)
4. Check if `mcpServers.gno` exists
   - If exists and no `--force`, error with message
   - If exists and `--force`, warn and continue
5. Add/update `mcpServers.gno` entry
6. Write config atomically (temp file + rename)
7. Print success message with restart instructions

### Config Entry

**Critical**: Must use absolute path because Claude Desktop's PATH is limited to system dirs (`/usr/local/bin`, `/opt/homebrew/bin`, etc.) and doesn't include `~/.bun/bin` or other user paths.

```typescript
// Detect gno location at install time
function findGnoPath(): string {
  // 1. Check if running from source (dev mode)
  const scriptPath = process.argv[1];
  if (scriptPath?.includes("/gno/src/cli/")) {
    // Dev: use bun with script path
    return { command: "bun", args: ["run", scriptPath, "mcp"] };
  }

  // 2. Check `which gno` for linked/global install
  const whichResult = spawnSync("which", ["gno"]);
  if (whichResult.status === 0) {
    const gnoPath = whichResult.stdout.toString().trim();
    return { command: gnoPath, args: ["mcp"] };
  }

  // 3. Check common locations
  const candidates = [
    join(homedir(), ".bun/bin/gno"), // bun link
    "/usr/local/bin/gno", // npm -g
    "/opt/homebrew/bin/gno", // homebrew
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      return { command: path, args: ["mcp"] };
    }
  }

  // 4. Fallback to npx (works if npm installed)
  return { command: "npx", args: ["-y", "gno", "mcp"] };
}
```

### Bun Runtime Requirement

**Critical insight**: gno requires Bun runtime. The binary shebang is `#!/usr/bin/env bun`, and Claude Desktop's sandboxed PATH doesn't include user bin directories.

**Solution**: Always use absolute path to bun + script/bunx:

```typescript
function findBunPath(): string | null {
  // 1. Check `which bun`
  const whichResult = spawnSync("which", ["bun"]);
  if (whichResult.status === 0) {
    return whichResult.stdout.toString().trim();
  }

  // 2. Check common locations
  const candidates = [
    join(homedir(), ".bun/bin/bun"),
    "/usr/local/bin/bun",
    "/opt/homebrew/bin/bun",
    // mise/asdf managed
    ...glob.sync(join(homedir(), ".local/share/mise/installs/bun/*/bin/bun")),
  ];

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }

  return null;
}
```

Example output configs:

```json
// Dev mode (source checkout)
{
  "command": "/Users/gordon/.local/share/mise/installs/bun/1.3.5/bin/bun",
  "args": ["run", "/Users/gordon/work/gno/src/cli/index.ts", "mcp"]
}

// bun global install
{
  "command": "/Users/gordon/.bun/bin/bun",
  "args": ["x", "gno", "mcp"]
}

// npm global (still needs bun runtime)
{
  "command": "/path/to/bun",
  "args": ["/usr/local/lib/node_modules/gno/src/index.ts", "mcp"]
}
```

**Error case**: If bun not found, `gno mcp install` should error with clear message:

```
Error: Bun runtime not found. Install bun first: curl -fsSL https://bun.sh/install | bash
```

### Safety Checks

1. Validate JSON before modifying
2. Create backup before overwriting (`config.json.bak`)
3. Atomic write via temp file
4. Don't delete other mcpServers entries

## Tasks

### Implementation

1. **T1**: Create `src/cli/commands/mcp/paths.ts` - Path resolution
2. **T2**: Create `src/cli/commands/mcp/install.ts` - Install logic
3. **T3**: Create `src/cli/commands/mcp/uninstall.ts` - Remove gno entry
4. **T4**: Create `src/cli/commands/mcp/status.ts` - Show configured targets
5. **T5**: Update `src/cli/commands/mcp/index.ts` - Command group
6. **T6**: Tests for path resolution
7. **T7**: Tests for install/uninstall

### Documentation Updates

8. **T8**: Update `spec/mcp.md`
   - Fix tool names: `gno.search` → `gno_search` (all 6 tools)
   - Add `gno mcp install` command section
   - Add `gno mcp uninstall` command section
   - Add `gno mcp status` command section

9. **T9**: Update `spec/cli.md`
   - Add `mcp install` to command list and output format matrix
   - Add `mcp uninstall` to command list
   - Add `mcp status` to command list
   - Add full command specifications (synopsis, options, output)

10. **T10**: Update `website/features/mcp-integration.md`
    - Replace manual JSON setup with `gno mcp install` as primary method
    - Keep manual setup as "Advanced" or fallback section
    - Fix tool names in table: `search` → `gno_search` format
    - Add supported targets (Claude Desktop, Claude Code, Codex)

11. **T11**: Update `assets/skill/cli-reference.md`
    - Add MCP section with `gno mcp`, `gno mcp install`, `gno mcp uninstall`, `gno mcp status`

12. **T12**: Update `assets/skill/mcp-reference.md` (if exists)
    - Fix tool names to underscore format

## Documentation Changes Summary

| File                                  | Changes                                                    |
| ------------------------------------- | ---------------------------------------------------------- |
| `spec/mcp.md`                         | Tool names `gno.X` → `gno_X`, add install/uninstall/status |
| `spec/cli.md`                         | Add mcp subcommands to matrix and specs                    |
| `website/features/mcp-integration.md` | Primary setup via `gno mcp install`, fix tool names        |
| `assets/skill/cli-reference.md`       | Add MCP commands section                                   |

## References

- [Claude Desktop MCP Setup](https://www.mcpbundles.com/blog/claude-desktop-mcp)
- [Claude Code MCP Config](https://code.claude.com/docs/en/mcp)
- [MCP Connect Local Servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers)
- Existing skill install: `src/cli/commands/skill/`
