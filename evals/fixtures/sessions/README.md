# Sessions eval fixtures

Fixtures for `bun run eval:sessions` (`evals/sessions.eval.ts`). Every string
is synthetic placeholder dialogue; every credential-shaped value is fake and
exists only to exercise redaction. Nothing was copied from a real session
store.

| Path                     | Contents                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `native/codex/`          | Rollout JSONL: item-shape main thread, spawned subagent with copied history, `exec` run, legacy 0.58 shape             |
| `native/claude-code/`    | Project JSONL: `origin`-era main thread plus subagent file, pre-`origin` legacy thread                                 |
| `native/openclaw/`       | Legacy session JSONL                                                                                                   |
| `sql/openclaw-agent.sql` | Agent store (two transcript windows with a copied entry, spawned subagent); materialized into a temp SQLite file       |
| `sql/hermes-state.sql`   | `state.db` (in-place compaction, rewound row, delegated subagent); materialized into a temp SQLite file                |
| `gold/turns.json`        | Manually normalized gold: hand-written per-turn records (native identity, locator, role, time, project, redacted text) |
| `cases.json`             | Sources, expected unit outcomes, secrets, never-human noise strings, exact lookups, held-out questions                 |
| `manifest.json`          | sha256 pins for every file above                                                                                       |

The corpus covers three projects. `/work/a/api` and `/work/b/api` share the
basename `api` across harnesses (a project collision that only `project-id/*`
separates); `/work/c/billing` is the third. Human decisions are contradicted by
assistant suggestions in every harness, and each native file carries injected
context or task prompts that must never be archived as human speech.

The gold archive is written by hand from the native fixtures, not from
pipeline output. Its structure is its own: threads with native identity
(harness, source profile, native thread id, root `parent`, kind, working
directory, native unit) holding per-turn records (native logical turn id,
native locator, role, UTC time, text). The `normalization` list in the file
states the rules. Credential values
appear as the literal `[REDACTED]`; the eval accepts any `[REDACTED...]` marker
in that position and nothing else. The eval indexes the gold as JSONL records
that carry the identical mandatory record envelope of the archive format
(title shape, speaker prefix, one-line provenance block, categories), so both
arms spend the same envelope bytes under the same retrieval and capsule budget
(the R6 "same usable budget" definition; see `evals/helpers/sessions-harness.ts`).
Both arms are judged against these records.

Turn keys in `cases.json` are `<harness>/<source id>/<native thread id>#<native
logical turn id>`. `projectIds` holds the expected pipeline `project-id/*`
value per working directory; questions filter by directory through that tag in
both arms.

After any fixture edit, review the diff and re-pin:

```bash
bun scripts/sessions-eval-fixtures.ts
```

Never edit a fixture or the gold archive to make the pipeline arm pass; a
failing row is a finding against `src/sessions`.
