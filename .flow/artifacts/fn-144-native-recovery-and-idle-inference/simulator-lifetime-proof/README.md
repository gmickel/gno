# Simulator lifetime backport proposal

Scratch-only, ready for host inspection and controlled application. Installed dependencies, native binaries, product source, package.json and bun.lock remain unchanged. No GPU execution.

The original 3.19.1 class fails the controlled paused-context assertion: its model is freed before the context can read memory. The candidate passes all five tests (19 assertions). This establishes a simulator lifetime defect and a targeted guard repair; it does not yet attribute or clear the physical fn144/fn147 aborts.

## Deliverables

- `node-llama-cpp@3.19.1.patch`: standard git-style unified patch for Bun `patchedDependencies`; changes **only** `dist/gguf/insights/GgufInsights.js` inside the package.
- `original/dist/gguf/insights/GgufInsights.js`: untouched installed source snapshot.
- `patched/dist/gguf/insights/GgufInsights.js`: reviewable full candidate source.
- `prepare.ts`: reproducible extraction/transpilation of the upstream simulator section plus documented 3.19.1 compatibility adaptations. Bun 1.3.14 was used.
- `make-patch.py`: original-source hash guard, unified diff generation, scratch verification copy and manifest generation.
- `lifetime.test.ts`, `original-fixture.js`, `patched-fixture.js`: controlled fake-binding test and exact simulator class sections extracted from each package module. Fixtures import installed native-free lifetime/cache helpers; they do not evaluate the full native dependency module graph.
- `original-test.log`, `patched-test.log`: observed old failure and new pass; no timed sleeps, GPU, CPU inference or predictive-scoring changes.
- `manifest.json`: source/patch/upstream hashes, exact test commands and outcomes.
- `installed-identity.sha256`: before/after hashes of installed JS, CUDA addon and b10068 libllama; all verified unchanged after preparation.
- `upstream-GgufInsights.ts`, `upstream-pr636-files.json`, `UPSTREAM-LICENSE`: exact primary-source provenance and MIT notice.

Patch SHA256: `8101d8683d2a3485a20acb82ff76b5089bd0bd0e015a3eb4e49c9d5220d15cbd`.
Patched module SHA256: `814dd31d083aa93b09acbcad144ff3c04c2dd29b9e2bde7de62a5361656e5f13`.
Original module SHA256: `d848a262376282ec803817bde6a3083dd0d5a1607fecef937a7357ee29f74490`.

## Upstream attribution and exact scope

