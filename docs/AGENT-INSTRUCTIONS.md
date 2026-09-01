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
  (hash-verified in the test suite).
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
`AGENTS.md`, `SOUL.md` (creating `AGENTS.md` when none exists).

## Block content

The block teaches the retrieval ladder (search → query → context build →
changes/diff/impact → ask --verify → diagnose-before-grep), the writing
contract (retrieve first; edit canonical notes in place; `gno capture` for
genuinely new notes; reindex + verify after writes), and gno:// citation
discipline — in well under 1,500 characters. It carries a version stamp and a
content hash, and a state-aware pointer: `/gno` when the GNO agent skill is
installed for that harness, otherwise `gno skill install`.

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
