---
title: Agent Sessions
description: Import selected local agent conversations (Codex, Claude Code, OpenClaw, Hermes) into a dedicated, searchable session archive with speaker labels, provenance, redaction, receipts, explicit opt-in retrieval, and opt-in automation (Claude Code SessionEnd hook, daemon schedules).
keywords: gno sessions, agent session search, codex sessions, claude code sessions, openclaw, hermes, session archive, conversation search, agent transcripts, sessionend hook, session automation
---

# Agent Sessions

`gno sessions` makes selected local agent conversations searchable. It reads
the session stores that Codex, Claude Code, OpenClaw, and Hermes keep on your
machine, keeps who said what, when, and in which project, and writes one
sanitized archive file per conversation thread. Ordinary GNO search, query,
ask, get, and Context Capsules then work on that archive.

Three rules shape the feature:

- **Manual by default.** A fresh installation imports, watches, and schedules
  nothing, and registers no hooks. Every import is a command you run (or a
  button you press in the Web UI) until you explicitly switch on
  [automation](#automation-opt-in) for a profile.
- **Evidence, not truth.** An archived turn records what was said. An
  assistant suggestion stays labelled as assistant output and never reads as
  a decision the person made.
- **Separate by default.** Sessions live in a dedicated archive with its own
  config file and index. Your curated notes index does not see them until you
  opt in.

| Surface | Status                     | Import                                   | Discovery and setup                        |
| :------ | :------------------------- | :--------------------------------------- | :----------------------------------------- |
| CLI     | `gno sessions status`      | `gno sessions import`                    | `gno sessions discover`, `init`, `source`  |
| MCP     | `gno_sessions_status`      | `gno_sessions_import` (`--enable-write`) | none (host paths never reach MCP clients)  |
| REST    | `GET /api/sessions/status` | `POST /api/sessions/import`              | same-host client only                      |
| SDK     | `client.sessionsStatus()`  | `client.importSessions()`                | `client.discoverSessions()`                |
| Web UI  | `/sessions` page           | Dry-run preview, then import             | Sources and archive setup (same host only) |

Opt-in [automation](#automation-opt-in) adds `gno sessions automation`
(CLI), `gno_sessions_automation_run` (MCP), `/api/sessions/automation/*`
(REST), `client.runSessionsAutomation()` (SDK), and an Automation panel on
`/sessions`; its state is part of every status response.

Receipts, status, discovery, and automation run results are the same
objects on every surface and validate against
`spec/output-schemas/sessions-import-receipt.schema.json`,
`sessions-status.schema.json`, `sessions-discovery.schema.json`, and
`sessions-automation-run.schema.json`.

## How it works

```
native session store (read-only)
    │
    ▼ harness parser: structural speaker classification (human / assistant)
    │
    ▼ sanitizer: credential redaction before anything is persisted
    │
    ▼ one sanitized JSONL archive file per thread
    │   <archiveRoot>/<collection>/<harness>/<sourceId>/<hash>.jsonl
    │
    ▼ ordinary collection sync through the JSONL record adapter
    │   (one logical record per turn)
    ▼
search / query / ask / get / context build on the archive pair
```

GNO never registers a harness directory as a collection and never writes to
it. The archive files are plain JSONL you own; the SQLite index built from
them is disposable.

## Plan the archive

### Archive binding: one config, one index

A session archive is a dedicated config file that carries a `sessions` block,
paired with one named index. This pairing is the archive binding. Every
command that touches the archive passes both:

```bash
gno --config ~/gno-sessions/archive.yml --index sessions <command>
```

The pair is enforced in both directions before every command, in the SDK,
and for cross-index `gno get`:

- The archive config with any other `--index` fails with
  `SESSIONS_BINDING_MISMATCH`.
- The archive index opened with any other config (including your default
  config) fails with the same code.

So `gno update`, `gno search`, and `gno serve` on your curated setup never
read or write the archive. `gno sessions init` refuses the default config file
and the `default` index for the same reason. It records the binding in the
named index immediately, before any import, and refuses an index that already
holds other collections or belongs to another archive
(`SESSIONS_BINDING_MISMATCH`): choose a new index name for each archive. A
config already bound to another index or archive root is never retargeted.

The SDK checks the pair when it opens a client, the REST routes check the
server's own pair, and a server started on a curated config never attaches an
archive (its session calls answer `SESSIONS_NOT_CONFIGURED`).

### Where to put it

The recommended layout keeps the archive outside your curated vault, for
example:

```text
~/gno-sessions/
  archive.yml          # archive config (sessions block + archive collections)
  archive/             # archive root
    sessions-work/     # one folder per archive collection
    .gno-sessions/     # import checkpoint and lock
```

Placement is your setting, within two hard rules checked by `sessions init`:

- The archive root must lie outside GNO's own config, data, and cache
  directories, so `gno reset`, index cleanup, or an uninstall cannot delete
  it.
- The archive root must not lie inside a folder that your default (curated)
  config already indexes; otherwise the curated index would pick up the
  archive files behind your back. A vault folder that no curated collection
  covers is fine.

To bring session turns into curated retrieval on purpose, use
[mixed retrieval](#mixed-retrieval-opt-in) after `init`.

### Collections per privacy boundary

Archive collections are the unit of separation. Create one per privacy or
domain boundary (for example `sessions-work` and `sessions-personal`), and
optionally one per project:

- `--collection` on `source add` sets a source's default collection.
- `--project <prefix>=<collection>` (repeatable) sends threads whose recorded
  working directory lies under `<prefix>` to another collection.

Harness and project identity are kept as tags, so one project stays
searchable across agents whichever collection it lands in.

Routing is part of each thread's import state. When you change a source's
default collection or its `--project` mappings (remove and re-add the source,
or edit the archive config), the next import re-imports the affected threads
into their new destination, even when the session files themselves did not
change.

### Quarantined threads

A thread whose recorded working directories map to different collections is
**quarantined**: it is not written anywhere and the receipt reports it as
`skipped_policy` with reason `mixed_domain`. GNO never writes such a thread to
the less restricted collection. To release it, add or adjust a `--project`
mapping so all its directories resolve to one collection; the next import
then archives the thread. Alternatively, import the file explicitly into the
collection you choose.

Archive collections are ordinary collections: collection
[egress policy](CONFIGURATION.md#collection-egress-policy) applies to them
(default `local_only`), and they are not memory-managed.

## Quick start

```bash
# 1. Preview supported local session stores (reads nothing into GNO)
gno sessions discover

# 2. Create the archive config/index pair and a first archive collection
gno --config ~/gno-sessions/archive.yml --index sessions \
  sessions init --archive ~/gno-sessions/archive --collection sessions-work

# 3. Register an owner-approved source (registration never imports)
gno --config ~/gno-sessions/archive.yml --index sessions \
  sessions source add codex --harness codex --path ~/.codex/sessions \
  --collection sessions-work --project ~/work/api=sessions-api

# 4. Preview: parse and report without writing anything
gno --config ~/gno-sessions/archive.yml --index sessions \
  sessions import --source codex --dry-run

# 5. Import
gno --config ~/gno-sessions/archive.yml --index sessions \
  sessions import --source codex

# 6. Search the archive
gno --config ~/gno-sessions/archive.yml --index sessions \
  search "sqlite" --category harness/codex --author human
gno --config ~/gno-sessions/archive.yml --index sessions \
  query "why did we pick sqlite" --tags-all project/api,role/human

# 7. Optional: embeddings for semantic search (import does not embed)
gno --config ~/gno-sessions/archive.yml --index sessions embed
```

`gno sessions` with no subcommand is the same as `discover`. Add `--json` to
any `sessions` subcommand for the shared machine-readable result.

Explicit files work without registering a source. Paths must be absolute:

```bash
gno --config ~/gno-sessions/archive.yml --index sessions \
  sessions import /absolute/path/to/rollout-example.jsonl \
  --collection sessions-work --format codex
```

A path may be a single session file or a directory. Without `--format`, GNO
detects the harness structurally, from the file contents or the directory
layout; `--format` overrides detection. `--collection` is required for path
imports and rejected with `--source` (a registered source always uses its
registered collection and project mappings).

## What is imported

| Imported                                                                 | Excluded by default                                                         |
| :----------------------------------------------------------------------- | :-------------------------------------------------------------------------- |
| Human speech, only where the harness structurally marks it as the user's | Tool calls and tool results                                                 |
| Assistant final text                                                     | Reasoning and thinking blocks                                               |
| Slash commands a person typed in Claude Code, archived as `/name args`   | Injected instructions, context, and system reminders                        |
| Forks and subagents as distinct threads linked to their parent           | Compaction summaries                                                        |
| Assistant replies of programmatic runs                                   | History copied into a fork or continuation                                  |
|                                                                          | A subagent's task prompt (written by its parent agent)                      |
|                                                                          | Prompts of programmatic runs (`codex exec`, Claude Code SDK or `claude -p`) |

Programmatic prompts are excluded because a program or another agent may
have written them; attributing them to a person would be wrong. Text that
imitates a role inside a message ("Human: ...") stays quoted content of the
real speaker.

The archive is a searchable record of dialogue, not a complete execution
audit: it does not show what tools ran or what they returned. Record kinds a
parser does not recognise produce bounded, content-free diagnostics
(`unknownKinds` counts) instead of guessed speech.

## Archived records and citation

Each archived turn becomes one logical record:

- **Title**: speaker, harness, and project, for example
  `Human · Codex · api`.
- **Body**: starts with `Human:` or `Assistant:` and ends with one
  `Provenance:` line.
- **Author**: `human` or `assistant`.
- **Tags** (categories): `session`, `harness/<codex|claude-code|openclaw|hermes>`,
  `role/<human|assistant>`, `session-kind/<main|subagent|fork|continuation>`,
  `project/<basename>`, and `project-id/<hash>` (tells apart two projects with
  the same folder name).
- **Session identity**: `threadId` and, for threads that belong to another
  session (subagents, forks, continuations), `sessionId` record fields; the
  recorded time is the record date (`dateFields.recorded`).

The provenance line lists, separated by `·`: for assistant turns the marker
"Assistant (assistant output, not a user decision)"; `recorded unknown` when
the source has no timestamp (a known time travels as the record date); the
source profile ID; the native locator (file name plus line, or database row;
never a host path); and the logical turn ID. For example:

```text
Provenance: source codex · locator rollout-….jsonl#line:5 · turn item-u1
```

A missing timestamp stays unknown; GNO does not invent one. The line is kept
to one row so bounded context delivery (Capsules, `--budget`) spends its budget
on dialogue rather than metadata.

Cite session evidence by the record's `gno://` URI. URIs from the archive
index carry `?index=sessions` in every CLI JSON output, including `gno ls`
and the results, citations, and `meta.answerContext` of `gno ask`; keep that
query string when you pass the URI to `gno get`, `client.get()`, or MCP
`gno_get`:

```bash
gno --config ~/gno-sessions/archive.yml --index sessions get "gno://sessions-work/.gno/records/…/….md?index=sessions"
```

When you quote a session in an answer, say who said it: a human turn is what
the person wrote; an assistant turn is what the agent proposed.

## Searching sessions

Session search is normal GNO retrieval on the archive pair. There is no
separate ranking engine.

| Goal                               | Flag                                              |
| :--------------------------------- | :------------------------------------------------ |
| One harness                        | `--category harness/codex`                        |
| What people said, not agent output | `--author human` (or `--tags-all role/human`)     |
| One project across agents          | `--tags-all project/api` (or `project-id/<hash>`) |
| Main conversations only            | `--tags-all session-kind/main`                    |
| One privacy boundary               | `-c sessions-work`                                |

`search`, `vsearch`, `query`, and `context build` accept all of these;
`ask` accepts the collection, category, and author filters.
`--since` / `--until` filter on the archive file's modification time (when it
was imported or last updated), not on the recorded turn time; read the
recorded time from the title or provenance block.

Your broad curated search does not include the archive. To find a past
decision:

1. Search the archive pair for the decision's own words, restricted to human
   turns: `search "postgres" --author human --tags-all project/api`.
2. Widen to `query` (after `embed`) when the wording differs.
3. Read the full turn with `get` on the hit's URI; its provenance block
   names the thread and session it belongs to.
4. Report the human turn as the decision and any assistant turn as a
   proposal, each with its `gno://` URI.

### Mixed retrieval (opt-in)

Nothing federates the archive into another index automatically, and there is
no cross-index server context. If you want session turns inside your curated
retrieval, register the archive collection folder in the curated config
yourself:

```bash
gno collection add ~/gno-sessions/archive/sessions-work --name sessions-work --pattern "**/*.jsonl"
```

Then copy that collection's `recordAdapters.jsonl.fieldMapping` block from
the archive config into the new collection entry, so author, tags, session
identity, and dates keep working:

```yaml
collections:
  - name: sessions-work
    path: /absolute/path/to/gno-sessions/archive/sessions-work
    pattern: "**/*.jsonl"
    recordAdapters:
      jsonl:
        fieldMapping:
          id: /id
          title: /title
          body: /body
          author: /author
          categories: /categories
          sessionId: /sessionId
          threadId: /threadId
          dateFields:
            recorded: /recordedAt
```

From then on the session records take part in that index's ordinary
retrieval, Context Capsules, graph, listings, and tag facets, and they count
toward its egress decisions. Keep that in mind before sharing curated output.
The archive pair keeps working unchanged; imports update the files, and the
curated index sees the changes after its own `gno update`.

## Import receipts and recovery

Every import returns a receipt (`--json` prints it in full):

| Field           | Meaning                                                                                                       |
| :-------------- | :------------------------------------------------------------------------------------------------------------ |
| `status`        | `complete`, `partial`, `failed` (every processed unit failed), or `nothing_to_do`                             |
| `counts`        | threads `imported` / `updated` / `unchanged` / `skippedPolicy`; units `unsupported` / `incomplete` / `failed` |
| `turns`         | `human`, `assistant`, `redactions`, `injectedSkipped`, `copiedHistorySkipped`, `overLimit`                    |
| `units[]`       | per-unit outcome with a safe locator (file name or table path) and reason                                     |
| `deferredUnits` | changed units left for a later run by `--limit`                                                               |
| `lexical`       | `ready`, `failed`, or `skipped` (dry run), with the synced collections                                        |
| `embedding`     | `backlog`: chunks waiting for `gno embed`                                                                     |

A receipt is `partial` when any unit is incomplete, failed, unsupported, or
deferred, or when the lexical sync failed, and `failed` when nothing was
archived or unchanged and nothing is incomplete. A partial import is never
reported as complete. A rerun over unchanged sources is `nothing_to_do` and
counts the already archived threads as `unchanged`. Receipts carry counts, locators, and reason codes only: no
session content and no host paths.

| Reason                  | Meaning and recovery                                                                                                                                                                                                                                                                                                                                                                                          |
| :---------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `truncated_tail`        | The final line was cut mid-write (a session still running). Readable threads are archived; rerun later.                                                                                                                                                                                                                                                                                                       |
| `format_drift`          | Structure GNO does not recognise, for example assistant turns without any recognised human turn, a Codex fork without its history boundary or an OpenClaw child transcript whose parent is unreadable (both archived as nothing rather than duplicating the parent), or an OpenClaw child that `sessions.json` does not classify as fork or subagent (its first prompt is withheld, never archived as human). |
| `malformed_records`     | Some records were not valid JSON and were dropped; the unit stays incomplete and is retried.                                                                                                                                                                                                                                                                                                                  |
| `unit_conflict`         | Two units of one source share a locator (for example the same rollout file name in two folders); the second is not imported.                                                                                                                                                                                                                                                                                  |
| `snapshot_read_failed`  | A SQLite store could not be read in one read-only snapshot. Rerun; check the harness is not migrating.                                                                                                                                                                                                                                                                                                        |
| `permission_denied`     | The file, database, or a directory inside the source (locator `.`) is not readable by your user. Fix the permissions and rerun; its checkpoint does not advance until it is read.                                                                                                                                                                                                                             |
| `source_missing`        | The unit or a directory inside the source disappeared between listing and reading.                                                                                                                                                                                                                                                                                                                            |
| `read_failed`           | Another read error.                                                                                                                                                                                                                                                                                                                                                                                           |
| `format_not_recognised` | The unit is not a supported session format (`unsupported`).                                                                                                                                                                                                                                                                                                                                                   |
| `over_limit`            | The unit or thread exceeds a [limit](#limits) (`skipped_policy` for threads). A thread at the turn limit is skipped whole, never archived truncated. A database with more threads than the per-unit limit stays incomplete.                                                                                                                                                                                   |
| `mixed_domain`          | The thread spans collections; it was [quarantined](#quarantined-threads).                                                                                                                                                                                                                                                                                                                                     |

Recovery behaviour:

- **Idempotent reruns.** A unit whose fingerprint, parser version, redaction
  rules, and archive format are unchanged is skipped. A changed unit is
  re-rendered and compared byte-for-byte with its archive file. Turn IDs stay
  stable across appends, so a growing session updates its archive file and
  the index reconciles the records.
- **Incomplete units retry.** An `incomplete` unit's readable threads are
  archived, but its checkpoint does not advance; the next import reads it
  again.
- **Interrupted runs heal.** Archive files are written atomically; rerunning
  after a crash produces no duplicates.
- **Completion follows the index sync.** An import records units as complete
  only after the index sync of the changed archive files succeeds. When the
  sync fails or the run is interrupted, the receipt reports `lexical: failed`
  (or nothing is recorded), and the next import retries those units.
- **`--limit <n>`** bounds the changed units processed in one run. Unchanged
  units do not count. The rest are reported in `deferredUnits` and picked up
  by the next run.
- **One import at a time.** Imports on one archive serialize on
  `<archiveRoot>/.gno-sessions/import.lock`; a second concurrent run fails
  with `SESSIONS_BUSY` (CLI exit 4, HTTP 409).
- **Upgrades and redaction changes.** A parser upgrade reparses units whose
  source still exists; a unit whose source is gone keeps its archive as is
  and `status` counts it as `staleParser`. A redaction-rule upgrade or a change
  to `sessions.redaction.literals` takes effect on the next import: units
  whose source still exists are re-rendered, and archives whose source is gone
  are rescanned in place. Every stored field is rescanned, not only the text.
  An archive file that no longer parses is moved to
  `<archiveRoot>/.gno-sessions/withheld/` (out of retrieval), reported as
  withheld in the receipt warnings, and its unit keeps the old redaction
  stamp. A new parser cannot recover content from sources that were rotated
  or deleted.
- **Policy skips withdraw earlier copies.** When a thread that was archived
  before is now quarantined or over a limit, its earlier archive file is moved
  to `<archiveRoot>/.gno-sessions/withheld/` and removed from the index, so no
  stale copy stays searchable.
- **A missing or unreadable source root.** When a registered source root is
  missing or cannot be listed, import still maintains its retained archive
  (redaction rescans) and then fails with `SESSIONS_SOURCE_UNAVAILABLE`
  (exit 2). It never reports the source as up to date.
- **Unreadable parts of a source.** A directory or session file inside the
  source that cannot be read is reported as a `failed` unit
  (`permission_denied`, `source_missing`, or `read_failed`; a directory has
  the locator `.` because its name can be a host path), so the receipt is
  `partial` or `failed`, never `nothing_to_do`. Units there keep their
  checkpoints and archives and are read once they are readable.
- **Database stores.** A thread with assistant turns but no recognised human
  turn in an OpenClaw or Hermes store is reported in the unit warnings; it does
  not hold the whole store incomplete.

## Status, prune, and retention

```bash
gno --config ~/gno-sessions/archive.yml --index sessions sessions status
gno --config ~/gno-sessions/archive.yml --index sessions sessions prune --source codex
gno --config ~/gno-sessions/archive.yml --index sessions sessions prune --source codex --apply
gno --config ~/gno-sessions/archive.yml --index sessions sessions source remove codex
```

- `status` lists archive collections with thread counts and, per source, its
  availability (`false` when the root is missing or cannot be read), unit counts (complete, incomplete, failed, pending),
  `sourceUnavailable`, `staleParser`, and last import time.
- The unit counts cover units present in the source now. `total` counts
  them all; `complete`, `incomplete`, and `failed` give the outcome of each
  one's last import (`failed` includes unsupported units), and units never
  imported are in none of the three. `pending` is not a separate outcome: it
  counts units never imported, every `incomplete` and `failed` unit, and
  `complete` units whose file or destination collection changed since their
  import. So `pending` overlaps the other counts. An import can also re-read
  `complete` units that `pending` does not count, after an upgrade changes
  the session parser, the archive format, or the redaction rules.
- Deleting or rotating a source file never deletes its archive. `status`
  counts such units under `sourceUnavailable`.
- `prune` previews the archive files whose source is gone. It needs a
  complete listing of the source: when part of the source cannot be read, or
  the listing hit the unit limit, it fails with `SESSIONS_SOURCE_UNAVAILABLE`
  instead of treating unread units as deleted. `--apply` deletes
  exactly those files and syncs the index. An archive file that a
  still-present unit references is never pruned, so a session file that the
  harness moved or renamed keeps its archive.
- `source remove` unregisters a source and keeps its archive.

## Automation (opt-in)

Automation imports new session turns without you running `sessions import`
each time. It is off until you switch it on, and it only ever calls the same
importer as a manual import: the same sources, destinations, redaction,
checkpoints, and receipts. Installing, upgrading, repairing, or restarting GNO
never enables it, and a paused trigger stays paused.

Two triggers exist, each switched on separately for one **profile**:

| Trigger                     | What fires it                               | What it does in the foreground                  |
| :-------------------------- | :------------------------------------------ | :---------------------------------------------- |
| Claude Code SessionEnd hook | Claude Code ending a session                | Marks the profile pending on disk, then returns |
| Daemon schedule             | `gno daemon` on this archive, every cadence | Marks the profile pending when due              |

Neither trigger imports anything by itself. The import runs later, in one of
two places:

- `gno daemon` on the archive's config and index drains pending profiles at
  startup and every 30 seconds.
- `gno sessions automation run <profile>` runs a profile now, in the
  foreground.

```
Claude Code SessionEnd ──► gno sessions hook ──┐
                                               ├─► pending marker (per profile,
daemon schedule tick (due) ────────────────────┘    durable, coalesced)
                                                         │
                        gno daemon tick / automation run ▼
                                          manual importer (sessions import)
```

With no daemon running, hook events stay pending (reported as `pending, not
yet archived`) until a daemon starts or you run the profile. `gno serve` never
drains pending work or runs schedules.

### Quick start

```bash
A="gno --config ~/gno-sessions/archive.yml --index sessions"

# 1. A profile names registered sources. It enables nothing.
$A sessions automation set claude --source claude-code

# 2. Review what would run: sources, destinations, the exact hook command,
#    the settings file it edits, and the daemon prerequisite.
$A sessions automation preview claude

# 3. Switch on the Claude Code SessionEnd hook, the schedule, or both.
$A sessions automation enable claude --hook claude-code
$A sessions automation enable claude --schedule --cadence 30m

# 4. Start the daemon that performs the imports (GNO never starts it for you).
$A daemon --detach

# 5. Watch it work.
$A sessions status
```

### Profiles

A profile lives in the archive config under `sessions.automation`:

```yaml
sessions:
  index: sessions
  archiveRoot: /Users/you/gno-sessions/archive
  sources:
    - id: claude-code
      harness: claude-code
      path: /Users/you/.claude/projects
      collection: sessions-work
  automation:
    - id: claude
      sources: [claude-code]
      hook:
        harness: claude-code
        enabled: true
        settings: /Users/you/.claude/settings.json
      schedule:
        enabled: true
        cadence: 30m
      limit: 200 # optional: changed units per source per run
      retries: 3 # optional: automatic retries after a failed run
```

- `sources` must be registered sources. Destinations, project mappings, and
  privacy boundaries stay on those sources; a profile cannot add a source or
  change where turns land. Reconfigure with `sessions automation set`.
- `hook` and `schedule` appear only after `enable`, and `enabled` changes only
  through `enable` and `disable` (or your own edit of the file).
- `limit` bounds each run. When more changed units wait, the rest stay
  pending and the next daemon tick continues.
- At most 16 profiles per archive.

Run state (pending markers, last run, next due time, daemon heartbeat) is
machine-written to `<archiveRoot>/.gno-sessions/automation.json` with mode
`0600`. It is not configuration; deleting it only forgets pending work and
history.

### Claude Code SessionEnd hook

`enable --hook claude-code` adds one entry to a Claude Code settings file,
by default `$CLAUDE_CONFIG_DIR/settings.json`, else
`~/.claude/settings.json`, which is created when missing. Another file can
be chosen only with the CLI (`--settings <absolute path>`), and it must
already exist; the Web UI and REST always use the recorded or default file:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "GNO_DATA_DIR='…' GNO_CACHE_DIR='…' '/path/to/bun' run '/path/to/gno/src/index.ts' --config '/Users/you/gno-sessions/archive.yml' --index 'sessions' sessions hook claude-code --profile 'claude'",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

- **Ownership.** GNO recognises its entry by that command (this archive
  config and profile). It never edits or removes other hooks, other settings,
  or entries of other profiles. The previous file is kept as
  `settings.json.bak`, and a settings file that is not valid JSON is left
  untouched with an error.
- **Absolute and bound.** The command pins this GNO runtime, its data and
  cache directories, and the archive config/index pair, so neither `PATH` nor
  the session's working directory can redirect it. Re-run `enable` after
  moving GNO or changing `GNO_DATA_DIR`; it repairs the entry in place.
  Enabling with a different `--settings` file first removes the entry from
  the previous file.
- **Tiny foreground.** The hook reads the event, rechecks that the profile's
  hook is still enabled, writes the pending marker durably (fsync), and
  exits. It does not parse sessions, import, embed, or use the network. It
  waits at most 1 second for the marker lock; measured end to end it takes
  about 70 ms. Claude Code's `timeout` of 5 seconds is a backstop.
- **Honest outcome.** The hook prints one content-free line:
  `accepted (profile claude pending, not yet archived; …)`, `skipped (…)`, or
  `not accepted (…); nothing was archived` with a non-zero exit. It never
  reports archival.
- **Kill switch.** `GNO_SESSIONS_HOOKS=off` (or `0`) in Claude Code's
  environment makes every installed hook return immediately.
- **The payload is only a trigger.** The session ID, transcript path, and
  working directory Claude Code sends are not used to choose sources,
  collections, or privacy routing; the import covers the profile's
  registered sources.

The hook supports Claude Code 2.1.2xx. SessionEnd fires for non-interactive
`claude -p` runs, and the hook finishes inside Claude Code's default
1.5-second SessionEnd budget. Limitation: GNO does not guarantee that
SessionEnd fires when an interactive session ends with `/exit`. The daemon
schedule catches up on any session the hook missed.

GNO has no hook for other harnesses (Codex, OpenClaw, Hermes) or for
pre-compaction triggers. `enable --hook codex` fails with
`SESSIONS_UNSUPPORTED_INTEGRATION`; import those harnesses manually or on a
daemon schedule.

### Daemon schedule

- **Daemon only.** Schedules tick only inside `gno daemon` running on the
  archive's config and index. Enabling a schedule does not install or start
  a service; start the daemon yourself (for example `daemon --detach`, or
  under your own login item or service manager).
- **Elapsed cadence.** `--cadence` uses the daemon cadence grammar
  `<n>s|m|h|d`, from `1m` to `30d`. It is elapsed time, not a wall-clock time
  of day, so daylight-saving changes do not move it. There is no cron syntax.
- **First run** one cadence after `enable`, like the daemon findings pass.
- **Missed runs coalesce.** After sleep, a stopped daemon, or a restart, all
  missed intervals become one run. A clock moved backwards never pushes the
  next run more than one cadence away.
- **Times.** Run state stores UTC instants; `sessions status` shows them in
  your local timezone and names it.

Only one resident process (`gno serve` or `gno daemon`) may use a GNO data
directory. If your curated `gno serve` or `gno daemon` already runs, the
archive daemon cannot start on the same data directory
(`Resident runtime already active`). Give the archive its own data
directory and use it for every archive command, including `enable`:

```bash
export GNO_DATA_DIR=~/gno-sessions/data
gno --config ~/gno-sessions/archive.yml --index sessions update   # rebuilds the disposable index there
gno --config ~/gno-sessions/archive.yml --index sessions sessions automation enable claude --hook claude-code
gno --config ~/gno-sessions/archive.yml --index sessions daemon --detach
```

### Run now

`gno sessions automation run <profile>` runs one profile through the
importer immediately and records the outcome in automation status, whether
or not any trigger is enabled. An explicit run resets any backoff and retry
budget. It returns `not_started` (`busy`) only while another automation run
of the same profile is in progress; a manual import holding the archive
shows as a failed run with reason `busy`, retried with backoff.

### Status

`gno sessions status` (and every status surface) reports, per profile:

| Field           | Meaning                                                                       |
| :-------------- | :---------------------------------------------------------------------------- |
| `state`         | `off`, `idle`, `pending`, `running`, `retrying`, `partial`, or `failed`       |
| `hook`          | Harness, enabled, and whether the owned entry is present in its settings file |
| `schedule`      | Enabled, cadence, and `nextDueAt` (null unless a daemon is running)           |
| `pending`       | Since when, and which triggers admitted it                                    |
| `running`       | A live run and when it started                                                |
| `lastRun`       | Triggers, times, outcome, reason code, thread and unit counts                 |
| `lastSuccessAt` | Last run that completed fully (`complete` or `up_to_date`)                    |
| `retryAt`       | When a failed run is retried                                                  |
| `recovery`      | The next action to take, when one is needed                                   |

A schedule whose cadence was hand-edited to an invalid value (for example
`banana`, or `5s` below the minimum) is reported with `enabled: false`, a
warning, and a recovery action (in status and in `preview`), and never runs until you fix it with
`sessions automation set … --cadence`.

The daemon writes its heartbeat every 30 seconds on its own timer, so it
stays `running` during its initial sync and during long imports. The
`daemon` block reports `running` only with a fresh heartbeat from a live
daemon on this archive, `stale` for a live process that stopped ticking, and
`not_running` otherwise; then the schedule shows `not running: no daemon`
instead of a due time.

A profile in `failed` state keeps its admitted work in the JSON `pending`
field, but the text status and the Web UI show the failure and its recovery
action instead of a pending line, because that work only runs after you fix
the cause.

A run's outcome is `complete`, `up_to_date` (a verified no-op: every source
was already current), `partial` (incomplete or deferred units, or a failed
index sync; the next run retries them), or `failed`. Missing or unreadable
sources, stale heartbeats, and failed runs never appear as a successful
completion. Status, logs, and receipts carry counts, IDs, and reason codes
only: no session content and no host paths.

### Failures, retries, and recovery

| Reason code             | Cause                                                                                       | What happens                                                                                                                                                             |
| :---------------------- | :------------------------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `busy`                  | Another import or index writer holds the archive or index (including a locked SQLite index) | A running daemon retries it with backoff (1m, 2m, 4m, … up to 30m), `retries` times; without a daemon, run it again yourself. `automation run` exits 4 (`SESSIONS_BUSY`) |
| `runtime_error`         | Filesystem or index failure                                                                 | Retried with backoff                                                                                                                                                     |
| `interrupted`           | The process running it died                                                                 | Pending work kept; the next daemon tick reruns it                                                                                                                        |
| `source_revoked`        | A profile source is no longer registered                                                    | No automatic retry; fix the profile or re-register the source                                                                                                            |
| `source_unavailable`    | A source or the archive directory is missing or unreadable                                  | No automatic retry; fix it, then `automation run`                                                                                                                        |
| `invalid_configuration` | Collections, binding, or source settings no longer match                                    | No automatic retry; correct the config                                                                                                                                   |
| `import_failed`         | Every processed unit failed                                                                 | No automatic retry; check the receipt of `automation run`                                                                                                                |

Schedule ticks and hook events never reset a pending backoff, and never
clear a failure marked "no automatic retry". Once the automatic retries of a
`busy` or `runtime_error` failure are used up, the next scheduled tick or hook
event starts a fresh retry budget. A failure that needs correction stays
blocked until you act: `sessions automation run`, `set`, or `enable` clear
it.

A trigger that could not be admitted (lock not acquired in time, disk full,
archive directory removed) is reported as not accepted and leaves no pending
marker. An accepted trigger is never dropped silently: it stays pending until
a run consumes it, and a trigger that arrives while a run is in progress
starts another run afterwards. Imports are idempotent, so a rerun after a
crash creates no duplicate turns and never changes provenance.

### Pause, disable, and remove

```bash
$A sessions automation disable claude            # pause everything
$A sessions automation disable claude --hook     # only the hook
$A sessions automation disable claude --schedule # only the schedule
$A sessions automation remove claude             # uninstall and delete the profile
```

- `disable` switches the trigger off first, then removes the owned hook
  entry and clears pending work admitted by that trigger. A run already in
  progress finishes its bounded batch; nothing new starts.
- `remove` uninstalls the owned hook entry and deletes the profile and its
  run state. While a run is in progress it refuses with `SESSIONS_BUSY` and
  changes nothing, so the run stays visible: pause first, then remove once
  status shows the run finished. It fails, and keeps the profile, if the Claude Code settings
  file cannot be read, so the entry never outlives the profile that can
  remove it.
- Archived conversations are always kept. Remove them with
  [`prune`](#status-prune-and-retention) or by deleting archive files.

Automation creates no tasks, reminders, notifications, or OS services,
promotes nothing to remembered facts, and makes no network calls.

## Privacy and redaction

Redaction runs before anything is persisted: archive text, titles, labels,
metadata, locators, receipts, and diagnostics. Detected values are replaced
with markers such as `[REDACTED:api-key]`.

Built-in rules cover common credential shapes: AWS access key IDs, GitHub
tokens, `sk-` style API keys, Stripe and Slack tokens, Google API keys, JWTs,
bearer tokens, credentials inside URLs, `password=` / `api_key:` style
assignments, and private key blocks. A value detected once is redacted
everywhere else in the same thread. Scanning is linear-time.

Add exact strings that must never appear (an internal hostname, a customer
name, a known key) to the archive config:

```yaml
sessions:
  redaction:
    literals:
      - internal.example.net
      - ACME-CUSTOMER-NAME
```

Literals are 4 to 512 characters, at most 256 entries. A change takes effect
on the next import: units whose source still exists are re-rendered, and
archive files whose source is gone are rescanned in place. Until that import
runs, existing archive files and index rows keep their old text, so run an
import (and `embed`) right after adding a literal.

Redaction is best effort. It does not promise to catch every secret or all
personal data, so treat the archive with the same care as the original
session store and keep it under `local_only` egress unless you have reviewed
it.

Other boundaries:

- Source files and databases are opened read-only and never modified. SQLite
  stores are read through a read-only connection in one read transaction; no
  raw copy is made.
- Receipts, status, diagnostics, and remote errors carry no session content
  and no host paths. A filesystem or index failure reached through REST or
  MCP returns `SESSIONS_RUNTIME_FAILURE` with a fixed message, never the
  underlying error text.
- Discovery returns host paths, so it is available only to the CLI, the SDK,
  and a same-host browser. MCP clients and remote HTTP callers can only import
  sources the owner registered, by ID.

## Backup, export, and index reconstruction

The durable data is the archive root (plain JSONL files plus
`.gno-sessions/state.json`) and the archive config. Back them up like any
other folder; the JSONL files are also your export format.

The SQLite index is disposable. Rebuild it from the archive at any time:

```bash
gno --config ~/gno-sessions/archive.yml --index sessions update
gno --config ~/gno-sessions/archive.yml --index sessions embed
```

A lost `state.json` only costs a full re-render on the next import; the
archive files remain the source of truth. Restoring an older backup is
enough to reapply the current redaction rules and literals: the next import
re-renders or rescans every affected archive file. `gno reset`, index cleanup, and
uninstall do not touch the archive root.

## Other surfaces

**MCP** ([MCP.md](MCP.md#gno_sessions_status)). Start the server on the
archive pair: `gno --config ~/gno-sessions/archive.yml --index sessions mcp`.
`gno_sessions_status` is a read tool (it includes automation status);
`gno_sessions_import` and `gno_sessions_automation_run` are write tools
(need `--enable-write`); all are in the `full` profile only. Import takes
`sourceId`, optional `dryRun` and `limit`; unknown keys such as `paths` are
rejected. The run tool takes a configured `profileId` only. There is no MCP
discovery, and hooks and schedules cannot be enabled over MCP.

**REST** ([API.md](API.md#agent-sessions)). Serve the archive pair. Status,
import by source ID, and `POST /api/sessions/automation/run` work for any
allowed client; discovery, source registration and removal, archive init,
and every automation profile change (create, preview, enable, disable,
remove) answer only a same-host client (a local process; cross-origin
browser pages are refused).
`gno serve` and `gno mcp` run each import (including automation Run now)
in a separate process, so the server keeps answering (health, status, the
Web UI) while a large import runs; the receipt and error codes are the same
as from the CLI. The resident file watcher does not follow archive
collections: the import syncs the files it writes.

**SDK** ([SDK.md](SDK.md#agent-sessions)). Open a client on the archive pair:

```ts
const client = await createGnoClient({
  configPath: "/Users/you/gno-sessions/archive.yml",
  indexName: "sessions",
});
const receipt = await client.importSessions({
  sourceId: "codex",
  dryRun: true,
});
// Run a configured automation profile now (hooks and schedules are enabled
// from the CLI or a same-host client only).
const run = await client.runSessionsAutomation({ profileId: "claude" });
```

**Web UI** ([WEB-UI.md](WEB-UI.md#agent-sessions)). Run
`gno --config ~/gno-sessions/archive.yml --index sessions serve --port 3001`
(while your curated server runs, give the archive its own `GNO_DATA_DIR`;
only one server or daemon may own a data directory) and open
`/sessions`: manage sources and the archive destination, preview a dry run
(redaction counts, destination collections), import manually with
partial-outcome details, and search sessions with harness, project, and role
filters and explicit Human/Assistant badges. The Automation panel shows each
profile off by default, separate hook and schedule switches (each confirmed
after a preview of sources, destinations, the settings file and the daemon
prerequisite), daemon availability, pending/running/partial/failed state,
last success, Run now, Pause, and Remove. A curated server does not attach
the archive. Sources you add or remove with the CLI while the server runs
show up the next time the page loads its status, without a restart, and
Remove succeeds on a source the CLI already removed. If the server cannot
read its config file, the page reports the error instead of showing stale
sources.

## Supported harnesses

`gno sessions discover` looks in these roots:

| Harness     | Discovery roots                                        | Store read                                                                                            |
| :---------- | :----------------------------------------------------- | :---------------------------------------------------------------------------------------------------- |
| Codex       | `$CODEX_HOME/sessions`, else `~/.codex/sessions`       | `YYYY/MM/DD/rollout-*.jsonl`                                                                          |
| Claude Code | `~/.claude/projects` and `$CLAUDE_CONFIG_DIR/projects` | `<project dir>/<session>.jsonl`, plus `<session>/subagents/agent-*.jsonl`                             |
| OpenClaw    | `$OPENCLAW_STATE_DIR`, else `~/.openclaw`              | `agents/<agent>/agent/openclaw-agent.sqlite` (schema 23) and legacy `agents/<agent>/sessions/*.jsonl` |
| Hermes      | `$HERMES_HOME`, else `~/.hermes`                       | `state.db` and `profiles/<name>/state.db`                                                             |

Supported versions:

| Harness     | Supported versions                                                                                                                                                     |
| :---------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | CLI 0.58 through 0.156.1. Both the older `user_message` / `agent_message` events (0.150 and earlier) and the `item_completed` speech items (0.151 and later) are read. |
| Claude Code | CLI 2.1.2xx. Files without the `origin` field fall back to conservative role attribution.                                                                              |
| OpenClaw    | 2026.9.6, early support. zstd-compressed events are supported.                                                                                                         |
| Hermes      | 0.19.0 (schema version 22), early support.                                                                                                                             |

Other versions may work. When a store's format differs from what GNO reads,
the receipt reports `format_drift` or `unknownKinds` and GNO skips the
unrecognized records instead of attributing them to the wrong speaker. With
the early-support harnesses, check the receipt for `format_drift` after the
first import.

Consumer chat exports (downloaded conversation archives from chat apps) are
out of scope for `gno sessions`; index them with the generic
[JSONL and transcript adapters](guides/file-export-adapters.md). Account
connectors that pull conversations from a service are out of scope too.

## Limits

| Limit                          | Value             | When exceeded                                 |
| :----------------------------- | :---------------- | :-------------------------------------------- |
| Source unit (file or database) | 512 MiB           | unit skipped (`over_limit`)                   |
| JSONL line                     | 32 MiB            | line skipped and counted                      |
| One turn                       | 256 Ki characters | turn skipped and counted (`overLimit`)        |
| Turns per thread               | 20,000            | thread `skipped_policy` (`over_limit`)        |
| Archive file per thread        | 64 MiB            | thread `skipped_policy` (`over_limit`)        |
| Threads per database unit      | 50,000            | rest not read; unit incomplete (`over_limit`) |
| Units per source per run       | 100,000           | rest left for a later run, with a warning     |
| Units listed in one receipt    | 200               | `unitsTruncated: true`; counts stay exact     |

## Troubleshooting

**`SESSIONS_BINDING_MISMATCH`.** The config and index do not belong together
(see [Archive binding](#archive-binding-one-config-one-index)). Pass the
archive's `--config` together with its `--index`, for example
`gno --config ~/gno-sessions/archive.yml --index sessions ...`, and use your
normal config (no `--config`) for curated work. The archive index cannot be
opened with another config, and the archive config cannot be used with
another index. From `sessions init`, it means the index already holds other
collections or belongs to another archive: pick a new index name.

**`SESSIONS_NOT_CONFIGURED`.** The config has no `sessions` block, usually
because a curated config or server was used. Run the command, or start the
server, on the archive pair.

**`sessions init` refuses the archive root.** The root lies inside GNO's own
directories or inside a folder your default config already indexes (see
[Where to put it](#where-to-put-it)). Choose a folder outside both.

**`SESSIONS_BUSY` (exit 4).** Another import holds
`<archiveRoot>/.gno-sessions/import.lock`. Wait for it to finish and rerun.

**Receipt says `partial` with `truncated_tail`.** The session was still being
written. Nothing is lost: the readable part is archived and the next import
retries the unit.

**`mixed_domain` in the receipt.** The thread was
[quarantined](#quarantined-threads) because its working directories map to
different collections. Add a `--project` mapping; the next import archives it.

**Receipt says `lexical: failed`.** The archive files were written but the
index sync did not finish. The units are not recorded as complete, so rerun
the import; it retries them.

**`format_drift` or `unknownKinds`.** The harness wrote records this parser
does not know. Readable threads are archived and the unit is retried on every
import. Check [Supported harnesses](#supported-harnesses); a newer GNO may
understand the format.

**`snapshot_read_failed`.** A SQLite store could not be read in one
read-only snapshot, often because the harness was migrating or holding an
exclusive lock. Rerun when the harness is idle.

**`SESSIONS_SOURCE_UNAVAILABLE`.** The registered path is missing or not
readable (CLI exit 2). The archive is retained; check the path or remove the
source. Remote REST and MCP callers get this code without the host path;
check the source on the host with `sessions status`.

**Hook says `accepted` but nothing was archived.** Expected until a run:
the hook only marks the profile pending. Start `gno daemon` on the archive's
config and index, or run `gno sessions automation run <profile>`.

**Status says `not running: no daemon`.** No daemon on this archive has
written a heartbeat recently. Start one; if it fails with
`Resident runtime already active`, another `gno serve` or `gno daemon` owns
the data directory: give the archive its own
[data directory](#daemon-schedule).

**Hook entry missing or `installed: false`.** Someone edited the Claude Code
settings file. Run `gno sessions automation enable <profile> --hook
claude-code` again; it repairs only its own entry.

**`SESSIONS_UNSUPPORTED_INTEGRATION`.** Only the Claude Code SessionEnd hook
is supported. Use a daemon schedule for other harnesses.

**No semantic results.** Import does not embed. Run `embed` on the archive
pair before `query` or `vsearch`; the receipt's `embedding.backlog` shows
what is waiting.

**Sessions do not appear in search.** Expected on your curated index: the
archive is separate by default. Search with the archive's `--config` and
`--index`, or set up [mixed retrieval](#mixed-retrieval-opt-in).

## Sessions and memory

Session archives and [memory](MEMORY.md) answer different questions:

| Session archive                                  | Memory (`remember` / `recall`)             |
| :----------------------------------------------- | :----------------------------------------- |
| What was said, by whom, when                     | What we currently believe                  |
| Many turns, imported in bulk                     | One fact per record, written one at a time |
| Dialogue kept as recorded, including stale ideas | Superseded facts drop out of recall        |
| Filled by `gno sessions import`                  | Filled only by an explicit `gno remember`  |

Nothing is promoted from a session to a remembered fact automatically. When
a session shows a decision worth keeping, read the human turn, then store the
fact yourself with `gno remember ... --add --source <gno:// URI of the turn>`
so the fact points back to its evidence.

## Error codes

| Code                                                                            | Meaning                                                            | CLI exit | HTTP | REST `code`  | SDK          |
| :------------------------------------------------------------------------------ | :----------------------------------------------------------------- | :------- | :--- | :----------- | :----------- |
| `SESSIONS_NOT_CONFIGURED`                                                       | The config has no `sessions` block                                 | 1        | 400  | `VALIDATION` | `VALIDATION` |
| `SESSIONS_BINDING_MISMATCH`                                                     | Archive config and index used apart                                | 1        | 400  | `VALIDATION` | `VALIDATION` |
| `SESSIONS_SELECTION_REQUIRED`, `SESSIONS_DESTINATION_REQUIRED`                  | No source or paths selected; path import without a collection      | 1        | 400  | `VALIDATION` | `VALIDATION` |
| `SESSIONS_UNKNOWN_SOURCE`, `SESSIONS_UNKNOWN_COLLECTION`                        | Unregistered source ID or archive collection                       | 1        | 400  | `VALIDATION` | `VALIDATION` |
| `SESSIONS_UNKNOWN_PROFILE`                                                      | Unknown automation profile ID                                      | 1        | 400  | `VALIDATION` | `VALIDATION` |
| `SESSIONS_UNSUPPORTED_INTEGRATION`                                              | Hook for a harness GNO has no hook integration for                 | 1        | 400  | `VALIDATION` | `VALIDATION` |
| `SESSIONS_UNSAFE_PATH`, `SESSIONS_UNSUPPORTED_FORMAT`, `SESSIONS_INVALID_INPUT` | Unsafe path, unknown harness, or malformed input                   | 1        | 400  | `VALIDATION` | `VALIDATION` |
| `SESSIONS_SOURCE_UNAVAILABLE`                                                   | Source path missing or unreadable (no host path when remote)       | 2        | 500  | `RUNTIME`    | `RUNTIME`    |
| `SESSIONS_BUSY`                                                                 | Another import holds the archive lock                              | 4        | 409  | `BUSY`       | `RUNTIME`    |
| `SESSIONS_RUNTIME_FAILURE`                                                      | Filesystem or index failure on REST/MCP (fixed, path-free message) | —        | 500  | `RUNTIME`    | —            |

An import whose `status` is `failed` exits 2, except a selection in which no
unit is a supported format, which exits 1 with `SESSIONS_UNSUPPORTED_FORMAT`. The CLI JSON error envelope and
REST errors carry the code in `details.sessionsCode`, with the generic
envelope `code` shown above; MCP returns it in `structuredContent.error`
(`gno_sessions_import` is registered only with `--enable-write`, like the
other MCP write tools, so read-only clients do not see it); the SDK
throws `GnoSdkError` with the kind shown above and the code in
`details.code`. A same-host refusal on REST is `403 FORBIDDEN` with no
`details.sessionsCode`.
