# Agentic Retrieval Baselines

`fixture-agent/` is the only authoritative deterministic baseline. It is
generated from an otherwise-clean committed checkout with:

```bash
bun run eval:agentic -- --agent fixture --adapter gno-mcp,lexical,capsule --lifecycle cold,warm --write
```

The lane contains exactly 24 tasks × 3 adapters × 2 lifecycles = 144 main
receipts, plus 48 unchanged-input Capsule replay records. `report.json` is the
closed schema-valid report; `canonical.json` is its observation-free canonical
projection; `observations.json` holds environment and timing data with temporary
paths projected to `<temp>`; `report.md` is the readable summary.

`verified-ask-promotion.json` is the separate attributable 22-pair outcome
lane: production raw Ask baseline versus production `buildVerifiedAsk`
candidate under the same native index, retrieval request, deterministic answer
agent, and initial draft. Its gate requires no answer-accuracy regression and
strictly fewer unsupported substantive claims. `verified-ask-promotion.md` is
the readable projection. These files do not rename or replace the Capsule
retrieval metrics in `report.json`.

`content-type-boost-promotion.json` is a separate 24-task fn-97
backward-compatibility receipt. It requires byte-identical ordered evidence and
zero required-evidence accuracy/coverage loss when the shipped boost seam sees
no configured rules. Active-rule behavior is gated by deterministic adversarial
pipeline tests; this receipt does not claim an active quality gain.

`optional/qmd/` and `optional/local-model/` are non-authoritative local lanes.
They may be written only as complete matrices and never replace
`fixture-agent/`. qmd requires the exact checkout and model cache declared in
`qmd.lock.json`. The local-model lane requires the exact cached file declared in
`agent-model.lock.json` and always runs its three pinned paired trials.

Filtered, partial, duplicate, unknown, or mixed-lane `--write` requests are
refused before adapter preparation.
