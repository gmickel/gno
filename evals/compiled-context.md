# Compiled context paired handoff evaluation

The preparation command builds isolated synthetic SQLite indexes and renders
both handoff formats from the same Capsule. It records deterministic rendering,
whole-output bounds, required citations/evidence, scope revocation and source
staleness checks. It does not change the normal GNO configuration or index.

```sh
bun evals/compiled-context-prepare.ts /absolute/new/run-directory
python3 evals/compiled-context-reader.py /absolute/new/run-directory
```

Preparation refuses to overwrite `prepared.json`; the reader refuses to overwrite
individual draw receipts. Read `fixtures/compiled-context/PREREGISTER.md` before
running. The original six cases, model and thresholds are frozen; preserve failed
preparations and adverse draws. A different study needs a separately registered
fixture/model configuration, not overwritten results.

The reader uses `~/work/agent-evals/lib/evalkit.py` and an authenticated `cl2`
Claude subscription profile. It invokes the installed Claude CLI without tools,
MCP servers, project settings or persistent sessions. Model identity is checked
from every response. No API key is consumed. It uses three draws per case per
arm and retains prompts, raw stdout/stderr, provider usage and scored answers.
These are synthetic fixtures, but run directories should still remain local.

The primary endpoint requires all answers and all required citations to be
correct. Required abstention is scored separately from ordinary unanswered
questions. Equal success is non-regression, not superiority. Source inclusion
failures can originate in the baseline Capsule selection; the report retains
those failures rather than attributing every missing source to compilation.

The report's `gatePassed` requires valid draws, exact preparation guards,
per-case non-regression and lower median conservative handoff cost. The distinct
`superiority` field uses evalkit's variance-aware paired decision rule. Neither
result establishes broader retrieval quality, automatic integration safety or
production model performance. Conservative handoff cost uses UTF-8 bytes for
the Capsule's recorded `unicode_conservative` estimator; provider token counts
include CLI/system framing and caching and are reported separately.
