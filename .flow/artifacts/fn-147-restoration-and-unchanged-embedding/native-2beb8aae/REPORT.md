# Native restoration/embedding acceptance — incomplete

Frozen source: `2beb8aaeafd0fd84d16111cbda3d8ec35a44ee6e`; archive SHA256 `f5373e3a2d881bca3d4a0ea3c26edb3d4f761529d80f246e0ddbcb59c8fc8743`. Offline Qwen3-Embedding-0.6B Q8_0, cached GGUF SHA256 `06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439`. Bun 1.3.14, node-llama-cpp 3.19.1, Linux x86_64, requested CUDA, default 300000ms model TTL. Parent and actual native child PID/PPID/process group and NVIDIA compute-process residency are retained in raw process JSONL. Existing live daemon/Stremio GPU residency was observed and untouched; synthetic owned descendants are distinguishable by process group. Workloads were serial, original SDK client closed before each clean client opened. No intentional concurrent inference; transient teardown overlap is not ruled out by 500ms sampling.

## Observable-state matrix

The SDK drives actual update/embed/search/vsearch/changes. Each checkpoint compares against a new SQLite index built from the same current physical source paths. Full ordered keyword/semantic result objects—including exact numeric scores, snippets, source hashes, absolute paths, modified timestamps, conversion and egress provenance—are retained without rounding or field stripping. Active owner snapshots retain title, canonical chunk text, sequence, partition/input hashes and full vector-byte hashes. The existing fn143 paired comparator performs exact mechanical comparisons, with new scenario identities; existing fixtures/baselines were not modified.

| Case | Embed result / exception | Clean-build comparison |
| --- | --- | --- |
| Initial (CLI had embedded both collections) | SDK 0 owners | Exact |
| Canonical-equivalent whitespace edit | 0 owners | Exact |
| Repeated unchanged update | 0 owners; clean embedding child exited | Incomplete; missing clean vectors, not demonstrated ranking drift |
| First absence | Candidate embedding child exited | Returned results/owners exact, but failed operation makes acceptance incomplete |
| First identical restoration | 0 owners | Exact |
| Second absence | 0 owners | Exact |
| Second identical restoration | 0 owners | Exact |
| Same-title duplicate | 1 newly bound owner | Exact |
| Rename duplicate Alpha to Beta, same body | Candidate embedding child exited | Incomplete; missing Beta coverage |
| Force after rename | 3 owners | Exact, including separate Alpha/Beta vectors |
| Drop owned vec0 table; zero-pending repair | 0 owners | Exact |
| Scope one collection, then global catchup | 1 identity owner; then 1 other owner | Exact after catchup; unselected owner stayed unbound after scoped pass |

Nine of twelve cases have successful embedding on both sides and exact full observable-state parity. A tenth has equal returned state but a failed embedding operation. No global QA PASS.

Restoration journal for Alpha: create, update (whitespace source edit), inactivate, reactivate, inactivate, reactivate. Both reactivation rows preserve the full 64-character source and mirror hashes; active transitions are 0→1. Repeated unchanged updates add no restoration event. Same-title duplicate binding reuses the same exact input/vector; Alpha/Beta in the later successful forced pass have distinct input identities. Both restored passes and lost-materialization repair report zero embedded owners and preserve vector bytes. These counts are public owner counts, not an actual native-inference transcript. Native call-count and exact model-context/input proof remain incomplete because the child capture channel was not available.

`raw/comparator-*.json` retains paired manifests, records and results. Their index identities explicitly refer to captured logical owner/journal snapshots; they are not retrospective hashes of the mutable SQLite file at earlier checkpoints. The comparison projection is explicitly marked native-transcript-incomplete and is not full-port fn143 acceptance. No unobserved native model-input values are reconstructed or claimed.

## Public failures

1. CLI `embed --json` succeeded: 2 owners, 0 errors, 0 contention. Immediately following fresh-process `vsearch 'cobalt observatory dawn' -n 10 --json` exited 2 with `Vector search failed: Effective embedding identity unavailable after variant activation`.
2. Actual stdio MCP `gno_vsearch` returned `isError: true`, same structured runtime message. MCP keyword search and changes returned actual results/history.
3. REST `POST /api/query` with the same query, `noExpand: true`, `noRerank: true` returned 200, mode `bm25_only`, `vectorsUsed: false`, two results. This is not semantic success. REST search/status/changes were captured. Expansion/rerank were deliberately outside this embedding-only matrix; this is not original-scope full retrieval/native acceptance.

Root cause identified in the frozen source: NativeEmbeddingPort.init sets identity metadata; its direct embed/embedBatch paths only accept dimensions. Fresh public vsearch obtains a vector through embed(), then cannot resolve activated variant identity. Same SDK client's explicit embed() initializes the shared port first, explaining its successful subsequent vsearch. No source fix was made by this QA worker. Host/native owner notified; needs regression coverage and re-run against a distinct fixed checkpoint, retaining these failures.

## Native process failures

Three SDK embed operations returned `GnoSdkError: Native worker failure: exited`: clean side of unchanged, candidate side of first absence, candidate side of title rename. Stderr retains three `pure virtual method called` / `terminate called without an active exception` groups and gdb warnings. Parent PID 105668 survived and later operations completed. Sampled gdb attachments identify native child 108223 around 13.97s and child 112259 around 64.88s, both generation 1, TTL 300000ms. Sampling did not capture every abort child attachment. Exact native substage (initialization, inference, disposal) is not instrumented; public embed was awaiting a response, but that alone cannot identify the native substage. Do not classify these as teardown-only or numerical quality drift.

No in-case retry masks the failures. The 12-case matrix completed once; no repeated fatal probe loop. Native owner received exact scripts and raw logs for diagnosis. Frozen indexes remain local scratch state only; they are not included in the repo evidence.

## Reproduction and remaining gates

Owned scratch root: `/home/gordon/.cache/agent-tmp/gno-fn147-nativeqa`. `prepare.ts` creates only synthetic config and sources. `run.py` isolates HOME/XDG/GNO directories for children, bounds processes to 600 seconds, records stdout/stderr/status and process/GPU samples. `matrix.ts` performs the mutation sequence; `surfaces.ts` launches actual stdio MCP and a loopback API server, then closes them. Scripts are exact used copies with the task's root/source expectations; use a new owned root when re-running to avoid overwriting this evidence.

Remaining: native identity fix and fresh CLI/MCP/API semantic rerun; bounded crash investigation/retest; successful unchanged/title-rename clean pairs; interrupted migration/retry coverage beyond existing focused tests; child-bound actual native inputs/context/call counts; full project gates including eval:memory; aggregate host QA and physical acceptance. Hosted gno.sh edits stay queued after aggregate PR. GPU slot released and owned processes exited.
