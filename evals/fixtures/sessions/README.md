# Sessions eval fixtures

Fixtures for `bun run eval:sessions` (`evals/sessions.eval.ts`). Every string
is synthetic placeholder dialogue; every credential-shaped value is fake and
exists only to exercise redaction. Nothing was copied from a real session
store.

| Path                     | Contents                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `native/codex/`          | Rollout JSONL: item-shape main thread, spawned subagent with copied history, `exec` run, legacy 0.58 shape       |
| `native/claude-code/`    | Project JSONL: `origin`-era main thread plus subagent file, pre-`origin` legacy thread                           |
| `native/openclaw/`       | Legacy session JSONL                                                                                             |
| `sql/openclaw-agent.sql` | Agent store (two transcript windows with a copied entry, spawned subagent); materialized into a temp SQLite file |
| `sql/hermes-state.sql`   | `state.db` (in-place compaction, rewound row, delegated subagent); materialized into a temp SQLite file          |
| `gold/work/`             | Manually normalized archive: the ideal archive lines for every speech turn, in the archive line layout           |
| `cases.json`             | Sources, expected unit outcomes, secrets, never-human noise strings, exact lookups, held-out questions           |
| `manifest.json`          | sha256 pins for every file above                                                                                 |

The corpus covers three projects. `/work/a/api` and `/work/b/api` share the
basename `api` across harnesses (a project collision that only `project-id/*`
separates); `/work/c/billing` is the third. Human decisions are contradicted by
assistant suggestions in every harness, and each native file carries injected
context or task prompts that must never be archived as human speech.

Turn keys in `cases.json` are `<archive threadId>#<native logical turn id>`.
The gold archive stores the same identity in `threadId` and
`provenance.turnId`, plus `provenance.format` for per-format reporting.

After any fixture edit, review the diff and re-pin:

```bash
bun scripts/sessions-eval-fixtures.ts
```

Never edit a fixture or the gold archive to make the pipeline arm pass; a
failing row is a finding against `src/sessions`.
