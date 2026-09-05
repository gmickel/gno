# Public reranker resize and idle reload — CUDA

The packed candidate completes **six of six** public calls in one retained SDK session. Actual reranker contexts grow **768 → 3840 → 768**. After the configured idle interval, the first native child exits successfully and a new generation serves the reranked query and verified Ask. Candidate verified Ask before/after reload preserves the complete deterministic record, generated answer, actual model inputs and outputs exactly, including citations and the semantic verifier prompt/schema. Both Ask calls execute one actual semantic judge call.

The baseline completes four of six cases. Its long reranking call fails; its post-idle Ask has no in-scope capsule evidence and does not exercise the judge. The full six-case comparator therefore **fails**, as expected from those recorded failures. The four complete baseline/candidate pairs are exact. No failed native case was retried, clipped or replaced. Candidate invariance and successful baseline pairs are complementary evidence, not a six-case baseline parity claim.

## Frozen scope

- Baseline product: `270c3a74f4f7a3aeb8a60462b4c8e1b4adf45462`.
- Candidate product: `9d0b57e30590b5d71429df538da7a5d0f08fff02`, actual package SHA256 `1a01daff5030dfbab0492d8d7d76a759e699a3effbd87ede8a40a290e6879342`; canonical helper `98252a9c`.
- Bun 1.3.14, node-llama-cpp 3.19.1, llama.cpp b10068, CUDA. All four cached GGUF identities remain pinned in each plan. No product, dependency or native-binary edits.
- New declared scope: `fn145-public-resize-reload-schema29-v1`. This is not relabeled as the original fn143 scope. Both sides use the same matched29 orchid corpus, absolute collection paths, SQLite schema29 logical state, model policy and public options.
- The only test-policy change from matched29 is `warmModelTtl:1200`, reusing the prior fn145 public lifecycle test value. Idle wait is 2500 ms. The existing public long query is copied byte-for-byte from `notes/fn145-qa/surfaces/cuda-plan-v2.json`; its full value and SHA256 are in `preparation/fixture.json`. No new padding, clipping, precision or retrieval-depth changes.

CPU preflight opens each actual schema29 store and SDK without native calls, process spawning, downloads, fetch or dlopen. Both logical index fingerprints are `86762c89d8d365f4ce58f5287436ddef3b6d4555dbf8a46390d602bb31694e67`; both effective config fingerprints are `b59278085e417308c5d950779a05cd09241a36a09e1f4d6ea485c490c131025e`. The real native driver separately reads the store after its actual SDK opens and verifies equality with that preflight snapshot.

**Index-byte boundary:** the manifest's indexSha256 identifies the prepared seed snapshot (`bc696b82…`), not the subsequent contained SQLite backup's header. Candidate contained backup SHA256 before native execution is `7e27d6b8…`; no baseline contained-header hash was captured before execution. SQLite backup/header changes are not asserted byte-identical. Actual logical state equality is captured independently. No database or WAL is included here or moved across hosts.

## Sequence and observations

All calls use collection `probe`, limit 3, noExpand true, noRerank false and graph false. The short question is “Who owns the meadow migration?”.

| Case | Baseline | Candidate | Actual candidate rerank context / generation |
| --- | --- | --- | --- |
| short-before | Complete, exact pair | Complete | 768 / 1 |
| long-resize | Reranker inference failure | Complete | 3840 / 1 |
| short-after | Complete, exact pair | Complete | 768 / 1 |
| verified-before | Complete, exact pair; actual judge | Complete; actual judge | 768 / 1 |
| 2500-ms idle transition | Retained SDK | Child generation 1 exits 0 | No metadata polling |
| short-after-idle | Complete, exact pair | Complete | 768 / 2 |
| verified-after-idle | No in-scope capsule evidence; no judge | Complete; actual judge | 768 / 2 |

Candidate child PID 320487, generation 1, handles the first four calls. At idle start (1788582400809 ms UTC epoch), the captured descendant history contains its birth only. At idle end (1788582403315), that same history also contains its exit with code 0. Child PID 321268, generation 2, is then born and handles both post-idle calls. It exits 0 during final closure. This observes expiry before the next request; it does not infer reload merely from elapsed time or poll metadata that could renew residency.

All **36 actual candidate native request receipts** are complete: 23 in generation 1, 13 in generation 2. They retain case, sequence, request ID, native model arguments/results, context events and lifecycle load counters. Post-idle receipts belong to generation 2; no old-generation result contamination is observed. This bounded observation is not an exhaustive proof against every possible asynchronous callback race. All 19 observed owned process IDs are absent after final closure; no user process was terminated.

Baseline native context creation records show auto context 40960. Baseline helper context-event arrays accumulate through the session; candidate arrays are per request. Do not sum cumulative baseline lists as independent allocations. The public sequence measures integration behavior, not an isolated allocation ratio.

## Equality and preserved failures

`preparation/comparison.json` retains the unmodified full six-case fn143 comparator output. All differences are confined to baseline `long-resize` and `verified-after-idle`; generated-answer changes are confined to the latter. The four complete pairs have equal full deterministic records, generated answers, actual model inputs and actual model outputs. Long-case model inputs also match, but baseline scoring fails, so no long-case score equality is claimed here. Existing frozen direct native matrix evidence remains separate and was not rerun.

Candidate `verified-before` versus `verified-after-idle` has exact full deterministic record, generated answer, model-input and model-output equality. Semantic verification completes once in each case, requests and enforces the schema, and records one candidate claim, zero verified claims and one unresolved claim. This is a valid abstention, not a claim that the evidence was verified. The full generated answer, citations, evidence spans, claim identifiers, prompt, schema and native outputs remain in the raw results.

The first supervisor launch stopped before session/native creation because its new scratch root did not contain the preexisting corpus. Its failure remains in `preparation/baseline/evidence/`. The execution directories were then placed under the existing matched29 isolated root, preserving exact corpus/config paths. That setup correction is not a hidden native retry. Both actual native runs exited 0 at the process level; coverage is judged from receipts, not those exit codes. The driver records incomplete cases and continues the declared sequence without retry.

## Inventory and reproduction

- `analysis.json`: scoped result counts, context buckets, child transitions, full comparison, actual-judge counts, logical-state check and post-run absence observation.
- `baseline/`, `candidate/`: complete compressed public results, protocol messages, actual child captures, process/resource logs and exit receipts. Original bytes preserved by gzip; no source archives, caches or databases.
- `preparation/`: exact plans, full query fixture, CPU preflight snapshots/results, driver, comparator and supervisor, plus the preserved pre-native setup failure.
- `SHA256SUMS`: hashes all other artifact files. Run `sha256sum -c SHA256SUMS` here.

Original preparation root: `/home/gordon/.cache/agent-tmp/gno-fn145-public-reload-9d0b57e3`. Actual contained execution root: `/home/gordon/.cache/agent-tmp/gno-fn144-packed-surfaces-98252a9c/ask29/public-reload-1200`. The CPU comparator reads those retained raw paths and performs no native inference. No further GPU run, Metal inference, overall task closure or release acceptance is claimed by this artifact.
