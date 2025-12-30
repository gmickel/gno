# GNO Agent Skill System

Create a skill distribution system that enables AI agents (Claude Code, Codex) to use GNO perfectly.

## Overview

GNO needs to be installable as an Agent Skill so that CLI-based AI agents can:
- Initialize and configure GNO indexes
- Search documents (BM25, vector, hybrid)
- Get AI-powered answers with citations
- Set up MCP server integration

The system consists of:
1. **SKILL.md** - Core skill file with frontmatter + instructions
2. **Reference files** - CLI reference, MCP reference, examples (progressive disclosure)
3. **`gno skill install`** - CLI command to install skill to target agent

## Scope

**In Scope**:
- SKILL.md following Claude Code skills spec
- `gno skill install` command with `--scope` (project|user) and `--target` (claude|codex|all)
- `gno skill uninstall` command with path safety guards
- Supporting reference files for progressive disclosure
- Injectable path resolver for testability

**Out of Scope**:
- Cursor/Windsurf/other agent support (future)
- Auto-updating claude_desktop_config.json for MCP
- Skill versioning/upgrade detection
- Interactive merge mode
- Section markers / partial merges (full directory overwrite only)

## Approach

### Phase 1: Skill Content Files

Skill files shipped in package, copied on install:

```plaintext
assets/skill/
├── SKILL.md              # Core instructions + frontmatter (< 500 lines)
├── cli-reference.md      # Full CLI command reference
├── mcp-reference.md      # MCP tools/resources reference
└── examples.md           # Real-world usage examples
```

**SKILL.md Structure** (following flow-plan/flow-work pattern):

```yaml
---
name: gno
description: Local semantic search for documents. Initialize indexes, search with BM25/vector/hybrid, get AI answers with citations. Use when searching files, indexing documents, querying knowledge bases, or setting up MCP.
allowed-tools: Bash(gno:*), Read
---

# GNO - Local Document Search

Fast local semantic search for your documents.

**Role**: document search assistant
**Goal**: help users index, search, and query their documents

## Quick Start

1. Initialize: `gno init`
2. Index: `gno update`
3. Search: `gno search "your query"`

## Core Commands

- `gno init` - Initialize index in current directory
- `gno update` - Re-index documents
- `gno search <query>` - Search with BM25 (default)
- `gno search <query> --mode vector` - Semantic search
- `gno ask <question>` - AI-powered Q&A with citations

## Reference

For complete CLI details, see [cli-reference.md](cli-reference.md).
For MCP server setup, see [mcp-reference.md](mcp-reference.md).
For usage examples, see [examples.md](examples.md).
```

**Key points from skills docs**:
- `name` and `description` required in frontmatter
- `allowed-tools` is **experimental** per Agent Skills spec - Claude Code supports it, Codex support unclear
- Keep SKILL.md under 500 lines - detailed docs in reference files
- Reference files loaded via progressive disclosure when needed
- Description is crucial for triggering - include keywords users would say

### Phase 2: Path Resolution Module

Centralized path resolver with injection for testability:

```ts
// src/cli/commands/skill/paths.ts

interface SkillPathOptions {
  scope: 'project' | 'user';
  target: 'claude' | 'codex';
  cwd?: string;           // Override for project scope
  homeDir?: string;       // Override for user scope (tests)
}

interface SkillPaths {
  base: string;           // e.g., ~/.claude or ./.claude
  skillsDir: string;      // e.g., ~/.claude/skills
  gnoDir: string;         // e.g., ~/.claude/skills/gno
}

export function resolveSkillPaths(opts: SkillPathOptions): SkillPaths;

// Environment overrides for CI/debugging:
// - GNO_SKILLS_HOME_OVERRIDE: override home dir for user scope
// - CLAUDE_SKILLS_DIR: override Claude skills directory
// - CODEX_SKILLS_DIR: override Codex skills directory
```

**Target Paths** (defaults, overridable):

| Target | Scope | Default Path |
|--------|-------|--------------|
| Claude Code | project | `<cwd>/.claude/skills/gno/` |
| Claude Code | user | `~/.claude/skills/gno/` |
| Codex | project | `<cwd>/.codex/skills/gno/` |
| Codex | user | `~/.codex/skills/gno/` |

### Phase 3: Install Command

New command group: `gno skill`