Derived from [withcatai/node-llama-cpp PR636](https://github.com/withcatai/node-llama-cpp/pull/636/files), pinned commit [3f686d75aa9cda1b20b80465883f5f7358e42880](https://github.com/withcatai/node-llama-cpp/commit/3f686d75aa9cda1b20b80465883f5f7358e42880), `src/gguf/insights/GgufInsights.ts`, simulator session/handle section. Copyright (c) 2023 Gilad S.; MIT license retained in `UPSTREAM-LICENSE` and already present in the target package.

Backported behavior: simulator model/backend disposal-prevention handles span estimate operations and context disposal; model disposal waits for active users; cached and evicted handles have explicit disposal ownership. The original model configuration/scoring algorithms, estimator inputs, context sizes, precision and native binaries are untouched. The patch does not adopt 3.20.0's b10361 binaries or unrelated generation/sampler/format features.

Compatibility adaptations, explicitly additional to the upstream section:

1. Installed `lifecycle-utils` is 3.1.1 and does not export `registerFinalizer`. A module-local native `FinalizationRegistry` helper supplies the upstream weak cleanup pattern without upgrading that dependency. It registers only disposable ownership/listener handles, not a strong reference to the native model target.
2. Its `AsyncDisposeAggregator.dispose()` returns early on a second call, even while the first is pending. `SimulatorModelHandle` caches its disposal promise so eviction, session and backend disposal observe the same completion.
3. `_loadModel` explicitly disposes a raw model if initialization or creation of its ownership handle fails. This closes the newly tested failed-init/late-backend-shutdown path while preserving the original error and retryable cache-entry removal.
4. The obsolete upstream source-map directive is removed from this changed module. Its untouched `.map` cannot describe the backported code; claiming mapped original TS line numbers would mislead diagnosis. No other package file changes.

The backported class is compiled from upstream TS by Bun, so its formatting differs from the original tsc output. Only the simulator section, its required imports and source-map directive change. Full module syntax parsing succeeds without executing it.

## Verification and reproduction

Run from `/home/gordon/work/gno`:

```sh
bun --no-env-file notes/fn144-simulator-patch/prepare.ts
python3 notes/fn144-simulator-patch/make-patch.py
SIMULATOR_SIDE=original bun --no-env-file test ./notes/fn144-simulator-patch/lifetime.test.ts -t 'paused speculative context'
SIMULATOR_SIDE=patched bun --no-env-file test ./notes/fn144-simulator-patch/lifetime.test.ts
```

Original test intentionally exits 1: expected free count 0, received 1 while context initialization remains paused. Patched suite exits 0: 5 pass, 0 fail, 19 assertions. Tests cover:

1. Paused speculative context → session dispose → memory read → context dispose → model free, with no premature free.
2. Session disposal during asynchronous model creation; the new context finishes before its native model is freed.
3. LRU eviction while a model is active, followed by backend disposal; both evicted and cached native models drain, leaving no backend prevention handles.
4. Failed model initialization: raw model released once, failed cached promise removed, subsequent valid creation succeeds.
5. Backend disposal begins while model initialization is paused: ownership-handle acquisition fails safely, raw model is freed and backend disposal completes.

Promise barriers and queued microtask draining control the schedule. No timer sleeps or favorable physical reruns are involved. The fake bindings detect freed-model memory reads rather than replacing them with successful values.

The patch passed `patch --dry-run -p1`, was applied to `verify/` only, and that result matched `patched/` byte-for-byte. The first generated diff lacked the no-final-newline marker; the generator was corrected and the final patch validates. No Bun install has been run, so the host still needs to verify Bun's actual patch application after freezing the dependency tree.

## Host application plan — not executed

Freeze original package/native identities first. Copy only the final patch into the chosen tracked patch directory and add a mapping equivalent to:

```json
{"patchedDependencies":{"node-llama-cpp@3.19.1":"patches/node-llama-cpp@3.19.1.patch"}}
```

Use Bun's normal lockfile/install procedure to record the patch, then verify the installed module equals the manifest's patched hash and native addon/libllama hashes remain unchanged. A later frozen-lockfile install must reproduce that exact state. Do not overwrite the archived original tree or repin dependencies during this test. Keep original and candidate resource/result receipts separate.

## Physical attribution hooks and remaining risk

Coordinate with child_capture: current child harness correlates operation/model load and actual port calls, but does not distinguish simulator and actual-context memory accounting. Add a narrow scratch hook at exported `GgufInsightsSimulatorSession.estimateContextResources`, `estimateModelResources` and `dispose`, with session/operation IDs and entry/exit timestamps. For the decisive ordering, wrap or instrument the scratch simulator's actual context init/memory-read/dispose and raw model dispose calls. Label these explicitly as simulator events; actual LlamaContext construction emits a distinct label. Include child PID, worker generation and parent request ID from the existing capture scope. Do not log raw model-source bytes or credentials.

A bounded physical reproduction must show which operation was active when the abort occurred and whether raw simulator-model disposal overlapped a memory read/context init. Keep the exact 3.19.1/b10068/model/corpus/context/input identities; no lowered context, CPU substitution, disabled predictions, retry or altered comparison projection. Then test candidate convergence under the same ownership/pressure/time bounds.

Remaining risks: private dependency internals require an exact package pin; GC-finalizer behavior is not driven by these deterministic tests; Bun patch application and the installed full-module native path remain unexecuted; the dependency can have other untracked native work; physical root-cause attribution and full fn144/fn147 result/resource acceptance remain incomplete. Five fake-binding passes do not establish crash resolution or performance equality.
