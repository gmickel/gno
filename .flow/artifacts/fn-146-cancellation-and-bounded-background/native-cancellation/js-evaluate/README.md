# Bounded native cancellation — JS evaluation observer

**The declared SDK/native cancellation stratum is exercised successfully.** Pre-aborted query dispatches no native request. Queued cancellation removes only its own waiting request, while the unrelated active rerank completes with its exact historical score. Active reranking and generation deliver cancellation promptly while the real owner remains busy and quarantined until settlement. All four independent recovery queries exactly match the unchanged no-abort control in full results, complete public payload apart from explain timing, and actual native query inputs/outputs. Vectors and reranking are used throughout recovery; no unexpected fallback or partial success is published.

This is bounded native/SDK evidence, not a complete fn146 transport/background/shutdown acceptance verdict. Two earlier instrumentation failures remain in sibling directories and are not replaced by this result.

## Frozen product, helper and inputs

Product `a30da4423ec5604f46d2b050af8a2cba51c66e07`, actual npm package SHA256 `592c38574b9b88d4da3488256b49d7421c2f2f44223090d5cd98e78736cdebc0`, 906 files / 12,858,293 bytes. Canonical helper `8b45a54d9fab684fddb69175e8c836dad4b935b2`. The same package bytes were extracted fresh for this named stratum; no product, dependency, native binary, precision or inference setting changed after either failed attempt. Full identities and driver hashes are in `freeze/pins.json`.

Bun 1.3.14, node-llama-cpp 3.19.1, llama.cpp b10068, CUDA, and all four existing cached GGUF pins remain unchanged. The original synthetic orchid corpus and matched29 configuration use the same absolute corpus paths. New independent SQLite state stays on this Linux host. CPU preflight verifies schema29, logical index fingerprint `86762c89d8d365f4ce58f5287436ddef3b6d4555dbf8a46390d602bb31694e67`, configuration fingerprint `d65d0604e4eddb7ecafab325f75592f674da3f60ba1d6943851b42e8a9d51133`, and zero native/spawn/fetch/dlopen attempts. Final selected index bytes were hashed before native execution, and the real SDK-open logical snapshot was checked against preflight.

`fixture.json` declares a new cancellation scope. The unchanged recovery question is “Who owns the meadow migration?”, collection probe, limit3, noExpand true, noRerank false, graph false, explain true. Native reranking uses the entire existing6025-token long-input fixture; answer generation uses the complete retained matched29 answer prompt and original GenParams `{temperature:0,maxTokens:512}`. Signal controls are separate operational arguments. No input is lengthened or clipped to force cancellation, and no timeout/depth/model setting is adjusted. The 300000-ms TTL, 60000-ms load timeout and 30000-ms inference timeout remain unchanged.

## Observed cancellation and actual settlement

| Case | Caller cancellation delta | Actual evaluation iterator settlement after abort | Dispatcher settlement after abort | Capacity evidence |
| --- | ---: | ---: | ---: | --- |
| Pre-aborted public query | Immediate rejected AbortError; separate latency not measured | No new native request | None | Native request ID unchanged |
| Queued rerank request12 | 1 ms | Never dispatched | Never dispatched | Request11 remains busy/native-owned and succeeds |
| Active rerank request18 | 0 ms timestamp delta | 396 ms | 445 ms | Busy, ownsNative and quarantine remain true after caller error; external waiter peak1 |
| Active generation request24 | 1 ms | 24 ms | 31 ms | Busy, ownsNative and quarantine remain true after caller error; external waiter peak1 |

These are observed millisecond-clock deltas under instrumentation, not a universal cancellation SLA; a0-ms timestamp delta does not mean zero execution cost. The JS evaluation-boundary observer is not C++ kernel timing. It calls the original iterator.next first, records that returned evaluation promise pending, and subsequently records its actual resolution/rejection. Parent abort is issued only while that exact evaluation/request is pending and the owner is busy/native-owned. Neither active case had settled before abort; both have later real iterator settlement events.

The queued request is visible behind its unrelated active predecessor with ownsNative false, then removed. Request12 is absent from all child dispatches. Request11 completes with score **0.001127836061641574**, exactly matching both retained baseline and candidate historical long-fixture results. It is not replayed or dropped.

