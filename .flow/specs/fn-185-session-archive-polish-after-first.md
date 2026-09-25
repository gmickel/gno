# Session archive polish after first release

## Goal & Context
<!-- scope: business; source: inferred -->

Live QA of native agent-session ingestion found small issues that lose no data and leak nothing, but make the archive surfaces inconsistent: a running server keeps listing a session source removed from the CLI, a keyboard action drops focus, and some JSON URIs omit the archive index qualifier that the docs tell callers to keep.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** [inferred] After a session source is added or removed through the CLI while `gno serve` runs on the same archive pair, the Sessions page and `/api/sessions/status` reflect the change without a restart, and Remove never fails on a source the page still lists. Errors: an unreadable config is reported, not silently served stale.
- **R2:** [inferred] Pressing Enter on "Discover local sources" keeps keyboard focus on a meaningful element (the discovery results or status region). Verify keyboard-only.
- **R3:** [inferred] Every archive document URI in JSON output carries the `?index=` qualifier, including `ask --json` `meta.answerContext.selected[].uri` and `gno ls --json` on the archive pair. Contract test covers each.
- **R4:** [inferred] Docs state how `pending` relates to the other unit counts in `sessions status`.

## Boundaries
<!-- scope: business -->

- [inferred] No new session features; fixes only.
