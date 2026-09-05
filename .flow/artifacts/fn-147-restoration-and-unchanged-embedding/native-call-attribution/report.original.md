# fn147.6: actual passage-inference attribution from the frozen CUDA matrix

**Unchanged, restored-1 and restored-2 each performed zero passage embedding requests and zero actual `getEmbeddingFor` passage invocations.** Each still performed one query embedding, two init requests and two dispose requests. The forced rebuild performed one passage batch containing three inputs, producing three actual passage `getEmbeddingFor` invocations. These counts come from the captured child calls, not public `embedded` counters.

This CPU-only analysis uses the existing successful CUDA run at source `3d9c0ec49c502ab0c3470c7df14ddac8123ad8d9`. No inference was rerun and no source, dependency, Git or Flow state was changed.

## Why the case-to-child mapping is unique

The capture originally labels all requests `sdk-matrix`. Case attribution is derived, not an original per-case annotation. The following independent constraints agree:

1. Exact `matrix.ts` SHA256 is `b63d7857fac2ebaf705e8ce6f9b248ae1b19de3e99a9eb5da8b421f844fd9634`. Its checkpoint function awaits original embed/search/vsearch/changes, closes that client, opens a fresh independent clean client, awaits update/embed/search/vsearch, closes it, writes the case receipt and then opens the next original client. All 12 checkpoints are awaited sequentially. There is one vsearch per side and no concurrent clients performing inference.
2. The retained public stdout and matrix summary contain the same 12 case names in the exact source order, with successful embedding and semantic pairs. The run exits 0 and capture errors are empty.
3. `sdk-matrix.capture.json.children/children.json` contains exactly 24 alternating birth/exit pairs. Every exit is 0; every identity belongs to parent PID 180407 and generation 1. There are no failed/replacement worker generations to shift the sequence.
4. Each child has exactly one query `embed` request with the exact instructed query bytes. Thus the 24 ordered single-query child sessions correspond to the source's 24 original/clean sessions. Child phase intervals do not overlap: each recorded process exit precedes the next child's phase-ready event.
5. All 138 sent requests in `requests.json` correspond one-to-one, in order, to complete native receipts. Per-child request IDs are contiguous from 1; request identity and payload match exactly. The request groups occur in birth order. No incomplete receipt, extra query session or missing child is silently excluded.

The analyzer verifies these constraints and the full curated artifact checksum manifest before assigning each ordered pair to a case. It does not infer case ownership from PID magnitude or elapsed-time proximity.

## Actual calls

`B / P / Q` means passage `embedBatch` requests / actual passage `getEmbeddingFor` calls / actual query `getEmbeddingFor` calls. Init and dispose requests are excluded from these columns and retained separately in the JSON.

| Case                              | Original PID | Original B / P / Q | Clean PID | Clean B / P / Q |
| --------------------------------- | -----------: | -----------------: | --------: | --------------: |
| initial                           |       180447 |          0 / 0 / 1 |    180580 |       1 / 2 / 1 |
| whitespace                        |       180709 |          0 / 0 / 1 |    180891 |       1 / 2 / 1 |
| unchanged                         |       181013 |          0 / 0 / 1 |    181122 |       1 / 2 / 1 |
| absent-1                          |       181219 |          0 / 0 / 1 |    181312 |       1 / 1 / 1 |
| restored-1                        |       181423 |          0 / 0 / 1 |    181524 |       1 / 2 / 1 |
| absent-2                          |       181655 |          0 / 0 / 1 |    181747 |       1 / 1 / 1 |
| restored-2                        |       181843 |          0 / 0 / 1 |    181979 |       1 / 2 / 1 |
| same-title-duplicate              |       182074 |          0 / 0 / 1 |    182167 |       1 / 2 / 1 |
| title-rename                      |       182270 |          1 / 1 / 1 |    182670 |       1 / 3 / 1 |
| force                             |       182798 |          1 / 3 / 1 |    182940 |       1 / 3 / 1 |
| materialization-repair            |       183424 |          0 / 0 / 1 |    183949 |       1 / 3 / 1 |
| collection-global-catchup session |       184393 |          2 / 2 / 1 |    184507 |       1 / 5 / 1 |

The final original session has a deliberate pre-checkpoint operation: collection-scoped embedding of `identity/Scope.md`, then the global checkpoint embeds `other/Scope.md`. Request 2 contains the identity passage; request 5 contains the other passage. Its two passage calls are not attributed entirely to the global checkpoint's embed operation. The distinct input bytes and exact source order establish that subdivision. The other listed original sessions contain only their checkpoint's embedding/query work.

Totals: 16 passage batches, 34 actual passage calls, 24 actual query calls, 49 init requests and 49 dispose requests. The zero-passage claim does not mean zero native work: init can load the model/create contexts, and query inference still runs. Speculative simulator allocations and native GPU kernel counts are outside this claim.

## Native input and vector hashes

For every captured passage call, the analyzer checks all of the following:

- The worker request's ordered text array equals the actual embedding-port argument capture.
- Each text has a corresponding captured `tokenize` invocation, and its token IDs equal the arguments passed to actual `getEmbeddingFor`.
- Every passage has a successful captured output vector. SHA256 of the UTF-8 input equals the stored `input_hash`; SHA256 of the output serialized as little-endian Float32 equals the stored embedding-byte hash.
- Every clean rebuild's captured input set covers the entire set of distinct active owner input hashes, including shared same-title inputs. All matching owners have the expected vector hash.

The JSON preserves each passage's exact text, token IDs, context arguments, vector hash, matching owner identity and raw capture-array offset/request ID. It preserves query calls separately. All 24 query output vectors also have one identical Float32 hash.

For the nine complete original `2beb8aae` baseline pairs—initial, whitespace, restored-1, absent-2, restored-2, same-title-duplicate, force, materialization-repair and collection-global-catchup—all owner fields on both incremental and clean sides match the new run exactly. Every newly captured clean passage input/output hash matches the old persisted input/vector hashes. This links actual new native inference to the full old stored-vector baseline, including every distinct active input.

The old unchanged, absent-1 and title-rename pairs had embedding failures. They remain marked incomplete and are excluded from the nine-pair claim. The old run did not capture raw per-call native tokens/contexts, so this analysis does not claim old-versus-new raw token/context transcript equality. It establishes exact persisted input/vector equality plus the new actual-call provenance.

## Reproduction and evidence

- Result: `notes/fn147-native-call-attribution.json`.
- CPU analyzer: `/home/gordon/.cache/agent-tmp/gno-fn147-call-attribution/attribute.py`; its SHA256 is recorded in the result.
- Reproduce: `python3 /home/gordon/.cache/agent-tmp/gno-fn147-call-attribution/attribute.py` (exit 0).
- Retained output: `/home/gordon/.cache/agent-tmp/gno-fn147-call-attribution/result.log`.
- Input artifact root: `notes/fn144-native-artifacts/cuda-3d9c0ec4/` with sibling checksum manifest.
- Child payloads, birth/exit ledger and sent-request ledger: `evidence/sdk-matrix.capture.json` and `evidence/sdk-matrix.capture.json.children/`.
- Independent ordering evidence: `evidence/phases/<pid>.jsonl`, `evidence/sdk-matrix.stdout`, `evidence/matrix-summary.json` and exact `matrix.ts`.
- Old stored snapshots: `/home/gordon/.cache/agent-tmp/gno-fn147-nativeqa/evidence/matrix-<case>.json`.

All raw artifacts remain unchanged. The derived mapping is suitable for this complete sequential run; the same attribution rule must fail closed for a future run with missing receipts, retries, overlapping clients or extra query sessions.