**`gno skill install`**:
```bash
gno skill install [--scope <project|user>] [--target <claude|codex|all>]

Options:
  --scope   project  Install to .claude/skills/ or .codex/skills/ (default)
            user     Install to ~/.claude/skills/ or ~/.codex/skills/
  --target  claude   Claude Code only (default)
            codex    Codex only
            all      Both Claude Code and Codex
  --force            Overwrite existing skill without prompting

Global flags honored:
  --yes              Same as --force (suppress prompts)
  --quiet            Suppress non-essential output
  --json             Output result as JSON (uses CliError envelope on failure)
```

**Install Algorithm** (atomic, Windows-safe):
1. Resolve source path via `import.meta.dir` → `assets/skill/`
2. Resolve dest paths via `resolveSkillPaths()`
3. If dest exists and not (`--force` || `--yes`): throw `CliError('VALIDATION', 'Skill already installed. Use --force to overwrite.')`
4. Create temp dir as sibling: `<skillsDir>/.gno-skill.tmp.<random>`
5. Copy all files from source to temp dir
6. If dest exists: remove with retry (Windows-safe, like `safeRm()`)
7. Rename temp dir → dest dir
8. On failure: best-effort cleanup temp dir
9. Output success message (or JSON if `--json`)

**`gno skill uninstall`**:
```bash
gno skill uninstall [--scope <project|user>] [--target <claude|codex|all>]
```

**Uninstall Safety Checks** (critical):
1. Resolve `destDir` via `resolveSkillPaths()`
2. Normalize to absolute path via `realpath` where possible
3. **Reject if**:
   - `destDir` doesn't end with expected suffix (`/skills/gno` or `\skills\gno`)
   - `destDir` length < 20 chars (sanity check)
   - `destDir` equals base dir
   - `destDir` is not inside expected base (prefix check on normalized paths)
4. Only then: remove directory with retry (Windows-safe)

**`gno skill show`**:
```bash
gno skill show [--file <name>]   # Preview skill files

Options:
  --file    SKILL.md         Show specific file (default: SKILL.md)
            cli-reference.md
            mcp-reference.md
            examples.md
            --all            Show all files with separators

Output:
  Without --file: prints SKILL.md content
  With --file: prints specified file
  With --all: prints all files with "--- <filename> ---" separators
  Always lists available files at end: "Files: SKILL.md, cli-reference.md, ..."
```

**`gno skill paths`** (debugging helper):
```bash
gno skill paths [--scope <project|user>] [--target <claude|codex|all>] [--json]

Output: Shows resolved paths for each target without installing
```

### Phase 4: Implementation

**File Structure**:
```plaintext
assets/skill/                    # Skill files shipped with package
├── SKILL.md
├── cli-reference.md
├── mcp-reference.md
└── examples.md

src/cli/commands/skill/
├── paths.ts        # Path resolution with injection
├── install.ts      # Install command
├── uninstall.ts    # Uninstall command (with safety guards)
├── show.ts         # Show/preview command
├── paths-cmd.ts    # Paths debugging command
└── index.ts        # Subcommand wiring
```

**Ensure files ship with package** (package.json):
```jsonc
{
  "files": [
    "dist",
    "assets"
  ]
}
```

**Locate source files at runtime**:
```ts
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Works in both dev and after Bun build
const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_SOURCE_DIR = join(__dirname, '../../assets/skill');
```

**Error Handling** (follow existing patterns):
- Validation errors (bad args, existing install): `throw new CliError('VALIDATION', message)`
- IO failures: `throw new CliError('RUNTIME', message)`
- Let `run.ts` handle exit codes and `--json` error envelopes
- Output to stdout; diagnostics to stderr via `src/cli/ui.ts` patterns

**Wire into program.ts**:
```ts
// In wireManagementCommands() or similar
const skillCmd = program.command('skill').description('Manage GNO agent skill');

skillCmd.command('install')
  .option('--scope <scope>', 'project or user', 'project')
  .option('--target <target>', 'claude, codex, or all', 'claude')
  .option('--force', 'Overwrite existing skill')
  .action(async (opts) => {
    const { installSkill } = await import('./skill/install.js');
    await installSkill(opts);
  });

// Similar for uninstall, show, paths
```

## Key Decisions

1. **Skill directory structure**: Flat files (`gno/SKILL.md` + refs) matching flow-plan/flow-work pattern
2. **Merge strategy**: Overwrite entire skill directory (atomic via temp+rename), no partial merges
3. **Content source**: Files shipped in `assets/skill/`, located via `import.meta.url`
4. **Progressive disclosure**: SKILL.md < 500 lines, reference files for details
5. **MCP config**: Instructions only, no auto-edit of claude_desktop_config.json
6. **Path resolution**: Centralized module with injection + env overrides for testability
7. **Safety**: Strict path validation before any rm operations

