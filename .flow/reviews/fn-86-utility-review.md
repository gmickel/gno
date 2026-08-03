# fn-86 utility and false-positive review

Date: 2026-08-03

## Runtime evidence

The default live index was opened query-only. No source, config, index, graph,
daemon, or audit-baseline writes were permitted. The final `all` run examined
61,528 document/rule observations in 122 ms report time (0.21 s wall), retained
exact totals, and bounded the returned payload to 100 findings.

The first inventory-scale link run took 12.71 s. Profiling isolated the
seed-oriented ranked SQL target resolver. An adaptive linear bulk resolver
reduced the same run to 0.17 s. A live parity comparison across all 2,325 unique
targets found zero result, rank, ambiguity-count, or selected-target mismatches.

## Category review

- Links: 1,908 unresolved/broken targets, 39 ambiguous targets, and 281
  policy-defined orphans. Samples were actionable and grounded in exact source
  URI plus line/column evidence. Legacy/intentional unresolved links can still
  create volume, so users should scope by collection/path and define orphan
  roots/ignored prefixes; v1 deliberately has no suppression database.
- Provenance: the first live run reported 4,973 logical-record issues. Review
  found a real false-positive class: ordinary converted Markdown documents
  carry generic converter identity but do not declare the logical-record
  contract. A second false-positive class treated an ordinary YAML `source:`
  URL list as CaptureSource provenance. Both declaration boundaries were fixed
  with regressions. The rerun produced zero provenance findings and two honest
  skips because this index currently declares neither contract.
- Freshness: four findings remained—three indexed conversion-error states and
  one source/index content-hash drift. Sampled evidence matched observable index
  and filesystem state. The age rule skipped without an explicit policy.

Disposable integration fixtures additionally proved clean, findings,
unavailable, cancelled, and repeatedly changed snapshots; stable finding IDs;
exact totals under truncation; CLI exit 0/4/5; MCP partial-state parity; and
unchanged source/config/database hashes plus SQLite `total_changes()`.

## Decision

The read-only audit is useful enough to ship after the provenance declaration
fixes. A separate maintenance discovery is justified by the high real link
volume, but not an apply feature yet. That discovery should first test grouped
triage, caller-owned baselines/suppressions, and safe preview semantics against
real review behavior. It must reuse fn-60 reference-safe mutation and remain a
separate user-authorized spec. No maintenance, contradiction, scheduling,
repair, suppression, or mutation work was created by fn-86.

## Skill evaluation

The required autoresearch command ran, but Claude Code returned `Failed to
authenticate: OAuth session expired and could not be refreshed` before every
case. The resulting 0/47 is an infrastructure failure, not a skill score. The
audit guidance was still reconciled across the experiment source, canonical
asset, Claude project skill, and Codex project skill; deterministic docs parity
passed. Re-run autoresearch after Claude authentication is restored.

## Hosted documentation QA

The gno.sh source adds dedicated `/docs/integrity-audits` and
`/features/integrity-audits` pages, the docs navigation entry, CLI command
chooser coverage, and corrected MCP tool totals. The first production build
revealed that both dynamic slugs were absent from the explicit prerender and
sitemap registry; the registry was corrected before handoff. A clean rebuild
prerendered 94 pages, including both audit routes.

The prerendered output was then driven in a fresh browser session at desktop
and 390 x 844 mobile widths. Both pages rendered with their expected headings,
navigation, related links, and command controls; the feature-page copy control
was exercised; the CLI page exposed `gno audit`; and the isolated session
reported no page errors. Captured evidence lives under
`.flow/reviews/fn-86-site-evidence/`.
