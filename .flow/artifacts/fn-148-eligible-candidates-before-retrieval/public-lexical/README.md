# fn-148 public lexical live QA

Tested candidate: 23ba2c25, archived source at /home/gordon/.cache/agent-tmp/gno-fn148-public/source. Isolated runtime: /home/gordon/.cache/agent-tmp/gno-fn148-public/runtime. Source archive and runtime TMPDIR are separate. Synthetic fixture identity verified against committed eligible-top-k manifest; 201 owners /200 active, target gno://notes/scope/target.md. No private index, native vector calls, hosted site or production service touched.

## Observed results

96 actual public requests: CLI gno search, stdio MCP gno_search, resident HTTP MCP gno_search and REST POST /api/search; 12 scenarios at K1/K10 per surface. Seven restrictive scenarios (tag-all, tag-any, since, author, category, whole-document path exclusion, combined collection/tag/author) each return exactly the rare target, score1, source-200 and eligible-v1-200 provenance. Absent tag returns no matches; absent collection remains either validation error or zero according to each existing surface. Broad results match independently specified fixture insertion/tie order at K1/K10 and exclude inactive owner199.

80 result-bearing observations have exact cross-surface equality of ordered URI/score/source/conversion/egressLineage tuples. Raw malformed-date outputs equal broad outputs on all8 observations, preserving the established ignored-bound temporal contract. The original driver assumed invalid dates error, reporting88/96; date-contract-reconciliation.json corrects that assumption from captured data without rerunning or changing expected fixture content. drive.ts now uses the correct expectation; original drive.log and responses.json remain unchanged.

Malformed lexical syntax yields CLI exit1, MCP isError and the correct user message. REST returns HTTP500: this is a status-mapping finding, not a successful validation-status claim.

## Driven UI

Driver: agent-browser0.35.1, Chromium151, headless, session fn148lex. Target http://127.0.0.1:3348. Desktop1380x880 and mobile375x812. Used actual Search navigation, Fast BM25, approved tag selection, Advanced Retrieval author/exclude/category fields, collection selector, candidate control, mobile tag drawer, absent-author zero result and unmatched-quote error. Exact actual POSTs and bodies captured in ui-response-*.json and browser-network-final.json. Target and zero/error state screenshots are included. The advanced numeric control is candidateLimit; the UI keeps actual result limit20. K1/K10 claims apply to CLI/MCP/REST, not UI.

UI date input could not be set persistently with this driver: direct fill and native calendar selection left empty values and no since request. Mark date UI coverage incomplete; programmatic since cases passed. Internal caller mirror allowlists/path boundaries are not exposed in gno_search public schema, so no invented cross-surface control coverage. Native vectors/hybrid remain assigned elsewhere.

Console: no uncaught JavaScript errors; informational React DevTools messages only. Network: successful filter/search requests200; deliberate unmatched-quote request500 captured. This does not constitute a console-clean successful error-status claim.

Home setup wizard content overlapped the pointer route to Search at the initial scroll position. Keyboard focus+Enter reached Search. Screenshot home-desktop.png preserves the observation; no independent product finding asserted because onboarding layout/state and driver scroll behavior were not fully isolated. Later automatic scrolling also put controls beneath the sticky header; fresh snapshots/keyboard navigation avoided forcing clicks.

## Finding

P2: Invalid lexical query returns HTTP500 from POST /api/search.
Reproduce: run isolated offline resident; POST {query: \"\"unterminated\"} (exact valid JSON payload in ui-response-09.json or responses.json) or enter unmatched quote in Fast BM25 UI and submit. Actual500 with INVALID_INPUT message; expected client validation status400 as documented for search validation. Evidence: ui-response-09.json, search-invalid-mobile.png/txt, responses.json invalid-query rows. CLI/MCP preserve their established validation signals. No source changes or issue-state mutations by this worker.

## Startup and cleanup

Initial plain serve attempted automatic embedding download into the isolated cache before binding; exact PID15072 stopped. resident.log retains stderr/progress, no downloaded artifact copied to repo. Restart with GNO_OFFLINE=1 HF_HUB_OFFLINE=1 GNO_NO_AUTO_DOWNLOAD=1 CUDA_VISIBLE_DEVICES=-1 and empty cache-offline succeeded. Actual CLI/MCP drive additionally sets GNO_ALLOW_DOWNLOAD=0 GNO_LLAMA_BUILD=never. No native-model inference performed. Offline server reported0 warm models in UI; models download-status endpoint active:false, empty completed/failed. This eager-startup behavior was sent to the resident owner, who is preparing a separate fix; this23ba2c25 evidence does not claim the fix verified.

Browser session closed; isolated resident PID16908 terminated; MCP clients/transports closed. No shared service stopped. No Flow/git mutation, formal review or aggregate QA receipt generated; host owns final task/spec acceptance. Hosted docs, scaling and vector/native acceptance are outside this bounded pass.

## Separate committed startup-fix verification

Candidate dd38f777, fresh source archive startup-source and fresh startup-runtime sibling under the same isolated probe root. All model roles use nonexistent local file URIs (startup-default-config.json), which cannot trigger network downloads. Default download policy retained by unsetting GNO_OFFLINE/HF_HUB_OFFLINE/GNO_NO_AUTO_DOWNLOAD/GNO_ALLOW_DOWNLOAD. GNO_LLAMA_BUILD=never and CUDA_VISIBLE_DEVICES=-1 constrain runtime; GNO config/data/cache and TMPDIR point only at this fresh runtime.

Actual serve on3349 succeeds; startup-default.log contains only listening/stop guidance and no model resolution/download text. Resident status before use shows loadedModels0/loadAttempts0/leaseAcquisitions0. Real REST and HTTP MCP selective lexical calls return the same target atK1. The first actual gno_vsearch call fails truthfully with isError and missing local embedding file, proving deferred resolution occurs at use; this is negative capability QA, not a vector success. Post-status remains zero native loads; startup-children.txt shows no child process, startup-cache-files.json records the cache inventory. No model downloads/native inference performed. Isolated PID36056 terminated after evidence, HTTP client closed. This supersedes the earlier pending-startup-fix limitation only;23ba2c25 lexical/UI evidence remains pinned independently.
