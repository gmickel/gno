# GNO memory provider for Hermes Agent

An external [Hermes Agent](https://github.com/NousResearch/hermes-agent) memory
provider that puts GNO's `remember` / `recall` contracts into the slots Hermes
calls:

| Hermes slot                         | What the provider does                                                                                                                          |
| :---------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------- |
| `prefetch` (before every turn)      | `gno recall --json` with the turn's message and the scopes from the provider config                                                             |
| `gno_remember` tool (model-invoked) | `gno remember --json` with `decision` = `propose` (no write), `add`, or `supersede`; presents the session's latest recall receipt (`--receipt`) |
| `sync_turn` (after every turn)      | **Nothing.** No GNO writes ever happen without an explicit `gno_remember` call                                                                  |
| `system_prompt_block`               | One short block telling the model recall is automatic and storing is deliberate                                                                 |

Identity: `caller` comes from the provider config; `session` is the Hermes
session id (rebound on `/resume`, `/branch`, `/new`). Scopes come from the
provider config only; the tool exposes no scope parameter.

Requires GNO **1.41.0 or newer** (`gno remember` / `gno recall`). Below that,
or when `gno` is missing, times out, or returns malformed JSON, the provider
logs a clear error, tells the model memory is unavailable, and the session
continues without memory.

## Install

Verified against Hermes v0.20.5. Hermes discovers user providers in
`$HERMES_HOME/plugins/<name>/` (default `~/.hermes/plugins/`).

```bash
# 1. GNO 1.41.0+ on the Hermes host, with one memoryManaged collection
npm install -g @gmickel/gno@latest
gno --version

# 2. Copy the provider into the Hermes user-plugins directory
git clone --depth 1 https://github.com/gmickel/gno.git /tmp/gno-src
mkdir -p ~/.hermes/plugins
cp -R /tmp/gno-src/integrations/hermes-gno-memory/gno ~/.hermes/plugins/gno

# 3. Provider config (scopes are required; there is no implicit global scope)
mkdir -p ~/.hermes/gno
cat > ~/.hermes/gno/config.json <<'EOF'
{
  "scopes": ["project:gno"],
  "collection": "memory",
  "caller": "hermes"
}
EOF

# 4. Activate it (writes memory.provider: gno into ~/.hermes/config.yaml)
hermes memory setup gno
hermes memory status
```

`hermes memory setup gno` walks the config fields interactively. To activate
without the wizard, set `memory.provider: gno` under `memory:` in
`~/.hermes/config.yaml` yourself. `hermes memory off` deactivates it; deleting
`~/.hermes/plugins/gno` and `~/.hermes/gno/` removes it completely.

The memory collection must exist on the GNO side (see
[docs/MEMORY.md](../../docs/MEMORY.md#setting-up-a-memory-collection)):

```yaml
collections:
  - name: memory
    path: /Users/you/notes/memory
    pattern: "**/*.md"
    memoryManaged: true
```

**Embed the memory collection.** Lexical-only recall requires every query
term to match, so a question-shaped turn ("What is the deploy branch?")
misses facts that the vector leg finds. Run `gno embed memory` after seeding
facts (or keep `gno serve` / `gno daemon` watching the collection); the
provider logs a one-time warning while recall reports `mode: lexical`.

## Config reference (`$HERMES_HOME/gno/config.json`)

| Key               | Default      | Meaning                                                                    |
| :---------------- | :----------- | :------------------------------------------------------------------------- |
| `scopes`          | _(required)_ | List or comma-separated string; 1 to 8 scopes used for recall and remember |
| `collection`      | `""`         | memoryManaged collection; may be omitted when exactly one is configured    |
| `caller`          | `hermes`     | Caller identity recorded on every fact and receipt                         |
| `gno_path`        | `""`         | Path to the `gno` binary; default is a `$PATH` lookup                      |
| `timeout_seconds` | `15`         | Per-call subprocess timeout (1 to 120)                                     |
| `max_facts`       | `8`          | Recall budget: facts per turn (1 to 64)                                    |
| `max_tokens`      | `512`        | Recall budget: tokens per turn (1 to 8192)                                 |

## The `gno_remember` tool

```json
{
  "text": "Deploys go out from the main branch only.",
  "decision": "add",
  "source": "Decided in the 2026-09-02 release sync"
}
```

- `decision` omitted or `propose`: nothing is written; matching existing facts
  come back as `candidates` with a hint to re-call with `add` or `supersede`.
- `add`: writes a new fact (an exact duplicate returns the existing record).
- `supersede`: requires `predecessor_uri` and `predecessor_hash` taken from a
  recalled fact (`[gno://...] (contentHash ...)` in the injected context).

Writes are refused in non-primary agent contexts (`cron`, `subagent`,
`flush`), matching the other Hermes providers.

Every `gno_remember` call after a recall in the same session presents that
recall's receipt (`gno remember --receipt <file>`): the provider keeps the
latest `recall --json` receipt per session, writes it to a `0600` temp file
for the duration of the call, and removes it afterwards. GNO uses it to
reject a recalled span replayed as a "new" fact (`MEMORY_FENCED_REPLAY`);
recalled spans are context, not new facts. A session switch drops the
receipt, and a remember before any recall carries none.

## Verify

```bash
hermes chat -q "Remember that we deploy from the main branch only. Store it with gno_remember, decision add."
hermes chat -q "Which branch do we deploy from?"
# Hermes prints "🧠 GNO recalled 1 memory" before the answer; the injected
# block is stored as api_content on the user row:
hermes sessions export --format jsonl --session-id <id> - | grep -c '<memory-context>'
```

## Tests

Deterministic unit suite with a faked `gno` subprocess (flag mapping, receipt
forwarding, timeout, malformed JSON, below-minimum version, missing binary,
default-no-write):

```bash
bun test integrations/hermes-gno-memory
```

`test/harness.py` drives the provider exactly as Hermes does, using
`test/stubs/agent/memory_provider.py` in place of the Hermes runtime.
