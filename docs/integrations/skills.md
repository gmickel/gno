# Skills Integration

Use GNO as a skill in AI coding agents like Claude Code, OpenAI Codex, OpenCode, OpenClaw, VS Code Copilot, and Cursor.

> **Why Skills?** Skills are the preferred integration method due to progressive discovery: tools are only loaded when invoked via `/gno`, avoiding context pollution from unused tool definitions. See [agentskills.io](https://agentskills.io/home) for the specification.
>
> Skills work in clients that support the spec. GNO has first-class install targets for Claude Code, Codex, OpenCode, and OpenClaw. VS Code Copilot and Cursor require manual setup (see below).

## Quick Install

```bash
gno skill install --scope user                    # Claude Code, user-wide
gno skill install --target codex --scope user     # OpenAI Codex CLI
gno skill install --target opencode --scope user  # OpenCode
gno skill install --target openclaw --scope user  # OpenClaw
gno skill install --target all --scope user       # All targets at once
```

## Supported Targets

| Target     | User-wide command                                  | User Config Location             |
| :--------- | :------------------------------------------------- | :------------------------------- |
| `claude`   | `gno skill install --scope user`                   | `~/.claude/skills/gno/`          |
| `codex`    | `gno skill install --target codex --scope user`    | `~/.codex/skills/gno/`           |
| `opencode` | `gno skill install --target opencode --scope user` | `~/.config/opencode/skills/gno/` |
| `openclaw` | `gno skill install --target openclaw --scope user` | `~/.openclaw/skills/gno/`        |
| `all`      | `gno skill install --target all --scope user`      | All locations                    |

## Scope Options

| Scope     | Flag              | Description                                 |
| :-------- | :---------------- | :------------------------------------------ |
| `project` | `--scope project` | Install to current directory only (default) |
| `user`    | `--scope user`    | Install for all projects                    |

## Using the Skill

Once installed, use the `/gno` slash command:

```
/gno search "authentication patterns"
/gno query "how does our API handle errors"
/gno status
```

Or just ask your agent naturally:

> "Search my notes for the auth discussion"

## Second-Brain Recipes

The installed skill includes a recipe router in `SKILL.md` plus nested playbooks under `recipes/`. These files teach agents repeatable workflows without advertising native connectors or background automation.

Preview a recipe before installing:

```bash
gno skill show --file recipes/brain-first-lookup.md
gno skill show --file recipes/capture-and-file.md
gno skill show --file recipes/meeting-ingestion.md
gno skill show --file recipes/email-context.md
gno skill show --file recipes/source-summary.md
gno skill show --file recipes/idea-capture.md
gno skill show --file recipes/citation-and-provenance.md
```

Recipe coverage:

| Recipe                       | Use when                                                  | Verification                                  |
| :--------------------------- | :-------------------------------------------------------- | :-------------------------------------------- |
| `brain-first-lookup.md`      | Local context may already answer the request              | Evidence checked and gaps stated              |
| `capture-and-file.md`        | Save a durable fact, clip, or note                        | Capture receipt plus search/get verification  |
| `meeting-ingestion.md`       | Ingest user-provided meeting notes or transcript text     | Meeting page and action items findable        |
| `email-context.md`           | Draft or summarize from user-provided/exported email text | Local context checked; no native mail claim   |
| `source-summary.md`          | Summarize a source into a durable note                    | Provenance-bearing summary findable           |
| `idea-capture.md`            | Preserve an idea or prompt pattern                        | Original phrasing captured and searchable     |
| `citation-and-provenance.md` | Verify claims or produce traceable answers                | Claims labeled with evidence or explicit gaps |

Email, calendar, chat, and web sources are user-supplied/exported inputs unless a separate connector outside GNO provides them. GNO does not include native Gmail, Calendar, Slack, webhook, cron, or background-agent recipe automation.

## Commands

```bash
gno skill install [options]    # Install skill
gno skill uninstall [options]  # Remove skill
gno skill show [options]       # Preview skill files
gno skill paths [options]      # Show installation paths
```

### CLI Flags

| Flag                | Description                                                             |
| :------------------ | :---------------------------------------------------------------------- |
| `--scope <scope>`   | `project` or `user` (default: `project`)                                |
| `--target <target>` | `claude`, `codex`, `opencode`, `openclaw`, or `all` (default: `claude`) |
| `--force`           | Overwrite existing installation                                         |

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

### OpenCode

Install directly:

```bash
gno skill install --target opencode --scope user
```

### OpenClaw

Install directly:

```bash
gno skill install --target openclaw --scope user
```

## Other Compatible Clients

These clients support the skills spec but require manual setup:

### VS Code Copilot (Preview)

Copy the skill to `.github/skills/gno/` (or `.claude/skills/gno/`):

```bash
gno skill install --scope project --target claude --force
mkdir -p .github/skills
cp -R .claude/skills/gno .github/skills/gno
```

Requires VS Code Insiders with `chat.useAgentSkills` enabled.

### Cursor (Nightly)

Copy the skill to your Cursor skills directory:

```bash
gno skill install --scope project --target claude --force
mkdir -p .cursor/skills
cp -R .claude/skills/gno .cursor/skills/gno
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