Each cancellation caller has exactly one delivery event. Public pre-abort rejects AbortError. Native queued/active callers receive `{ok:false,error:{code:"INFERENCE_FAILED",retryable:false,cause:{name:"AbortError",message:"Inference cancelled"}}}`; no partial score/text success is delivered. Actual child capture also records failed terminal results for active18/24 after their native work settles. Recovery is offered immediately after caller cancellation in the active cases, but waits outside the quarantined owner's native queue until settlement. Cancellation acknowledgement alone is never counted as capacity release.

All **28 dispatched native request receipts** are complete. All five capture scopes drain. One native child generation handles the stratum and closes normally; no forced retirement was needed. Observed PIDs369561,369607 and369657 are all absent after closure. The supervisor reports exit0 with no time/RSS governor stop; that exit code is supporting evidence, not the acceptance oracle.

## Recovery equality

The no-abort control and four independent recovery queries all complete with vectorsUsed/reranked true. For each recovery:

- Full result arrays match exactly, including scores, ordering, snippets, source paths/hashes and provenance.
- Complete public payload matches after excluding only nondeterministic explain timing lines; all original timing lines remain in raw responses. Disabled expansion/graph remain the declared policy, not an error fallback.
- Complete actual query model inputs/outputs match exactly. The CPU analyzer selects actual dispatched embed and short-query rerank operations by their request identity/content; it does not reconstruct inputs or remove semantic fields. Separately cancelled long/generation operations remain fully retained in the same raw scope but do not masquerade as recovery-query inputs.

The comparator uses the unchanged same-product no-abort control, complementing earlier baseline270c parity evidence. This cancellation stratum is not relabeled as the original fn143 equality scope and does not refresh any historical baseline. No assertion about new generated-answer quality follows from an intentionally cancelled generation; its follow-up query, rather than partial text, is the recovery comparison.

## Transparent observation and preserved negatives

`phase-child.ts` replaces only writable JavaScript `LlamaContextSequence.prototype.evaluate`. `iterator-observer.ts` forwards every original next/return/throw call, receiver and argument identity, preserving values, errors and asyncIterator self behavior. CPU `iterator-preflight.ts` inspects the actual selected class descriptor and tests those identities/finalization before native launch. No readonly addon method is changed; no proxy, pause or deliberate evaluation delay is introduced. The parent uses private busy/pending/settlement/quarantine/waiter state for operational observations; child lifecycle snapshots are not mislabeled as a live queue gauge.

Canonical helper8b45 forwards all operational arguments unchanged. Known AbortSignal fields are described in context telemetry and excluded from semantic model-input identity; complete model/context settings and GenParams are retained. Unknown objects/functions remain rejected. `context-preflight.ts` checks actual signal-bearing outer embedding input shapes and inner context telemetry before launch.

Two separately retained attempts precede this run: helper9814 rejected signal-bearing context telemetry; helper8b45 with the original scratch addon hook failed on a readonly native method. Both attempted the declared sequence once and have incomplete/unexercised outcomes. The host explicitly authorized this third named JS-observer stratum after CPU transparency checks. None of those failures is deleted or counted as a pass.

## Inventory and reproduction

`result.json.gz` contains every full caller outcome, native input/output receipt and ownership event. `capture/` retains raw child dispatch/response evidence; `phases.jsonl.gz` retains evaluation/request boundaries. `observation/` contains process/GPU samples and supervisor receipt. `analysis.json` contains derived comparisons, cancellation/settlement deltas and cleanup. `analyze.py` reproduces that JSON using raw or compressed files without native execution; run `python3 analyze.py`. It asserts exact reproduction, preserving the original post-run PID observation instead of conflating it with a later process-table read. Verify file hashes with `sha256sum -c SHA256SUMS`.

Original root: `/home/gordon/.cache/agent-tmp/gno-fn146-native-cancellation-js-evaluate`. No database/WAL, cache, model, source archive or dependency tree is curated here. Native slot was released after PID absence verification. REST/MCP disconnect, remote HTTP cancellation, sustained background fairness, native deadline expiry and finite daemon shutdown remain their own acceptance scenarios; this artifact does not stand in for them.
