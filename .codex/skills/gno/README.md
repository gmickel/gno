# GNO — Agent Skill

Local-first semantic search for documents, notes, and knowledge bases,
packaged as a Claude Code / Codex / OpenCode / OpenClaw / Hermes skill.

> **TL;DR** — this folder is a runnable agent skill. Drop it into any
> Claude Code, Codex, OpenCode, OpenClaw, or Hermes workspace and the agent can
> index and search your local files through the `gno` CLI.

## Prerequisites

You need the `gno` CLI installed locally. The skill drives it; it does
not ship the binary itself.

```bash
bun install -g @gmickel/gno
```

Verify the installed release with `gno --version`. Use the bundled skill to match that release.

## Install the skill

There are two ways to install, and which one you pick depends on where
you're starting from.

### Option A — install from your local `gno` (recommended if you already have GNO)

If you already installed GNO, it ships this skill in-tree. One command
drops it into the right place for every supported agent, matching the GNO version installed when you run it:

```bash
gno skill install --target claude       # Claude Code (default)
gno skill install --target codex        # OpenAI Codex CLI
gno skill install --target opencode     # OpenCode
gno skill install --target openclaw     # OpenClaw
gno skill install --target hermes       # Hermes
gno skill install --target all          # All supported agents
```

As of their current releases, `--target claude` also serves Grok Build and Cursor via automatic `.claude/skills` discovery, `--target codex` is also read by Cursor, and other skill-capable clients can copy the files listed by `gno skill paths`.

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

After upgrading GNO, refresh the installed copy as described below.

### Option B: ClawHub-managed installation

Use the [GNO listing](https://clawhub.ai/gmickel/gno) when your harness manages
skills through a registry. The GNO executable is still required separately.

```bash
# OpenClaw workspace: run from its workspace root
bunx clawhub@0.23.3 install @gmickel/gno
bunx clawhub@0.23.3 update @gmickel/gno

# Hermes hub installation
hermes skills install clawhub/gno # May require review; prefer the local installer
hermes skills check
hermes skills update gno
```

GNO releases publish the same source bundle to ClawHub. Choose one installer
for a given skill directory so registry and local copies do not overwrite one
another. For Hermes, prefer the local GNO installer if your hub version cannot
retrieve the full bundle. A bare SKILL.md URL may omit recipes and references.

## Install the retrieval protocol too

For second-brain and LLM-wiki work, pair the skill with standing instructions
for the harness. The skill teaches commands and workflows; the protocol teaches
when to retrieve, which search path to use, and how to cite and maintain knowledge.

```bash
gno agents install          # Detected supported harnesses
gno agents verify
```

Use `--target claude`, `codex`, `opencode`, `openclaw`, or `hermes` for one
harness. MCP users should install the protocol too where supported. Text outside
the managed instruction block stays unchanged. Start a fresh session and verify
that the agent retrieves and cites a document from your index. The verify command
checks the block, not model behavior. See [agent instructions](https://gno.sh/docs/agents-install).

## Keep installations current

Local installs copy the skill from your installed GNO release. After upgrading,
refresh the selected target and protocol:

```bash
gno skill install --target hermes --scope user --force
gno agents update --target hermes
gno agents verify --target hermes
```

`--force` replaces local skill edits. Preserve your customizations before using
it. Change the target for another harness. Registry installs use their native
update command instead; upgrading the GNO executable alone does not refresh them.

For unattended registry updates, schedule only the chosen skill's native update
command with your OS scheduler, using the same user, workspace, and executable
paths as the interactive install. Preserve logs and keep safety prompts enabled;
an update that needs approval must remain pending. Run `gno agents update` after
upgrading GNO. New skill versions can require a newer executable, so update GNO
before refreshing the skill. Publishing a release does not modify users' machines.

## What the skill teaches the agent

Once installed, the agent gains a single callable capability: run `gno`
commands from the workspace. The skill docs (see [SKILL.md](SKILL.md))
walk the model through:

- initialising a new index and adding collections
- retrieval-proven `setup` and portable project profiles
- keyword (`search`), vector (`vsearch`), hybrid (`query`) and
  AI-answer (`ask`) search modes
- deterministic Context Capsules and fail-closed verified answers
- document retrieval (`get`, `multi-get`) including line ranges
- link graph traversal (`links`, `backlinks`, `similar`, `graph`)
- private retrieval traces/replay and Knowledge Delta inspection
- project affinity, explainable content boosts, and collection egress policy
- JSONL, mail, calendar, transcript, and browser-export source adapters
- manual agent-session import into a separate archive, and citing session
  turns as evidence rather than facts
- provenance-aware browser clipping and typed second-brain capture recipes
- tagging, contexts, and per-collection embedding models
- publishing notes as gno.sh reader snapshots (`publish export`)
- stdio and resident Streamable HTTP MCP access

The reference docs in this folder are discoverable by the agent via
progressive disclosure — the model only pulls them when it needs them:

- [SKILL.md](SKILL.md) — core instructions + frontmatter
- [cli-reference.md](cli-reference.md) — concise CLI command reference
- [mcp-reference.md](mcp-reference.md) — MCP tool and resource contract
- [examples.md](examples.md) — end-to-end usage patterns
- [recipes/](recipes/) — task-shaped second-brain workflows for lookup,
  capture, meetings, email context, source summaries, ideas, citations,
  memory, and past agent sessions

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
