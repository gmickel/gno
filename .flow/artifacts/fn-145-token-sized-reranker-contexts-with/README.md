# fn-145.3 native parity evidence — incomplete acceptance

Implementation commit: `d608b2c2`. Task remains **in_progress**: real hybrid/Ask
paired acceptance is unmet. CUDA direct reranker parity succeeds; physical Metal
pressure and SDK lifecycle failures remain visible. No resource-improvement,
full-surface readiness or fn-144 original-scope fix claim.

## Identity and coverage

- Product baseline: `270c3a74f4f7a3aeb8a60462b4c8e1b4adf45462`; archive SHA256
  `ca991b29e0e23451290b82f8999fbca8725f20e4ac684e2acbc09ead9fd86d73`.
- Product candidate: `df9ffe64a89bcae3fdd13701d0914dd3b3a8c2c3`; archive SHA256
  `2631d4cf97e103533950f7f1723dc31f1b5952af3d54f9448dde41d5c8e5a7ec`.
  These are archived committed sources, not the changing shared checkout.
- Both: Bun 1.3.14, node-llama-cpp 3.19.1. Reranker cached GGUF/tokenizer SHA256
  `22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48`.
  Surface side manifests retain exact embedding/generation model hashes too.
- CUDA: all 45 historical cells, 69 historical pairs, 122 historical scores,
  plus five additions; 74 exact paired comparisons / 148 actual port calls.
  Full actual native token streams, texts, order and unrounded scores survive in
  `rerank/cuda-native.json.gz`. Comparator has zero historical/input/order drift.
  The 6025-token full pair is scored at candidate6400 versus auto40960; short
  shrink512, retained duplicate ties, unsupported-template auto40960 and model
  restart also compare exactly. Watchdog exit0, 36.7105 seconds.
- Physical Ivan direct rerank: pressure2 stop, exit-15 after1.7463 seconds, zero
  completed rows. No favorable retry; Metal parity remains incomplete.
- SDK: supplementary synthetic 30-document orchid corpus, independent side DB
  backups with shared physical provenance. Short hybrid → long hybrid → short
  hybrid → verified Ask → 2500ms idle → verified Ask. Explicit TTL1200,
  noExpand=true, noRerank=false, graph=false, limit3 and default Ask budgets.
  This is an expiry stratum, not default TTL300000. Config, case, corpus and model
  identities are in compressed plans, `init.json`, and side manifests; artifact
  and original-file hashes are in `SHA256SUMS.json`.

## Preserved limitations and failures

Direct CUDA uses real product rerank ports and one real shared loaded model with
a minimal manager wrapper, serial scoring and native input/context instrumentation.
It does not prove the full lifecycle manager. Idle retained contexts may coexist;
host load was not isolated. Every pair remains included. Candidate was slower in:
EN-4000-start-repeat-0, DE-1000-start-repeat-0, DE-4000-start-repeat-0,
CJK-4000-start-repeat-0, long-query-full-pair, shrink-after-long-query and
unsupported-template. No timing rows were discarded or rerun to improve results.

Metal SDK baseline pressure-stops without a complete record. Corrected candidate
produces five records, only the three hybrid requests complete, with actual
768→3840→768 context sizes. Both Ask generation calls fail disposed-state and
invoke no semantic judge. CUDA corrected baseline completes two of three hybrid
records, with disposed-state long-query fallback, then aborts in Ask with
`pure virtual method called`. CUDA corrected candidate aborts before its first
record with native/Bun crash. Both paired surface comparators have zero comparable
pairs and five missing-case failures. Actual citations/spans remain in raw records;
missing baseline results cannot be treated as equality.

The first surface fixture used `index.sqlite`, making Ask reject provenance as
belonging to index rather than default. V2 preserves `index-default.sqlite` and
uses fresh synthetic backups. V1 watchdogs and representative fixture-failure Ask
records remain included. V2 failures are native findings, not the fixture bug.
The long surface query also triggers existing embedding truncation; no QA-side
rerank clipping was added. Surface context changes coincide with short-TTL model
retirement, so they do not independently prove same-model context reuse.

`surfaces/SUMMARY.md.gz` contains the detailed run matrix. Full corrected raw
records, context events, failed watchdog stderr/exit receipts and representative
V1 failures are curated. No database, model weights, private corpus or live config
is included. All original evidence remains under `notes/fn145-qa/`; physical
surface originals remain under Ivan `/tmp/fn145-qa-surfaces` and direct rerank
under `/tmp/fn145-qa-rerank`. Both GPU slots were released; no new run is scheduled.

## Reproduction and integrity

All payloads are gzip-compressed exact source bytes; existing gzip records are
copied unchanged. `SHA256SUMS.json` maps each artifact to its SHA256, original
absolute source path, original SHA256 and transform. README is generated; the
hash manifest excludes itself. Decode a receipt without modifying it:

```sh
gzip -dc .flow/artifacts/fn-145-token-sized-reranker-contexts-with/rerank/cuda-comparison.json.gz
```

`rerank/{native.ts,metal-native.ts,compare.ts}.gz`,
`reproduction/watchdog.py.gz` and the surface preparation/runner helpers retain
the exact used procedure. Native watchdog receipts retain full command arrays.
Original CUDA invocation:

```sh
TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn145-scenarios python3 notes/fn143-native-tmp/qa-prep/watchdog.py notes/fn145-qa/cuda-native 300 12000 bun notes/fn145-qa/native.ts
```

This command documents the existing run; do not execute against its receipt root.
Future work requires new isolated roots, the same pinned archives/cached models,
explicit GPU ownership and finite owned-process watchdogs. Physical Metal requires
pressure1 and stops at2; no live index, service, config, download or uncontrolled
process termination. Do not alter models, context policy, candidate depth, inputs,
fixture hashes or comparator fields to obtain a pass. Default-TTL and integrated
fn-144 hybrid/Ask acceptance remain future work.
