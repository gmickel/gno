# Frozen Imported Corpora

This directory contains committed imported corpora used by the retrieval
fine-tuning sandbox.

Current contents:

- `qmd-import.jsonl` - frozen imported snapshot from qmd's finetune data,
  adapted into GNO's training schema
- `qmd-import-report.json` - counts from the snapshot import/filter pass

## Why this is committed

The sandbox should be reproducible from this repo alone.

That means:

- no routine dependence on a sibling local checkout like `~/repos/qmd`
- no hidden absolute-path requirement to build mix datasets
- future finetune runs can reuse the same imported seed corpus directly

## Snapshot status

Treat `qmd-import.jsonl` as a frozen snapshot.

- use it directly in mix configs
- do not assume it should be regenerated before normal experiments
- historical `source.provenance` paths inside the JSONL point at the machine
  that created the snapshot; they are provenance metadata, not an active runtime
  dependency

## What was adapted on import

The import pass did more than copy upstream records:

- converted qmd `lex` / `vec` / `hyde` tuples into GNO's training schema
- deduplicated lexical/vector outputs
- capped each output family
- extracted query constraints:
  - quoted phrases
  - negations
  - critical entities
- filtered obvious temporal/release-drift examples

See:

- `../../scripts/import-qmd-training.ts`
- `../../lib/mlx-training.ts`
- `qmd-import-report.json`

## Relationship to GNO-specific data

This snapshot is only seed data.

The actual training mixes augment it with GNO-specific corpora such as:

- `../training/gno-hardcases.jsonl`
- `../training/gno-multilingual-hardcases.jsonl`
- `../training/gno-disambiguation-hardcases.jsonl`
- `../training/gno-lexical-preservation-hardcases.jsonl`
- `../training/gno-ask-hardcases.jsonl`

That is why current mix configs are still GNO-first even when they reuse qmd
examples.

## License / provenance

The upstream qmd repo is MIT-licensed. This directory intentionally keeps the
imported snapshot plus provenance notes so the corpus remains usable without a
live cross-repo dependency.

## Legacy regeneration

Regeneration is legacy/maintenance work, not part of normal finetune runs.

If you intentionally want to refresh the snapshot from an explicit qmd checkout:

```bash
QMD_FINETUNE_ROOT=/abs/path/to/qmd/finetune \
  bun run research:finetune:qmd-import:legacy
```

Or:

```bash
bun research/finetune/scripts/import-qmd-training.ts /abs/path/to/qmd/finetune
```

After any intentional refresh:

1. inspect `qmd-import-report.json`
2. rebuild any affected mix datasets
3. record the provenance/rationale in `research/finetune/runs/`
