## Goal & Context

Agents only use GNO well when the operator hand-authors usage instructions into harness files, and hand-pasted blocks rot. Ship `gno agents install`: a first-class, marker-managed installer for a compact GNO protocol block in the GLOBAL (user-scope) instruction files of every supported harness. Strategy: vault note "GNO Competitive Gap Analysis (2026-09)" — global instructions are the decided primary discovery channel; per-prompt hook recall was explicitly rejected.

This design is validated by a real cross-machine deployment (2026-09-01 reference setup, three hosts, seven harnesses, protocol-canary verified). That deployment's installer lessons are requirements here, generalized: **this ships a user-configurable knowledge protocol, not a vault convention.**

## Architecture & Data Models

**Harness coverage matrix — verified by deployment, to be re-confirmed in-task and shipped in docs:**
- Claude Code: user-global CLAUDE.md at the standard location, honoring documented overrides (e.g. a config-dir environment variable) when set.
- Codex: user-global AGENTS.md, same standard-location + documented-override rule.
- Cursor Agent: its native user-level instruction surface (deployment confirmed a working adapter; capture the exact file in the matrix).
- OpenCode: native surface per deployment.
- Grok Build: reads the Claude global import — NO separate install; the installer must DETECT this import chain and skip, reporting "covered via claude", never double-installing.
- Hermes: marker-managed block in SOUL.md.
- OpenClaw: marker-managed block in AGENTS.md (existing workspaces).
- `--target all` = every harness detected on the machine; harness discovery (which harnesses are installed) precedes writing.

**Installer contract (each item is deployment-tested):**
- One compact, versioned protocol block bounded by stable BEGIN/END markers; install/update touches ONLY the owned block; content outside markers stays byte-identical.
- Backup-first: the touched file is backed up before any write.
- Idempotent: re-running is a no-op when current.
- Fail-closed marker validation: malformed or duplicate markers → error with guidance, never guess or "repair".
- Verification built in: `gno agents verify` checks per target — exactly one marker block, block hash matches the installed version, links inside the block resolve. Deterministic checks only (fresh-session behavioral canaries are an operator/dogfood practice, documented but not automated in v1).
- `gno agents update` refreshes the block in place across versions; `gno agents uninstall` removes block + markers cleanly; `--dry-run` prints a unified diff and writes nothing; `--json` everywhere.
- Symlink-aware: where a harness supports pointing at one canonical file, write once and respect the link; never break an operator's existing symlink scheme.

**Block content v1 — the ladder + the writing contract (compact; detailed workflows stay in the skill; target well under 1,500 characters):**
- Retrieval ladder (validated in the reference deployment): scope to a collection first; exact terms/identifiers → `gno search`; entity/document lookup → fast `gno query`; multi-document evidence for a goal → `gno context build` (Capsule); change/dependency questions → `gno changes` / `gno diff` / `gno impact`; generated factual answers → `gno ask --verify` (abstains); diagnose an expected retrieval miss (reformulate, check collection scope) before falling back to grep.
- Writing contract: retrieve before writing; a question is read-only; an existing canonical note is edited directly in the source file; `gno capture` is the creation primitive for genuinely new notes (collection, title/path, source kind, provenance) — never an update API; a capture receipt proves only the mechanical write; reindex the affected collection after writes and verify retrieval.
- Citation discipline (gno:// URIs) and a pointer to the deeper retrieval layer: the block names `/gno` for advanced retrieval (structured query syntax, tag/date/author filters, backlinks, similar, intent modes, capture recipes) when the GNO skill is installed, and `gno skill install --scope user` otherwise — both in one static sentence. The block text is identical on every machine (no per-machine skill probing, no filesystem paths), so `verify` reduces to a version + hash comparison. (Amended 2026-09-02: the original state-aware pointer required per-machine skill-state aggregation that outgrew its value; see PR #205.)
- Memory-loop rungs (remember/recall) are added by a block-version bump when fn-130 ships — the installer is the delivery vehicle.

## Edge Cases & Constraints

- Never write outside markers; never create a harness's instruction file tree structure that does not exist unless the target harness is detected as installed (creating the FILE is fine; fabricating harness dirs is not).
- Nonstandard/multi-instance layouts (several harness config dirs on one machine) are served by an explicit repeatable `--extra-dir <path>` flag, never by guessed discovery — the default targets only each harness's standard documented locations. Multi-instance operators script the flag.
- Import-chain dedupe (Grok→Claude today) is data-driven so future chains can be added without code shape changes.
- Multi-machine reality: the installer is per-machine; the matrix docs state that (index/DB state is machine-local; instruction files may be synced or repo-managed by operators — respect either).
- CLI-only surface is a recorded deliberate exception to the four-surface rule (operator command by nature).

## Acceptance Criteria

- R1: `gno agents install --target all` on a machine with N detected harnesses writes the block to every standard matrix location (plus any `--extra-dir` paths given); a second run is a no-op; content outside markers is byte-identical (hash-verified in tests). Verified live on at least Claude Code + Codex + one AGENTS.md harness, including one `--extra-dir` case.
- R2: Grok-style import chains are detected and skipped with an explicit "covered via <target>" report; no double block. Verified live.
- R3: Malformed/duplicate markers (or an unreadable/unwritable/non-UTF-8 file) cause a clean per-target failure with guidance and the complete block printed for manual application; `--dry-run` prints the exact diff and writes nothing; every touched file has a backup. Verified live.
- R4: `gno agents verify` reports per-target: exactly-one-block, block version and hash match the installed release; any file references the block contains resolve (vacuous — the block carries none by construction); `update` migrates an older block version in place; `uninstall` leaves the file without block or markers. Verified live.
- R5: Block content teaches the full ladder + writing contract within the size budget, passes the copy rules, and carries a version stamp.
- R6: Harness matrix (who reads what, with evidence) lands in docs; docs/CLI.md + spec/cli.md updated in the same change; site reference follows in fn-133.

## Boundaries

- Out: behavioral canary automation (documented as operator practice only).
- Out: per-prompt hooks of any kind; the only hook-shaped follow-up (PreCompact nudge) is explicitly deferred and not part of this spec.
- Out: memory-loop block content (arrives with fn-130 via a block version bump).
- Out: managing operator-owned content outside the marker block, including symlink schemes themselves.

## Pilot routing

no-plan — dispatch work with `--spec <this-id> --no-plan`.
