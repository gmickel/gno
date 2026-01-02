# Skills Integration

Use GNO as a skill in AI coding agents like Claude Code, OpenCode, Amp, OpenAI Codex, VS Code Copilot, and Cursor.

> **Why Skills?** Skills are the preferred integration method due to progressive discovery: tools are only loaded when invoked via `/gno`, avoiding context pollution from unused tool definitions. See [agentskills.io](https://agentskills.io/home) for the specification.
>
> Skills work in any client that supports the spec. OpenCode and Amp use the same `.claude` path as Claude Code. VS Code Copilot and Cursor require manual setup (see below).

## Quick Install

```bash
gno skill install --scope user          # Claude Code (default)
gno skill install --target codex        # OpenAI Codex CLI
gno skill install --target all          # Both targets
```

## Supported Targets

| Target   | Command                            | Config Location           | Also Works With |
| :------- | :--------------------------------- | :------------------------ | :-------------- |
| `claude` | `gno skill install`                | `~/.claude/settings.json` | OpenCode, Amp   |
| `codex`  | `gno skill install --target codex` | `~/.codex/config.json`    |                 |
| `all`    | `gno skill install --target all`   | Both locations            |                 |

## Scope Options

| Scope     | Flag              | Description                        |
| :-------- | :---------------- | :--------------------------------- |
| `project` | `--scope project` | Install to current directory only  |
| `user`    | `--scope user`    | Install for all projects (default) |

## Using the Skill

Once installed, use the `/gno` slash command:

```
/gno search "authentication patterns"
/gno query "how does our API handle errors"
/gno status
```

Or just ask your agent naturally:

> "Search my notes for the auth discussion"

## Commands

```bash
gno skill install [options]    # Install skill
gno skill uninstall [options]  # Remove skill
gno skill show [options]       # Preview skill files
gno skill paths [options]      # Show installation paths
```

## Example Workflows

**Research while coding:**

```
/gno query "error handling best practices"
```

**Find related docs:**

> "Search my notes for anything about the feature I'm working on"

**Get context:**

> "Find my architecture docs and summarize the relevant parts for this change"

## Manual Configuration

### Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "skills": ["@gmickel/gno"]
}
```

### Codex

Add to `~/.codex/config.json`:

```json
{
  "skills": ["@gmickel/gno"]
}
```

## Other Compatible Clients

These clients support the skills spec but require manual setup:

### VS Code Copilot (Preview)

Copy the skill to `.github/skills/gno/` (or `.claude/skills/gno/`):

```bash
gno skill show > .github/skills/gno/SKILL.md
```

Requires VS Code Insiders with `chat.useAgentSkills` enabled.

### Cursor (Nightly)

Copy the skill to your Cursor skills directory:

```bash
gno skill show > .cursor/skills/gno/SKILL.md
```

Enable Agent Skills in Cursor Settings → Rules.

## Skills vs MCP

| Feature  | Skills               | MCP                        |
| :------- | :------------------- | :------------------------- |
| Access   | `/gno` slash command | Automatic tool calls       |
| Setup    | `gno skill install`  | `gno mcp install`          |
| Protocol | Direct CLI           | JSON-RPC over stdio        |
| Best for | Quick searches       | Complex multi-tool queries |

Use Skills for quick access, MCP for deeper integration. You can install both.

## Troubleshooting

**Skill not found**

```bash
gno skill paths                # Check installation paths
gno skill install --force      # Reinstall
```

**No results**

```bash
gno ls        # Check indexed docs
gno status    # Check health
```
