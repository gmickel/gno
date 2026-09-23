# Compiled-context paired handoff evaluation

Frozen before any reader draw. Base source revision:
8cd2099f6bc62c026faa95ba3834a51d3238c74f; source and fixture SHA256 manifest
is retained with the run because the implementation is not yet committed.
All fixtures below are original synthetic data, not external vendored material.

Primary endpoint: per-case grounded success (every keyed YES/NO/NOT SPECIFIED
answer correct and every required source URI cited). Six held-out task cases,
three independent draws per arm, identical reader instruction and questions.
The only variable is canonical Capsule JSON versus deterministic compiled
Markdown from that exact Capsule. Both use a fixed 12,000 conservative token
and 12,000 byte handoff ceiling. No truncation of either arm. A preparation
failure is a failed gate, never a reason to substitute an easier fixture.

Reader: claude-sonnet-4-5-20250929 through cl2 subscription, no tools/MCP,
no session persistence, custom system instruction; CLI sampling defaults
fixed for both arms (CLI exposes no temperature control). Verify actual model
identity in each raw result. Alternate arm order, concurrency two. Draw timeout
180 seconds; transport failures retained and make result incomplete, not zero
or a replacement draw. No subject receives sealed keys or an arm label.

Decision: exact deterministic, citation, privacy, whole-budget and stale-detection
guards must all pass. Compiled grounded-success count must be at least baseline
both pooled and in EVERY held-out case; required source URIs/evidence must not
regress. Report abstention accuracy independently; silence cannot pass factual
cases. Report all cells and adverse draws, omissions, whole-handoff conservative
cost and provider usage separately. A positive non-regression result licenses
explicit manual export only. It does not license automatic integration, broader
accuracy claims, retrieval improvements or changed defaults.

Use agent-evals/lib/evalkit.py for mechanical truth stripping, parsing, shared
scoring, discriminating subset, and paired superiority verdict (minimum pooled
gap 0.05). Equal success is non-regression but NOT superiority; inconclusive
variance remains inconclusive. Missing-evidence abstention items use the same
exact NOT SPECIFIED rule in both arms, outside evalkit's YES/NO truth parser.
No cherry-picked subsets; injection/abstention/budget cases all remain included.
The candidate is useful only if non-regression passes and median conservative
handoff cost is lower. Otherwise report failure/inconclusive and withhold any
automatic integration recommendation. No fixture or threshold edits after draws.
