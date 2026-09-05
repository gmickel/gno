# Reproducible native-call attribution

The frozen CUDA matrix proves zero passage inference for unchanged and both restoration sessions, with query inference and init/dispose work counted separately. The report explains the uniquely derived case-to-child mapping and its limits. No GPU is needed to reproduce this analysis.

## Files and provenance

- `report.original.md`, `attribution.original.json`, `attribute.original.py`: byte-preserving copies of the accepted report, derived result and original CPU analyzer. Their machine-local paths describe the original run and remain unchanged.
- `attribute.py`: the same analyzer with only input/output path resolution changed. It reads the committed CUDA artifact tree and local old snapshots, then writes `attribution.reproduced.json` in this directory. It does not import GNO or initialize native bindings.
- `verify-reproduction.py`: requires exact equality of original and reproduced JSON after removing only the analyzer's own path and hash fields.
- `old-snapshots/matrix-<case>.json`: all 12 original baseline snapshots, copied without reserialization. The analyzer reads all 12, explicitly excludes the three incomplete old pairs and verifies nine complete pairs.
- `reproduction.stdout`: retained successful CPU analyzer output.
- `SHA256SUMS`: every other file in this subtree, including raw snapshots and the adapted analyzer. Verify from this directory with `sha256sum -c SHA256SUMS`.

The existing CUDA artifacts are not duplicated here. Relative dependency: `../../fn-144-native-recovery-and-idle-inference/cuda-3d9c0ec4/`, with sibling `cuda-3d9c0ec4.sha256.json`. The analyzer verifies that entire manifest before deriving results. Its essential inputs are exact `matrix.ts`, `evidence/sdk-matrix.capture.json`, the child birth/exit and sent-request ledgers in `evidence/sdk-matrix.capture.json.children/`, `evidence/phases/*.jsonl`, public stdout, matrix summary and per-case snapshots.

Candidate product commit is `3d9c0ec49c502ab0c3470c7df14ddac8123ad8d9`. The original baseline snapshots came from `/home/gordon/.cache/agent-tmp/gno-fn147-nativeqa/evidence/` at `2beb8aaeafd0fd84d16111cbda3d8ec35a44ee6e`. The analyzer/report source copies came from `/home/gordon/.cache/agent-tmp/gno-fn147-call-attribution/attribute.py` and `notes/fn147-native-call-attribution.{md,json}`.

## Reproduce from any checkout location

Run from the repository root:

```sh
python3 .flow/artifacts/fn-147-restoration-and-unchanged-embedding/native-call-attribution/attribute.py
python3 .flow/artifacts/fn-147-restoration-and-unchanged-embedding/native-call-attribution/verify-reproduction.py
```

Both commands exited 0 during curation. Derived output is exactly equal after accounting for the changed analyzer location/hash. No baseline fields, input bytes, vector hashes or counts are normalized.

## Evidence boundary

The new run contains raw actual native passage/query calls, input text, token arrays and output vectors. The old run contains stored input/vector hashes but **no raw per-call native transcript**. The nine-pair comparison therefore establishes exact stored hash parity and links the new actual calls to those hashes; it cannot establish old raw token/context equality. Old unchanged, absent-1 and title-rename pairs remain explicitly incomplete. Metadata initialization, simulator allocation and query embedding are not passage-inference calls. The final collection-global-catchup session includes its separately identified preceding collection-scoped embedding.
