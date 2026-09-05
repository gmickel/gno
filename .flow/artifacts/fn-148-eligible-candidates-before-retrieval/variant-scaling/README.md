# Activated owner-variant scaling

CPU-only known vectors, real SQLite/sqlite-vec and actual exported vector/hybrid pipelines. This is a distinct activated-owner stratum; it does not assert native embedding or cross-surface acceptance.

## Reproduce

The fixture helper snapshots a retained synthetic index from the legacy scaling harness using read-only `VACUUM INTO`. The source index is never modified. If those temporary indexes no longer exist, first rerun `evals/acceptance/eligible-scaling.ts` with a new label, then supply that label as the second argument below.

```sh
TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn148-vector timeout 600 bun evals/acceptance/eligible-variant-scaling.ts <new-variant-label> [legacy-label]
```

Default legacy label: `exists-known-vectors`. Existing captures are never overwritten; `manifest.json` pins model/runtime/context/truncation identity, base corpus hashes, title-owner scenarios, known vectors and matrix settings. The final helper additionally verifies physical source owner/chunk identities against the pinned generator before modifying its private snapshot.

## Corpus and oracle

The original base corpus sizes remain 201, 2,001 and 10,001. For each, the original final owner becomes Alpha; two owners are added for the same content: Beta and a second Alpha. Actual owner counts are therefore 203, 2,003 and 10,003. Active eligible broad counts are 200, 1,982 and 9,899. Alpha uses `[1,0]`, Beta `[0,1]`; both Alpha owners share exactly one formatted-input variant. Other base vectors and the synthetic model URI are unchanged. These title-specific vectors intentionally change ranking relative to the canonical legacy stage; no direct output parity with that older semantic stratum is claimed.

Each snapshot gets a fully activated partition. Broad, rare-tag, Beta-owner, whole-document-exclusion and deny-all workloads run at K=1/10 with one/four independent connections and five waves, for vector and hybrid pipelines. The oracle enumerates every active owner binding and unbounded SQLite distance, independently applies the generated owner eligibility set and current formatted-input hash proof, groups exact variant owners, then limits. Pipeline scoring/assembly remains shared between oracle and candidate; the claim is exact pre-budget candidate selection and owner projection, not an independent reimplementation of all scoring.

Every ordered public JSON result field is retained in complete unique output frames keyed by its fingerprint: scores, evidence/snippets/ranges, source/conversion metadata and egress lineage. Samples point to those frames; mismatches would retain their own full frame. Stale-title checks prove the stale owner cannot fill K or borrow its valid Alpha copy. Missing effective identity after activation returns explicit VEC_SEARCH_FAILED, never legacy fallback.

## Captures and version history

- `initial/report.json`: complete 120 groups / 1,500 requests; zero mismatches. Original unsplit script is preserved as `initial/runner-source.ts` and matches its captured script fingerprint.
- `split-verified/report.json`: complete second 120 groups / 1,500 requests after the fixture helper split; zero mismatches. Captured runner and helper sources are archived in that directory and retain their exact recorded fingerprints.
- `fixture-identity-verification.json`: after the captures, the helper gained only a fail-closed physical base-input guard. A fresh 201-base-owner fixture verified that guard and activated successfully. Corpus/model scenario pins did not change.
- `semantic-state-verification.json` and its script: 60 bounded sequential calls over all sizes/workloads/K pairs on the retained snapshots after their documented stale-title mutation. Full vector/hybrid results and metadata are retained, and every call asserts `meta.vectorsUsed`. The final runner now includes this same assertion for future captures. No third full matrix was run merely for that guard.
- `cost-summary.json`: activated owner-hash cost and pipeline timing rows, plus separately labelled older legacy rows. No speed ratio or cross-stratum ranking comparison is inferred.

Both full runs recorded commit `803463374075a9f20049cb0cef547dfc33656200`. Read-only diff against requested freeze `9d6c73a9` is empty for the measured pipeline/store paths; source fingerprints are included in each capture. No product, Flow or Git mutations were made by this worker.

## Performance provenance and limits

`load-provenance.json` records the host warning that unrelated full CPU tests overlapped this work. Exact overlap intervals were not independently sampled. Treat both runs as potentially contended; retain the raw slower samples. They are not isolated-machine benchmarks or universal latency promises. All measurements are warm; four readers overlap on one event loop and SQLite remains synchronous.

The hash-stage diagnostic runs the actual production document formatter and SHA helper over actual eligible bindings, separately from timed pipeline calls. It excludes binding SQL/read/materialization cost and is not a subtraction-based attribution of the entire query. At 10,001 base documents, broad proof checks 9,899 owners / 2,354,956 UTF-8 input bytes: median formatter+SHA 8.14 ms, maximum 10.85 ms. Single Beta-owner proof is about 0.016 ms median. Hashing alone therefore does not explain full query latency; integrity checking, eligible binding SQL, allocation and ranking remain in the end-to-end path.

In the split capture, broad K10 at 10,001 base documents measured vector p95 76.04 ms for one reader and 295.00 ms for four; hybrid four-reader p95 was 362.27 ms. These slower observations remain visible with the load caveat. A bounded largest-case repeat after host tests finish may refine timing confidence, but is not replaced by an automatic rerun or discarded samples.

## Verification and handoff

Baseline focused identity/eligibility tests passed before edits. Final identity, eligibility and variant-store suites: 43 passed, 191 assertions. Both new scripts pass typed Oxlint using the repository resolved configuration with only eval exclusion removed, standalone TypeScript, and Oxfmt; no zero-file lint pass is claimed. Final files remain below 500 LOC each.

Full project gates, live surfaces, native model coverage, final acceptance and any product optimization decision remain host-owned. No model downloads, GPUs, production data, live writes or hosted edits occurred.
