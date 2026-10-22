---
title: CLI user can't check egress for all collections — gno collection policy check wi
date: "2026-10-22"
track: bug
category: integration
module: src/cli/program.ts collection policy check
tags: [qa, fn-226, egress]
problem_type: integration
symptoms: Invalid egress policy check (exit 1) at any collection count when no -c is given
root_cause: (observed via live QA — unconfirmed)
resolution_type: fix
related_to: [bug/integration/reader-opens-a-relative-markdown-note-2026-09-05]
---

## Problem
A user checking an egress decision for all collections with `gno collection policy check` (no `-c`) always gets a validation error, at any collection count.

## Steps to reproduce (cold)
1. Sealed sandbox config with 64 collections (`~/.cache/agent-work/qa-fn226/cfg-64`), no `-c` flag.
2. `gno collection policy check --action export --destination remote --content-class source --authenticated --authorized --json`
3. Observe stdout and exit code.

## Expected
spec/mcp.md: "omitted scope means all configured collections." `spec/cli.md` documents `-c <name>...` as optional.

## Actual
`{"error":{"code":"VALIDATION","message":"Invalid egress policy check"}}`, exit 1, at 64, 65 and 129 collections, on main (5eaad246) and on the fn-226 branch. The CLI passes its `-c` default `[]` as an explicit empty scope (`src/cli/program.ts` `collectionPolicyCmd.command("check")`), and the service rejects an empty explicit list. Pre-existing; not caused by fn-226.

## Evidence
- console: .flow/tmp/qa-fn-226-egress-collection-limits-deny-cleanly/surfaces-main.log, surfaces-branch.log ("policy check unscoped")
- url: n/a (CLI)

## Traceability
- R-IDs: [] (regression; outside fn-226 scope)   scenario: S6   driver_rung: CLI   viewport: n/a
