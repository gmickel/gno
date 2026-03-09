# Training Data

Place labeled expansion examples here.

Rules:

- JSONL only
- every line must validate against `../../schemas/expansion-training-example.schema.json`
- no heldout promotion cases here
- keep provenance in `source.name` / `source.kind`

Recommended files:

- `handcrafted.jsonl`
- `synthetic.jsonl`
- `hard-cases.jsonl`
- `generated/qmd-import.jsonl`

Not committed yet:

- large generated corpora
- model outputs
- checkpoints
