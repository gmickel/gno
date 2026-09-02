# Agent Instructions — `gno agents`

Agents only use GNO well when their instruction files tell them how — and
hand-pasted blocks rot. `gno agents install` maintains one compact, versioned
GNO protocol block in the **global (user-scope) instruction file** of every
supported harness, bounded by stable markers:

```
<!-- gno:agents:begin -->
<!-- gno-agents block v1 sha256:... — managed by `gno agents`; ... -->
...ladder + writing contract...
<!-- gno:agents:end -->
```

Everything outside the markers is yours; the installer never touches it.

## Quick start

```bash
gno agents install            # every harness detected on this machine
gno agents verify             # deterministic per-target checks
gno agents update             # refresh after a gno upgrade
gno agents uninstall          # remove block + markers cleanly
```

All commands take `--target <harness|all>`, repeatable `--extra-dir <path>`,
`--json`, and (except verify) `--dry-run`.

## Harness matrix — who reads what

Verified against a real cross-machine deployment (three hosts, seven
harnesses, fresh-session protocol-canary confirmed, 2026-09).

| Harness      | Target id  | Global instruction file            | Detection root          | Evidence / notes                                                        |
| ------------ | ---------- | ---------------------------------- | ----------------------- | ----------------------------------------------------------------------- |
| Claude Code  | `claude`   | `~/.claude/CLAUDE.md`              | `~/.claude`             | Honors `CLAUDE_CONFIG_DIR` when set (instance setups)                   |
| Codex        | `codex`    | `~/.codex/AGENTS.md`               | `~/.codex`              | Honors `CODEX_HOME` when set                                            |
| Cursor Agent | `cursor`   | `~/AGENTS.md`                      | `~/.cursor`             | The CLI discovers AGENTS.md walking from the working dir toward home    |
| OpenCode     | `opencode` | `~/.config/opencode/AGENTS.md`     | `~/.config/opencode`    |                                                                         |
| Grok Build   | `grok`     | — (imports the Claude global file) | `~/.grok`               | `grok inspect` shows the import; installer reports `covered via claude` |
| Hermes       | `hermes`   | `~/.hermes/SOUL.md`                | `~/.hermes`             | Marker-managed block inside the user-owned SOUL.md                      |
| OpenClaw     | `openclaw` | `~/.openclaw/workspace/AGENTS.md`  | `~/.openclaw/workspace` | Existing workspaces only                                                |

Import-chain dedupe (Grok → Claude today) is data-driven in the matrix, so
future chains are new entries, not code changes.

## Installer guarantees

- **Owned block only** — content outside the markers stays byte-identical
  (hash-verified in the test suite). The separator install adds above the
  block — a blank line after a newline-terminated file, or the single newline
  a file without one lacked — is recorded inside the block together with a
  hash of the bytes right before it (stamp `sep:<kind> pre:<hash>`; an
  install into an empty file records `sep:none`), so uninstall restores the
  original bytes exactly, and never consumes whitespace it cannot prove it
  added — that covers the newline after the END marker too, so a block you
  paste or move into other content keeps every surrounding line break.
  Provenance is never inferred from file shape.
- **Backup-first** — every touched existing file is copied to
  `<file>.gno-agents.bak.<timestamp>` before the write.
- **Idempotent** — re-running when current is a no-op (no write, no backup).
- **Fail-closed markers** — malformed or duplicate markers produce an error
  with guidance; the installer never guesses or "repairs".
- **Symlink-aware** — writes go through the resolved real file, so operator
  symlink schemes (one canonical file linked into several harnesses) survive;
  targets resolving to the same real file are written once and reported
  `covered via <target> (same file)`.
- **No fabricated trees** — an undetected harness is skipped; the installer
  creates instruction files, never harness directories.

## Nonstandard and multi-instance layouts

Default discovery targets only each harness's standard documented location.
Several config dirs on one machine (e.g. `~/.claude-instances/*`) are served
by the explicit, repeatable flag — never by guessing:

```bash
gno agents install \
  --extra-dir ~/.claude-instances/work-cli \
  --extra-dir ~/.claude-instances/sub2-cli
```

Inside an extra dir the installer manages the first existing of `CLAUDE.md`,
`AGENTS.md`, `SOUL.md` (creating `AGENTS.md` when none exists; a dangling
symlink counts as existing and is written through, so a link to a not-yet-created
shared file stays the managed file). An extra dir is
an instance of its own: its skill state is read from `<dir>/skills/gno`, never
from a standard harness, so the block only names `/gno` once the skill is
installed into that instance — for example
`gno skill install --scope user --force --target claude --skills-dir ~/.claude-instances/work-cli/skills`.

## Block content

The block teaches the retrieval ladder (search → query → context build →
changes/diff/impact → ask --verify → diagnose-before-grep), the writing
contract (retrieve first; edit canonical notes in place; `gno capture` for
genuinely new notes; reindex + verify after writes), and gno:// citation
discipline — in well under 1,500 characters. It carries a version stamp and a
content hash, and a state-aware pointer: `/gno` when the GNO agent skill is
installed for every harness that reads the file, otherwise a remediation
scoped to the consumers that lack it — one
`gno skill install --scope user --force --target <harness>` per such harness,
and no more than needed (Cursor, which loads either Claude's or Codex's
skill, is satisfied by whichever of those the file's other consumers already
require)
(and `… --target claude --skills-dir '<dir>/skills'` for an extra-dir instance — single-quoted, so nothing in the path expands; an apostrophe is escaped in the idiom of the platform the block was rendered on),
never `--target all`, so following the pointer never fabricates skill or
config dirs for harnesses you never installed. `--force` keeps it idempotent
across partial installs. That state is read from the
same effective config dir as the instruction file, so a harness redirected via
`CLAUDE_CONFIG_DIR` / `CODEX_HOME` is checked — and installed into — under
that dir. Cursor and Grok load Claude's skill from the standard
`~/.claude/skills` regardless of `CLAUDE_CONFIG_DIR` or `CLAUDE_SKILLS_DIR`
(Cursor also loads `~/.codex/skills`, and counts as installed when either has
the skill), so they are checked there, and while either override is active
their remediation points at that standard directory. Files are handled as bytes: a leading UTF-8 BOM survives every
operation, and a file that is not valid UTF-8 is refused rather than
rewritten. Shared-file identity is resolved even before the file exists
(dangling symlinks followed, nearest existing ancestor canonicalized), so
aliases of one not-yet-created file are written once. A file shared by several harnesses (a
symlinked `~/AGENTS.md`, an
import chain) gets the conservative pointer whenever any consumer lacks the
skill — and that consumer aggregation always spans the full harness matrix,
even on an explicit `--target` run (the flag filters which files are written,
never which consumers constrain a shared file's render).

Detailed workflows stay in the skill; the block is the routing contract.

## Verification

`gno agents verify` is deterministic: exactly one marker block per target,
stamp version + hash match the installed release, and any filesystem
references inside the block resolve (vacuous when there are none). Exit 1 on
any `outdated`, `missing`, or `malformed` target.

**Operator practice (not automated):** after installing, start a fresh session
in each harness and ask for the loaded knowledge protocol; the agent should
describe the GNO retrieval ladder. Behavioral canaries like this stay manual
by design — v1 verification is deterministic only.

## Multi-machine reality

The installer is per-machine: GNO's index and database are machine-local
derived state and never sync. Instruction files themselves may be synced or
repo-managed by operators (dotfiles, a private instructions repo, symlink
schemes) — the installer respects either: it writes through symlinks and its
marker-managed block survives file-level sync. Run `gno agents verify` on each
machine after syncing.
