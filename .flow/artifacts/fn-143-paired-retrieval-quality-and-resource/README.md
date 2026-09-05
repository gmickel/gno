# fn143 curated synthetic acceptance evidence

Harness implementation complete; original native readiness **HOLD / NEEDS_WORK**. These are unchanged-source controls, not evidence of an optimized product fix. Implementation commits: `a1a7417f` and documentation-gate correction `b50bf6cc`.

The seven pre-existing artifacts are preserved. Added evidence includes actual native raw verified/expanded pairs, exact comparison and negative-control outcomes, compressed full warm30/lifecycle reports, source manifests, resource failure receipts and gate logs. No SQLite databases, private documents or live configuration are included. Full raw logs, response captures, scratch scripts and independent indexes remain under `/home/gordon/work/gno/notes/fn143-native-tmp/`; Ivan originals remain in isolated `/tmp` roots. `curation-sources.json` maps every copied addition to its original and source hash. `SHA256SUMS.json` covers every artifact except itself.

## Source and fixture identity

- Both product roles: archived `270c3a74f4f7a3aeb8a60462b4c8e1b4adf45462`, GNO1.46.0; Bun1.3.14, node-llama-cpp3.19.1. Development acceptance helpers supplement the snapshot; archive verification excludes those helpers and verifies product bytes/link targets.
- Source archive SHA256: `ca991b29e0e23451290b82f8999fbca8725f20e4ac684e2acbc09ead9fd86d73`.
- Local archive `/tmp/gno-native-baseline-20260905-gmyi58ts/source.tar`; selected source `/home/gordon/work/gno/notes/fn143-native-tmp/qa-prep/snapshot-source`.
- Ivan archive `/tmp/gno-native-baseline-20260905.VQtXt5/source.tar`; selected source sibling `source/`; Bun `/tmp/gno-native-tools-1314.KrONBb/bun-darwin-aarch64/bun`. Live Bun installation unchanged.
- Primary fixture `gno-acceptance-fixtures-v1`, serialized fixture SHA256 `dc310b7cf0680967942b9e142bc0c141f01d2fc8fffb78226fcfe5a7555da367`. It has296documents/51scenarios; native main control selects and embeds only the two-document `rerank-en-1000-start` collection. Other documents remain indexed but unembedded. This is limited scenario coverage.
- Supplementary orchid fixture `gno-acceptance-qa-orchid-v1`,30documents; corpus hash `3006296a685a7f917d3311af9befcb7fdf4fb89c135dc36784d919d95dda9c5f`, query hash `7ac8f1dd2e1607191e5989e72b2bc5690469fe6ebbc5be66f966095640fda55d`, oracle hash `d170b7f7ec6bdace780095cf0858023bcc0ec9df54202f49af64b79da1bf60bb`.
- Independent side indexes share the same physical synthetic corpus provenance root within each platform pair. Absolute paths, mtimes and hashes remain in comparisons. Models/tokenizers are GGUF-hash pinned in included manifests; cached files only, explicit CUDA/Metal, no download/build.

## Exact reproduction entrypoints

Existing receipts must not be overwritten. To inspect the original native commands, decompress the full reports and read `command.config`, then side watchdog receipts in the source paths. The command verifies archive identity, manifests, fixtures, request bindings and cached models before running:

```bash
cd /home/gordon/work/gno
bun scripts/retrieval-acceptance.ts --config /home/gordon/work/gno/notes/fn143-native-tmp/qa-prep/runs/cuda-control-01/warm30/run.json --native
ssh Ivan '/tmp/gno-native-tools-1314.KrONBb/bun-darwin-aarch64/bun /tmp/gno-native-baseline-20260905.VQtXt5/source/scripts/retrieval-acceptance.ts --config /tmp/fn143-control-metal-01/warm30-embedding-only/run.json --native'
```

These commands document the original invocation; new runs require new output/protocol roots and freshly pinned checkpointed independent indexes. Do not execute against old receipt roots. Setup/probe sources: `notes/fn143-native-tmp/qa-prep/{materialize,seed-index,seed-native,freeze,variant,one-shot,command-plan}.ts`, `watchdog.py`, `orchid-run.py`, `expanded-cuda.py`; retained-session setup: sibling `state-screens/prepare.py` and `qa-prep/lifecycle/prepare.py`. Native execution needs explicit authorization and one workload owner per GPU. No further native probes are scheduled before fn144 implementation.

## Observations and limits

CUDA true-rerank SDK and all four public surfaces have complete equal controls. Metal explicit embedding-only SDK and three public surfaces have complete equal controls; Metal CLI candidate crashed and remains incomplete. Default Metal rerank pressure failure is retained, not reclassified as embedding-only success. Both platforms' orchid verified Ask invokes the semantic judge once; equal uncertain-claim abstention is valid verification-path coverage.

Warm30: CUDA50/60 records,20/30 paired comparisons pass; Metal57/60 records,27/30 pass. Native child failures leave both reports incomplete and summaries empty. No percentile, speedup or readiness claim. CUDA matched uninstrumented diagnostic completed10sessions/20queries; this does not establish whether capture or product/native internals caused instrumented failures.

Lifecycle reports retain fresh/model-cold, repeated/novel warm, real two-owned-session overlap and postidle state/resource observations. One-block screens are inconclusive; CUDA cold/novel native aborts remain incomplete. Explicit short-TTL SDK reacquisition succeeds on both platforms; earlier retained-port/API disposed-state failures remain separate, unresolved baseline evidence.

CUDA expanded orchid captures actual expansion model prompt/output, embedding and rerank. Both generated outputs end mid-JSON, capability expansion_error; exact comparison passes but native coverage remains incomplete. Supplementary Metal expansion pressure-stops before a completed record. The original143document expanded/reranked failure remains distinct; smaller fixtures do not replace its acceptance requirement.

## Gates

- Full tests:4844pass,2existing skips,0fail,36959assertions,562files.
- Full lint/format:0errors,15warnings; formatting passes.
- Corrected public-truth docs gate:15pass,0fail,2uncached-model skips.
- Memory gate:100%.
- Existing lexical hybrid:86%; lexical vsearch:88%. These are not native embedding/rerank promotion evidence.

Compressed exact gate logs are included. `native-QA-SUMMARY.md`, platform lifecycle summaries and report JSON contain the detailed limitations. Resource failures were neither retried for favorable selection nor omitted; no thresholds, product contexts, models or fixture golden expectations were reduced.
