# Session ingestion fixtures

Synthetic, dated format fixtures for the native session adapters. Every
string is placeholder text; the credential-shaped values are fake and exist
only to exercise redaction. No fixture was copied from a real session store.

| Harness     | Fixture                                                     | Format pinned                                    | Built from                                   |
| ----------- | ----------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------- |
| Codex       | `codex/rollout-2026-09-20…0001.jsonl`                       | CLI 0.156.1 `item_completed` speech items        | Structure of a local 0.156.1 store, 2026-09  |
| Codex       | `codex/rollout-2025-11-14…0002.jsonl`                       | CLI 0.58 legacy `user_message` / `agent_message` | Structure of a local 0.58 store, 2026-09     |
| Codex       | `codex/rollout-2026-09-21…0003.jsonl`                       | Spawned subagent fork with copied parent history | Structure of a local 0.156.1 store, 2026-09  |
| Codex       | `codex/rollout-2026-09-22…0004.jsonl`                       | `codex exec` run with a truncated final line     | Structure of a local 0.156.1 store, 2026-09  |
| Claude Code | `claude-code/projects/-work-alpha/…0001.jsonl` (+ subagent) | CLI 2.1.280 with `origin`, subagent file         | Structure of a local 2.1.280 store, 2026-09  |
| Claude Code | `claude-code/projects/-work-legacy/…0002.jsonl`             | Pre-`origin` records                             | Structure of older local records, 2026-09    |
| OpenClaw    | `openclaw/agents/main/sessions/…0001.jsonl`                 | Legacy JSONL session version 4                   | Upstream v2026.9.6 source (not installed)    |
| OpenClaw    | `sql/openclaw-agent-v2026.9.6.sql`                          | SQLite agent store, schema version 23            | Upstream v2026.9.6 source (not installed)    |
| Hermes      | `sql/hermes-state-v0.19.sql`                                | `state.db`, schema version 22                    | Installed v0.19.0 source; no populated store |

OpenClaw and Hermes fixtures are reconstructed from upstream schema
definitions because no populated store was available when they were written.
The SQL fixtures are loaded into temporary databases by the tests.
