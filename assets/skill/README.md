# GNO — Agent Skill

Local-first semantic search for documents, notes, and knowledge bases,
packaged as a Claude Code / Codex / OpenCode / OpenClaw skill.

> **TL;DR** — this folder is a runnable agent skill. Drop it into any
> Claude Code, Codex, OpenCode, or OpenClaw workspace and the agent can
> index and search your local files through the `gno` CLI.

## Prerequisites

You need the `gno` CLI installed locally. The skill drives it; it does
not ship the binary itself.

```bash
# macOS / Linux
curl -fsSL https://gno.sh/install | bash

# npm / Bun
bun add -g @gmickel/gno        # or: npm install -g @gmickel/gno
```

Verify: `gno --version` should print `1.0.3` or later.

## Install the skill

There are two ways to install, and which one you pick depends on where
you're starting from.

### Option A — install from your local `gno` (recommended if you already have GNO)

If you already installed GNO, it ships this skill in-tree. One command
drops it into the right place for every supported agent, always in sync
with your installed GNO version:

```bash
gno skill install --target claude       # Claude Code (default)
gno skill install --target codex        # OpenAI Codex CLI
gno skill install --target opencode     # OpenCode
gno skill install --target openclaw     # OpenClaw
gno skill install --target all          # All four
```

Scope is configurable:

```bash
gno skill install --scope project       # ./.claude/skills/gno (default)
gno skill install --scope user          # ~/.claude/skills/gno
```

Inspect or uninstall:

```bash
gno skill show                          # preview what would be installed
gno skill paths                         # resolved installation paths
gno skill uninstall --target all        # remove from all agents
```

This path always gives you the skill that matches your GNO CLI — no
version drift.

### Option B — install from ClawHub (recommended if you use OpenClaw)

ClawHub is the OpenClaw skill registry. Use this when you manage
skills centrally across multiple workspaces or when you don't have GNO
installed yet.

```bash
openclaw skills install gno             # installs @gmickel/gno
openclaw skills update gno              # pull a newer version later
openclaw skills info gno                # inspect what's installed
```

You can also browse the skill at
<https://clawhub.ai/gmickel/gno> and download the folder manually.

## What the skill teaches the agent

Once installed, the agent gains a single callable capability: run `gno`
commands from the workspace. The skill docs (see [SKILL.md](SKILL.md))
walk the model through:

- initialising a new index and adding collections
- keyword (`search`), vector (`vsearch`), hybrid (`query`) and
  AI-answer (`ask`) search modes
- document retrieval (`get`, `multi-get`) including line ranges
- link graph traversal (`links`, `backlinks`, `similar`, `graph`)
- tagging, contexts, and per-collection embedding models
- publishing notes as gno.sh reader snapshots (`publish export`)
- MCP server setup for persistent agent access

The reference docs in this folder are discoverable by the agent via
progressive disclosure — the model only pulls them when it needs them:

- [SKILL.md](SKILL.md) — core instructions + frontmatter
- [cli-reference.md](cli-reference.md) — every CLI command, option and flag
- [mcp-reference.md](mcp-reference.md) — MCP tool and resource contract
- [examples.md](examples.md) — end-to-end usage patterns

## Agent tooling contract

The skill requests two tools:

```yaml
allowed-tools: Bash(gno:*) Read
```

- **`Bash(gno:*)`** — the agent can invoke `gno <anything>` on the
  host. All writes are explicit CLI calls; nothing runs implicitly.
- **`Read`** — the agent can open files the user has pointed at. No
  filesystem writes come through the skill itself.

## Versioning

The skill version is tracked separately from the GNO CLI version. When
the CLI ships a new feature worth teaching the model (new flag, new
subcommand, new sanitizer behaviour), the skill gets a point bump. See
the CHANGELOG entry on ClawHub or the `gno` repo's CHANGELOG for what
landed in each bump.

## License

MIT-0 — use it freely, with or without attribution.

## Links

- Source: <https://github.com/gmickel/gno>
- Hosted publishing: <https://gno.sh>
- OpenClaw docs: <https://docs.openclaw.ai>
- ClawHub listing: <https://clawhub.ai/gmickel/gno>