## Acceptance Criteria

- [ ] `gno skill install` creates skill directory with SKILL.md + reference files
- [ ] `gno skill install --scope user --target all` installs to both ~/.claude and ~/.codex
- [ ] `gno skill uninstall` removes skill directory cleanly with safety guards
- [ ] `gno skill show` outputs SKILL.md; `--file` and `--all` work
- [ ] `gno skill paths` shows resolved paths for debugging
- [ ] Skill triggers correctly when user asks about searching/indexing documents
- [ ] Reference files load via progressive disclosure when agent needs details
- [ ] Works on macOS, Linux, Windows (path handling)
- [ ] Honors global flags: `--yes` (like --force), `--quiet`, `--json`
- [ ] Throws `CliError` for proper exit codes and JSON envelopes
- [ ] Spec updated at spec/cli.md before implementation
- [ ] Tests cover install/uninstall/show commands with path injection
- [ ] `assets/skill/` included in package.json files

## Test Plan

1. **Unit tests** (all use injected paths, never touch real HOME):
   - `resolveSkillPaths()` returns correct paths for all scope/target combos
   - `resolveSkillPaths()` respects env overrides
   - Install copies all files from source
   - Uninstall safety: rejects paths that don't match expected pattern
   - Show outputs correct file content

2. **Integration tests** (use temp dirs via `homeDirOverride`):
   - Install to project scope → verify `<tmpCwd>/.claude/skills/gno/SKILL.md` exists
   - Install to user scope → verify `<tmpHome>/.claude/skills/gno/SKILL.md` exists
   - Install twice without --force → error
   - Install with --force → overwrites
   - Uninstall removes directory
   - Atomic install: partial failure leaves no partial state

3. **Manual verification**:
   - Load skill in Claude Code, test trigger phrases
   - Verify skill triggers on "how do I search documents" etc.
   - Verify reference files load when Claude needs CLI details

## Risks

| Risk | Mitigation |
|------|------------|
| Claude Code/Codex paths change | Centralized resolver + env overrides, easy to update |
| Skill doesn't trigger | Strong description with keywords; test manually |
| Reference files bloat context | Keep focused; SKILL.md < 500 lines |
| Windows path/locking issues | Use atomic temp+rename pattern; retry on EBUSY |
| Source files missing after install | Verify `assets/` in package.json files; integration test |
| Unsafe uninstall | Strict path validation before any rm |

## Dependencies

- None external
- Uses existing: `Bun.write()`, `node:fs/promises` mkdir/rm, `node:path` utilities
- Reuse patterns from: `safeRm()`, `saveConfigToPath()` atomic writes

## References

- CLI command pattern: `src/cli/commands/init.ts`
- Config paths: `src/app/constants.ts`
- File operations: `src/config/saver.ts`
- Existing skill structure: `~/.claude/skills/convex/`, flow-plan, flow-work
- Error handling: `src/cli/errors.ts` (CliError)
- Spec location: `spec/cli.md` (must update first)
- Claude Code skills: <https://docs.anthropic.com/en/docs/claude-code/skills>

## Tasks

1. **Update spec/cli.md** - Add `gno skill` command group (install/uninstall/show/paths)
2. **Create assets/skill/SKILL.md** - Core skill (< 500 lines, strong description)
3. **Create assets/skill/cli-reference.md** - Full CLI reference
4. **Create assets/skill/mcp-reference.md** - MCP setup reference
5. **Create assets/skill/examples.md** - Usage examples
6. **Update package.json** - Add `assets` to files array
7. **Implement src/cli/commands/skill/paths.ts** - Path resolver with injection + env overrides
8. **Implement src/cli/commands/skill/install.ts** - Atomic install with Windows-safe temp+rename
9. **Implement src/cli/commands/skill/uninstall.ts** - Safe uninstall with path validation
10. **Implement src/cli/commands/skill/show.ts** - Show with --file and --all options
11. **Implement src/cli/commands/skill/paths-cmd.ts** - Debug command for path resolution
12. **Wire commands in program.ts** - Add skill subcommand group following existing patterns
13. **Write tests** - Unit + integration with path injection
14. **Manual test** - Verify skill triggers in Claude Code
