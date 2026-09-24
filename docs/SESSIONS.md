---
title: Agent Sessions
description: Import selected local agent conversations (Codex, Claude Code, OpenClaw, Hermes) into a dedicated, searchable session archive with speaker labels, provenance, redaction, receipts, and explicit opt-in retrieval.
keywords: gno sessions, agent session search, codex sessions, claude code sessions, openclaw, hermes, session archive, conversation search, agent transcripts
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
  button you press in the Web UI).
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
| REST    | `GET /api/sessions/status` | `POST /api/sessions/import`              | same-host browser only                     |
| SDK     | `client.sessionsStatus()`  | `client.importSessions()`                | `client.discoverSessions()`                |
| Web UI  | `/sessions` page           | Dry-run preview, then import             | Sources and archive setup (same host only) |

Receipts, status, and discovery results are the same objects on every
surface and validate against `spec/output-schemas/sessions-import-receipt.schema.json`,
`sessions-status.schema.json`, and `sessions-discovery.schema.json`.

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

### One archive config paired with one named index

A session archive is a dedicated config file that carries a `sessions` block,
paired with one named index. Every command that touches the archive passes
both:

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
(`SESSIONS_BINDING_MISMATCH`): choose a new index name for each archive.

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

Placement is your setting. The only hard rule is that the archive root must
lie outside GNO's own config, data, and cache directories, so `gno reset`,
index cleanup, or an uninstall cannot delete it. An archive inside a vault
folder is allowed; avoid a folder that your curated config already indexes
unless you want [mixed retrieval](#mixed-retrieval-opt-in).

### Collections per privacy boundary

Archive collections are the unit of separation. Create one per privacy or
domain boundary (for example `sessions-work` and `sessions-personal`), and
optionally one per project:

- `--collection` on `source add` sets a source's default collection.
- `--project <prefix>=<collection>` (repeatable) sends threads whose recorded
  working directory lies under `<prefix>` to another collection.

Harness and project identity are kept as tags, so one project stays
searchable across agents whichever collection it lands in.

A thread whose recorded working directories map to different collections is
**quarantined**: it is not written anywhere and the receipt reports it as
`skipped_policy` with reason `mixed_domain`. GNO never writes such a thread to
the less restricted collection. Add or adjust a `--project` mapping, or import
the file explicitly into the collection you choose.

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

- **Title**: speaker, harness, project, and time, for example
  `Human turn · Codex · api · 2026-09-20 10:00`.
- **Body**: starts with `Human:` or `Assistant:` and ends with a
  `Session provenance` block.
- **Author**: `human` or `assistant`.
- **Tags** (categories): `session`, `harness/<codex|claude-code|openclaw|hermes>`,
  `role/<human|assistant>`, `session-kind/<main|subagent|fork|continuation>`,
  `project/<basename>`, and `project-id/<hash>` (tells apart two projects with
  the same folder name).
- **Session identity**: `sessionId` and `threadId` record fields, and the
  recorded time as the record date.

The provenance block lists the speaker (assistant turns are marked
"assistant output, not a user decision"), the recorded time (or `unknown`),
harness and thread kind, source profile ID, native locator (file name plus
line, or database row; never a host path), logical turn ID, thread and
session IDs, and the project label and ID. A missing timestamp stays unknown;
GNO does not invent one.

Cite session evidence by the record's `gno://` URI. URIs from the archive
index carry `?index=sessions`; keep that query string when you pass the URI
to `gno get`, `client.get()`, or MCP `gno_get`:

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
    path: /Users/you/gno-sessions/archive/sessions-work
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
deferred, or when the lexical sync failed. A partial import is never reported
as complete. Receipts carry counts, locators, and reason codes only: no
session content and no host paths.

| Reason                  | Meaning and recovery                                                                                    |
| :---------------------- | :------------------------------------------------------------------------------------------------------ |
| `truncated_tail`        | The final line was cut mid-write (a session still running). Readable threads are archived; rerun later. |
| `format_drift`          | Structure GNO does not recognise, for example assistant turns without any recognised human turn.        |
| `snapshot_read_failed`  | A SQLite store could not be read in one read-only snapshot. Rerun; check the harness is not migrating.  |
| `permission_denied`     | The file or database is not readable by your user.                                                      |
| `source_missing`        | The unit disappeared between listing and reading.                                                       |
| `read_failed`           | Another read error.                                                                                     |
| `format_not_recognised` | The unit is not a supported session format (`unsupported`).                                             |
| `over_limit`            | The unit or thread exceeds a [limit](#limits) (`skipped_policy` for threads).                           |
| `mixed_domain`          | The thread spans collections; it was quarantined (see above).                                           |

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
  are rescanned in place. A new parser cannot recover content from sources
  that were rotated or deleted.

## Status, prune, and retention

```bash
gno --config ~/gno-sessions/archive.yml --index sessions sessions status
gno --config ~/gno-sessions/archive.yml --index sessions sessions prune --source codex
gno --config ~/gno-sessions/archive.yml --index sessions sessions prune --source codex --apply
gno --config ~/gno-sessions/archive.yml --index sessions sessions source remove codex
```

- `status` lists archive collections with thread counts and, per source, its
  availability, unit counts (complete, incomplete, failed, pending),
  `sourceUnavailable`, `staleParser`, and last import time.
- Deleting or rotating a source file never deletes its archive. `status`
  counts such units under `sourceUnavailable`.
- `prune` previews the archive files whose source is gone; `--apply` deletes
  exactly those files and syncs the index.
- `source remove` unregisters a source and keeps its archive.

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
- Receipts, status, and diagnostics carry no session content and no host
  paths.
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
`gno_sessions_status` is a read tool and `gno_sessions_import` a write tool
(needs `--enable-write`); both are in the `full` profile only. Import takes
`sourceId`, optional `dryRun` and `limit`; unknown keys such as `paths` are
rejected. There is no MCP discovery.

**REST** ([API.md](API.md#agent-sessions)). Serve the archive pair. Status and
import by source ID work for any allowed client; discovery, source
registration and removal, and archive init answer only a same-host browser.

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
```

**Web UI** ([WEB-UI.md](WEB-UI.md#agent-sessions)). Run
`gno --config ~/gno-sessions/archive.yml --index sessions serve --port 3001`
(pick a free port when your curated server already runs on 3000) and open
`/sessions`: manage sources and the archive destination, preview a dry run
(redaction counts, destination collections), import manually with
partial-outcome details, and search sessions with harness, project, and role
filters and explicit Human/Assistant badges. A curated server does not attach
the archive.

## Supported harnesses

`gno sessions discover` looks in these roots:

| Harness     | Discovery roots                                        | Store read                                                                                            |
| :---------- | :----------------------------------------------------- | :---------------------------------------------------------------------------------------------------- |
| Codex       | `$CODEX_HOME/sessions`, else `~/.codex/sessions`       | `YYYY/MM/DD/rollout-*.jsonl`                                                                          |
| Claude Code | `~/.claude/projects` and `$CLAUDE_CONFIG_DIR/projects` | `<project dir>/<session>.jsonl`, plus `<session>/subagents/agent-*.jsonl`                             |
| OpenClaw    | `$OPENCLAW_STATE_DIR`, else `~/.openclaw`              | `agents/<agent>/agent/openclaw-agent.sqlite` (schema 23) and legacy `agents/<agent>/sessions/*.jsonl` |
| Hermes      | `$HERMES_HOME`, else `~/.hermes`                       | `state.db` and `profiles/<name>/state.db`                                                             |

What each parser was verified against:

| Harness     | Verified against                                                                                                                                                                                      |
| :---------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | Structure of a local store written by CLI 0.58 through 0.156.1 (2026-09): the legacy `user_message` / `agent_message` events (0.150 and earlier) and `item_completed` speech items (0.151 and later). |
| Claude Code | Structure of local stores written by CLI 2.1.2xx (2026-09). Files without the `origin` field use a conservative fallback; no such file was available to verify it.                                    |
| OpenClaw    | Upstream v2026.9.6 source definitions, with synthetic fixtures. Not verified against a live installation. zstd-compressed events are supported.                                                       |
| Hermes      | The v0.19.0 schema (schema version 22) from the installed source, with synthetic fixtures. No populated store was available.                                                                          |

Other versions may work; a format change shows up as `format_drift` or
`unknownKinds` in the receipt rather than as misattributed speech.

Consumer chat exports (downloaded conversation archives from chat apps) are
out of scope for `gno sessions`; index them with the generic
[JSONL and transcript adapters](guides/file-export-adapters.md). Account
connectors that pull conversations from a service are out of scope too.

## Limits

| Limit                          | Value             | When exceeded                             |
| :----------------------------- | :---------------- | :---------------------------------------- |
| Source unit (file or database) | 512 MiB           | unit skipped (`over_limit`)               |
| JSONL line                     | 32 MiB            | line skipped and counted                  |
| One turn                       | 256 Ki characters | turn skipped and counted (`overLimit`)    |
| Turns per thread               | 20,000            | thread `skipped_policy` (`over_limit`)    |
| Archive file per thread        | 64 MiB            | thread `skipped_policy` (`over_limit`)    |
| Units per source per run       | 100,000           | rest left for a later run, with a warning |
| Units listed in one receipt    | 200               | `unitsTruncated: true`; counts stay exact |

## Troubleshooting

**`SESSIONS_BINDING_MISMATCH`.** The config and index do not belong together.
Pass the archive's `--config` together with its `--index`; use your normal
config (no `--config`) for curated work. A curated config cannot open the
archive index.

**`SESSIONS_BUSY` (exit 4).** Another import holds
`<archiveRoot>/.gno-sessions/import.lock`. Wait for it to finish and rerun.

**Receipt says `partial` with `truncated_tail`.** The session was still being
written. Nothing is lost: the readable part is archived and the next import
retries the unit.

**`format_drift` or `unknownKinds`.** The harness wrote records this parser
does not know. Readable threads are archived and the unit is retried on every
import. Check [Supported harnesses](#supported-harnesses); a newer GNO may
understand the format.

**`snapshot_read_failed`.** A SQLite store could not be read in one
read-only snapshot, often because the harness was migrating or holding an
exclusive lock. Rerun when the harness is idle.

**`SESSIONS_SOURCE_UNAVAILABLE`.** The registered path is missing or not
readable (CLI exit 2). The archive is retained; check the path or remove the
source.

**No semantic results.** Import does not embed. Run `embed` on the archive
pair; the receipt's `embedding.backlog` shows what is waiting.

**A session is missing from curated search.** Expected: the archive is
separate by default. Search the archive pair, or set up
[mixed retrieval](#mixed-retrieval-opt-in).

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

| Code                                                                            | Meaning                                                       | CLI exit | HTTP |
| :------------------------------------------------------------------------------ | :------------------------------------------------------------ | :------- | :--- |
| `SESSIONS_NOT_CONFIGURED`                                                       | The config has no `sessions` block                            | 1        | 400  |
| `SESSIONS_BINDING_MISMATCH`                                                     | Archive config and index used apart                           | 1        | 400  |
| `SESSIONS_SELECTION_REQUIRED`, `SESSIONS_DESTINATION_REQUIRED`                  | No source or paths selected; path import without a collection | 1        | 400  |
| `SESSIONS_UNKNOWN_SOURCE`, `SESSIONS_UNKNOWN_COLLECTION`                        | Unregistered source ID or archive collection                  | 1        | 400  |
| `SESSIONS_UNSAFE_PATH`, `SESSIONS_UNSUPPORTED_FORMAT`, `SESSIONS_INVALID_INPUT` | Unsafe path, unknown harness, or malformed input              | 1        | 400  |
| `SESSIONS_SOURCE_UNAVAILABLE`                                                   | Source path missing or unreadable                             | 2        | 500  |
| `SESSIONS_BUSY`                                                                 | Another import holds the archive lock                         | 4        | 409  |

An import whose `status` is `failed` exits 2. The CLI JSON error envelope and
REST errors carry the code in `details.sessionsCode`; MCP returns it in
`structuredContent.error`; the SDK throws `GnoSdkError` (`VALIDATION` or
`RUNTIME`) with the code in `details.code`.
