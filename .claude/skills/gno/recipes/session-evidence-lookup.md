# Sessions: Find What Was Said or Decided

Use this recipe when the user asks what was discussed, proposed, or decided
in earlier coding-agent sessions (Codex, Claude Code, OpenClaw, Hermes), or
wants those sessions made searchable. Session turns are evidence of what was
said, not facts.

## Inputs

- The archive pair: one archive config file and its named index, for example
  `~/gno-sessions/archive.yml` with `--index sessions`. Ask the user for it
  when unknown; `sessions status` on the pair confirms it.
- What to find, in the words the conversation likely used.
- Scope: harness, project, role, or archive collection, when the user gives
  one.

Every archive command passes both flags explicitly, as below. Substitute the
user's own config path and index name.

## Workflow

1. Check the archive exists and is current.

```bash
gno --config ~/gno-sessions/archive.yml --index sessions sessions status --json
```

Broad search on the user's normal index does not include sessions. If there
is no archive yet, stop and offer the setup steps (step 5); never import on
your own initiative.

2. Search the archive, narrowest scope first.

```bash
gno --config ~/gno-sessions/archive.yml --index sessions search "<decision words>" --author human --tags-all project/<name> --json
gno --config ~/gno-sessions/archive.yml --index sessions query "<question>" --category harness/codex -n 10 --json
gno --config ~/gno-sessions/archive.yml --index sessions search "<words>" -c <archive-collection> --tags-all role/assistant --json
```

Tags: `harness/<codex|claude-code|openclaw|hermes>`, `role/<human|assistant>`,
`project/<basename>`, `project-id/<hash>`, `session-kind/<main|subagent|fork|continuation>`.
`--since`/`--until` filter on import time, not on when the turn was said.
Import does not embed: run `embed` on the same pair before relying on
`query`/`vsearch`.

3. Read the full turn.

```bash
gno --config ~/gno-sessions/archive.yml --index sessions get "<uri from the result, including ?index=sessions>"
```

The body starts with `Human:` or `Assistant:` and ends with a
`Session provenance` block (speaker, recorded time or `unknown`, harness,
thread, project). Keep the `?index=` query string on every URI.

4. Answer with attribution.
   - A human turn is what the person said or decided.
   - An assistant turn is a proposal ("the agent suggested ..."), never the
     user's decision.
   - Cite each turn by its `gno://` URI. State the recorded time from the
     provenance block; say "time unknown" when it says so.

5. Setup or refresh, only when the user asks.

```bash
gno sessions discover   # preview; imports nothing
gno --config ~/gno-sessions/archive.yml --index sessions sessions init --archive ~/gno-sessions/archive --collection sessions-work
gno --config ~/gno-sessions/archive.yml --index sessions sessions source add codex --harness codex --path ~/.codex/sessions --collection sessions-work
gno --config ~/gno-sessions/archive.yml --index sessions sessions import --source codex --dry-run   # show the receipt first
gno --config ~/gno-sessions/archive.yml --index sessions sessions import --source codex --json
```

Keep the archive outside the curated vault and use one collection per
privacy boundary (`--project <prefix>=<collection>` for per-project
routing). Reruns are incremental; a `partial` receipt with `truncated_tail`
or `format_drift` units is retried by the next import. `SESSIONS_BUSY`: wait
for the running import. `--limit <n>` bounds a large first import.

## Guardrails

- Never pass the archive config without its `--index`, or the archive index
  with another config: both fail with `SESSIONS_BINDING_MISMATCH`.
- Do not store a session turn as a fact automatically. If the user wants a
  decision remembered, use `recipes/memory-file-decision.md` with the human
  turn's URI as `--source`.
- Redaction is best effort. Do not paste archive text into external channels
  without the user's approval; respect collection egress policy.
- Mixed retrieval (archive folder registered in the curated config) is the
  user's explicit choice; do not set it up unasked.

## Done

- Evidence cited by `gno://` URI with speaker and time, or an explicit "not
  found in the session archive".
- Assistant proposals distinguished from human decisions.
- No import, registration, or memory write without the user's request.
