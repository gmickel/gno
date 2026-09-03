# GNO memory plugin for OpenClaw

An external [OpenClaw](https://openclaw.ai) memory plugin (`kind: "memory"`,
selected through `plugins.slots.memory`) that answers OpenClaw's memory
recall through GNO retrieval. OpenClaw keeps writing its own memory files
(`MEMORY.md`, `USER.md`, `memory/*.md`); GNO indexes them and serves search
with `gno://` citations and content hashes. The plugin never writes a memory
file.

Verified against OpenClaw **2026.8.1**. That release retired `memory.backend`
and removed the QMD backend; a memory plugin is now the only external memory
path.

| OpenClaw surface                   | What the plugin does                                                                             |
| :--------------------------------- | :----------------------------------------------------------------------------------------------- |
| `memory_search` tool               | `gno search` (or `gno query --fast` in hybrid mode) scoped to the memory collection              |
| `memory_get` tool                  | `gno get` by `gno://` URI or workspace-relative path, with optional line window                  |
| Memory capability + prompt section | Registers `memory_search` as the deterministic recall tool and the "Memory Recall" prompt        |
| `openclaw gno-memory <subcommand>` | `search`, `get`, `status`, `sync` on the same backend (`openclaw memory` belongs to memory-core) |
| Init service (`gno-memory-init`)   | Registers the workspace memory paths as a GNO collection and runs the first index sync           |

Requires GNO **1.41.0 or newer** (`gno --version` is checked once per
process). Below that, or when `gno` is missing, times out, or returns
malformed JSON, the tools return `disabled: true` with a clear error, the CLI
exits 1 with the same message, and the model is told memory is unavailable.

## Why GNO here

- **One index across every harness and format.** The same GNO index that holds
  your PDFs, mail, notes, and code also holds OpenClaw's memory files, so a
  memory hit sits next to the document it came from.
- **Cited, hashed recall.** Every hit carries a `gno://` URI, a line span, and
  the mirror hash, so a claim can be re-verified after the file changes.
- **The evidence layer.** `gno context build`, `gno ask --verify`, and the
  retrieval traces work over the memory collection like any other.
- **Scoped recall.** Search is always scoped to the memory collection; nothing
  else in the index leaks into an OpenClaw turn.

OpenClaw's built-in memory already supports local GGUF embeddings; "no API
key" is not what this plugin adds.

## Install

```bash
# 1. GNO 1.41.0+ on the OpenClaw host, initialized
npm install -g @gmickel/gno@latest
gno --version
gno init          # once, if you have no GNO config yet

# 2. Get the plugin source
git clone --depth 1 https://github.com/gmickel/gno.git /tmp/gno-src
cp -R /tmp/gno-src/integrations/openclaw-gno-memory ~/openclaw-gno-memory

# 3. Link it into OpenClaw (local source checkout; TypeScript entry loads directly)
openclaw plugins install --link ~/openclaw-gno-memory --force
```

Then select it as the memory slot in `openclaw.json` and restart the Gateway:

```json5
{
  plugins: {
    slots: { memory: "gno-memory" },
    entries: {
      "gno-memory": {
        enabled: true,
        config: {
          collection: "openclaw-memory", // GNO collection name (default)
          // root: "/path/to/openclaw/workspace", // defaults to the OpenClaw workspace
        },
      },
    },
  },
}
```

```bash
openclaw gateway restart
openclaw plugins inspect gno-memory --runtime --json   # status: loaded, tools memory_search/memory_get
openclaw gno-memory status
openclaw gno-memory search "your canary phrase"
```

Without a managed install, a bare `plugins.load.paths: ["~/openclaw-gno-memory"]`
entry plus `plugins.allow: ["gno-memory"]` loads the same source.

## Corpus provisioning

The first `search`, `get`, `sync`, or the Gateway init service registers the
OpenClaw workspace as a GNO collection:

```
gno collection add <workspace> --name openclaw-memory \
  --pattern '{MEMORY.md,USER.md,memory/**/*.md}' \
  --exclude .git,node_modules,.openclaw,.state
```

The pattern is the guard: only the memory files match, so runtime state,
transcripts, and other workspace files never enter the index. A collection of
the same name rooted elsewhere is an error, not a silent re-point.

**Sync-before-search (default).** Every search runs
`gno index <collection> --no-embed` first, so a memory file OpenClaw wrote a
moment ago is retrievable, a deleted file drops out, and a renamed file moves
to its new URI. The sync costs roughly half a second on a small workspace.
When a `gno daemon` (or `gno serve`) already watches the workspace, set
`syncBeforeSearch: false` and let the watcher keep the index current.

Every sync outcome is logged (`gno-memory: index sync ok ... (added, updated,
removed)` or `gno-memory: index sync failed (<kind>): ...`). A failed sync
marks the index stale: the tool response carries `stale: true` and a
`warning`, the model is told to relay it, and `openclaw gno-memory status`
shows `STALE: <reason>` until a sync succeeds. With sync-before-search on,
that is the next search. With `syncBeforeSearch: false` nothing else runs
`gno index`, so the flag ages out instead: once it is five minutes old the
next search re-probes with one `gno index` run, clears the flag on success,
or refreshes the reason and restarts the five-minute clock on failure. An
explicit `openclaw gno-memory sync` re-probes immediately.

Known gap (GNO core, not the plugin): a file deleted and later restored at the
same path with byte-identical content stays inactive, because incremental sync
treats a same-hash record as unchanged. Any content change reactivates it.

## Config reference

| Key                | Default                                       | Notes                                                               |
| :----------------- | :-------------------------------------------- | :------------------------------------------------------------------ |
| `collection`       | `openclaw-memory`                             | GNO collection name (lowercased)                                    |
| `root`             | OpenClaw workspace dir                        | Collection root; `~`, relative, and trailing-slash forms normalize  |
| `paths`            | `MEMORY.md`, `USER.md`, `memory/**/*.md`      | Workspace-relative globs, joined into one brace pattern             |
| `exclude`          | `.git`, `node_modules`, `.openclaw`, `.state` | GNO exclude list                                                    |
| `gnoPath`          | `gno`                                         | Binary name or absolute path                                        |
| `gnoArgs`          | `[]`                                          | Global flags for every call, e.g. `["--config", "<path>"]`          |
| `timeoutMs`        | `30000`                                       | Per subprocess                                                      |
| `syncBeforeSearch` | `true`                                        | Off when a daemon watches the workspace                             |
| `mode`             | `keyword`                                     | `keyword` = `gno search` (no models); `hybrid` = `gno query --fast` |
| `maxResults`       | `8`                                           | Default result cap                                                  |

`gno` inherits the OpenClaw process environment, so `GNO_CONFIG_DIR`,
`GNO_DATA_DIR`, and `GNO_CACHE_DIR` select a separate GNO config and index
when you want OpenClaw memory isolated from your main index.

## Tests

```bash
bun test integrations/openclaw-gno-memory
```

The suite fakes the `gno` subprocess (no GNO install, no OpenClaw runtime):
version pinning, every failure kind, collection provisioning, sync-before-
search argv, stale-index state, tool and CLI shapes.

## Uninstall

```bash
openclaw plugins uninstall gno-memory
gno collection remove openclaw-memory   # GNO side, optional
```
