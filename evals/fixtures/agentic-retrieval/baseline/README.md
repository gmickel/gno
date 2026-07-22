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

`optional/qmd/` and `optional/local-model/` are non-authoritative local lanes.
They may be written only as complete matrices and never replace
`fixture-agent/`. qmd requires the exact checkout and model cache declared in
`qmd.lock.json`. The local-model lane requires the exact cached file declared in
`agent-model.lock.json` and always runs its three pinned paired trials.

Filtered, partial, duplicate, unknown, or mixed-lane `--write` requests are
refused before adapter preparation.
