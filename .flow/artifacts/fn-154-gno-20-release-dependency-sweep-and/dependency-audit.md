# GNO 2.0 dependency decisions

Audit date: 2026-09-05. Scope: all direct dependencies reported outdated for the release branch, the three open Dependabot PRs, native/runtime compatibility, AI SDK/Evalite compatibility, and the host's fresh-lock vulnerability report. PR183 is excluded. This artifact records decisions and observed metadata; it is **not a validation receipt or release approval**. The host is still changing the dependency graph and repairing runtime transitive findings. Pins below were read from the live package.json during this audit; the final committed manifest and lockfile take precedence.

## Evidence and method

- Read package.json and locally installed Evalite metadata/adapter implementation; inspected GNO's AI imports, pager invocation and reranker capacity guard.
- Queried npm registry metadata for every direct dependency/dev dependency and the TypeScript peer. The remaining differences from the registry's latest tags are listed below; packages omitted from the decision tables were already current at this observation.
- Read the host's `/home/gordon/.cache/agent-tmp/gno-release-deps-outdated.log` and `/home/gordon/.cache/agent-tmp/gno-release-audit-fresh-lock.json`. Earlier `notes/fn143-152-dependency-freshness.json` records the old frozen dependency cohort, not the new sweep's acceptance.
- Read Dependabot PR207/181/182 metadata, package patches and relevant CI output through gh. No PR183 details were opened. No comments, PR mutations, Git operations, installs, tests or native execution were performed by this audit worker.
- Registry endpoints are primary metadata: `https://registry.npmjs.org/<package>` with scoped package slash URL-encoded. Dist-tags are time-sensitive; exact versions below are the September5 observation, not floating installation instructions.

## Adopted manifest pins; verification remains pending

These are host-selected updates already visible in the working manifest, including decisions that supersede the initial recommendation to postpone native/Bun changes. Adoption here means selected for the sweep, not proven safe by the old 2.0 package receipts.

| Package | Previous | Selected | Reason and validation scope |
| --- | --- | --- | --- |
| @codemirror/lang-markdown | 6.5.1 | 6.5.2 | Maintained editor patch; editor/package UI checks. |
| ai | 6.0.68 | 6.0.277 | Maintained SDK6 branch compatible with Evalite's declared peer; see SDK section. |
| @ai-sdk/openai | 3.0.25 | 3.0.108 | Matching SDK6 provider; judge-path parsing and optional evaluation coverage. |
| lucide-react | 1.28.0 | 1.41.0 | Current icon package; rebuild and inspect packaged UI. |
| nanoid | 6.0.0 | 6.0.1 | Same-major maintenance; identity/output contracts remain unchanged. |
| node-llama-cpp | 3.19.1 | 3.20.0 | Native compatibility/disposal improvements; new paired native proof required. |
| officeparser | 7.5.0 | 7.8.0 | Maintained ingestion parser; conversion fixtures and transitive PDF dependency audit. |
| pdfjs-dist | 6.2.108 | 6.3.289 | Current direct viewer package; direct pin does not remove vulnerable nested copies. |
| sharp | 0.35.3 | 0.35.4 | Native image patch; package installation and image operations. |
| shiki | 4.3.1 | 4.4.3 | Syntax highlighting maintenance; built UI/code rendering. |
| streamdown | 2.5.0 | 2.6.0 | Markdown rendering update; streaming/Markdown UI checks. |
| zod | 4.4.3 | 4.4.3 retained | Attempted4.5.4 update rejected after host full-suite wire-contract finding; see deferral below. |
| @biomejs/biome | 2.5.6 | 2.5.12 | Maintained auxiliary tooling; does not imply migration of active Oxlint/Oxfmt presets. |
| @testing-library/react | 16.3.2 | 16.3.3 | Same-major DOM test tooling. |
| @testing-library/user-event | 14.6.1 | 14.6.7 | Same-major interaction test tooling. |
| @types/bun | 1.3.14 | 1.4.1 | Current available declarations for the selected Bun runtime; version numbers need not equal runtime patch. |
| @types/react | 19.2.17 | 19.2.18 | Same-major declarations; typecheck. |
| @types/react-dom | 19.2.3 | 19.2.7 | Same-major declarations; typecheck. |
| ajv | 8.17.1 | 8.20.0 | Maintained schema validator; output-schema contract tests. |
| bun | 1.3.14 | 1.4.2 | Host-selected current runtime; rebuilding package and re-running native/runtime/browser checks required. |
| happy-dom | 20.11.1 | 20.14.0 | Same-major DOM implementation; meaningful lifecycle regressions. |
| lefthook | 2.1.10 | 2.1.12 | Hook maintenance; no new trusted lifecycle package approved by this audit. |
| playwright | 1.62.0 | 1.63.0 | Browser test maintenance; browser binary/version and real UI evidence must match. |
| web-tree-sitter | 0.26.11 | 0.26.13 | Stay on compatible 0.26 patch line; parser/WASM compatibility fixtures required. |

`sqlite-vec` remains **0.1.9**, the current latest observed version. No forced update or inferred backend improvement. Existing exact-pinned dependencies remain pinned; the TypeScript peer remains a compatibility range.

## Explicitly retained or deferred

| Package | Retained selection | Current latest observed | Decision |
| --- | --- | --- | --- |
| less-pager-mini | 1.12.1 | 1.17.0 | Retain pending Windows TTY acceptance. Later pager versions change the call contract; a type fix alone does not prove terminal behavior. |
| zod | 4.4.3 | 4.5.4 | Retain4.4.3. Host full suite found exact MCP legacy wire-schema drift: anyOf string/null became type:[string,null]. Semantic equivalence does not satisfy the frozen wire contract. Do not refresh goldens or widen assertions for this optional update. |
| ai | 6.0.277 | 7.0.93 | Defer major; Evalite peer remains ai^6 and practical GNO use does not require new agent APIs. |
| @ai-sdk/openai | 3.0.108 | 4.0.59 | Defer provider major together with SDK major; never independently replace provider3 with provider4 under core6. |
| evalite | 1.0.0-beta.16 | 0.19.0 latest tag | Keep beta16. The latest tag points to an older release, not an upgrade. Beta16 remains latest beta and declares ai^6. |
| oxfmt | 0.28.0 | 0.66.0 | Defer coupled formatter/preset migration; avoid unrelated release-wide formatting changes. |
| oxlint | 1.43.0 | 1.81.0 | Defer active lint-stack migration with preset/type-aware engine, not an isolated version bump. |
| oxlint-tsgolint | 0.11.5 | 7.0.2001 | Defer major type-aware lint engine migration with Oxlint and TypeScript compatibility. |
| ultracite | 7.1.5 | 7.10.8 | Defer coupled preset migration; latest preset can alter enforced rules across the repository. |
| vitest | 4.1.10 | 5.0.0 | Retain current runner for this sweep; defer Vitest5/Evalite integration migration. This also intentionally leaves PR207's smaller4.1.11 proposal unapplied. |
| web-tree-sitter | 0.26.13 | 0.27.0 | Defer0.27 parser/WASM transition; compatible patch selected instead. |
| typescript peer | ^5.9.3 | 7.0.2 | Stay on supported5.x with a ranged peer; defer compiler7 and coupled lint changes. Do not mislabel a peer range as an unpinned direct dependency. |

Fresh registry comparison found no additional direct latest-tag differences at the time of this read. This statement does not cover unexamined later registry releases or vulnerable transitive copies.

## Native, Bun and parser decisions

node-llama-cpp3.20.0 ships llama.cpp b10361, changes sequence disposal to return a promise, fixes disposal-related races in its simulator, changes Qwen thought handling and adapts to upstream llama.cpp changes. Model architecture metadata and downloader progress are useful additions, but they are not evidence of lower memory or higher throughput for GNO. [Upstream release](https://github.com/withcatai/node-llama-cpp/releases/tag/v3.20.0)

Keep GNO's exact conservative reranker guard: `ceil((full formatted pair tokens + 256) / 256) * 256`. The current `rerank-capacity.ts` explicitly relates this to3.20.0 contextSizePad256. Do not remove the extra guard because upstream already pads: no smaller GNO capacity has the accepted paired proof. Preserve safe native-auto fallback and all existing cancellation/cleanup fences. Await asynchronous sequence/context disposal and verify disposal/reload failures retain actual ownership until settlement. Upstream fixes do not replace GNO's process/model cleanup guarantees.

The old package56587f10 and f64 native receipts establish the previous Bun1.3.14/node-llama3.19.1 cohort only. Changing either runtime or binding requires a fresh package identity and native input/output, cancellation, residency, fairness, shutdown and restart evidence on the selected platform scope. Host owns that evidence; this audit does not claim it ran.

Bun1.4.2 and node-llama-cpp remain the only entries in trustedDependencies observed here. Registry metadata confirms Bun's `node install.js` postinstall and node-llama-cpp's `node ./dist/cli/cli.js postinstall`; their presence explains the existing trust entries, not authorization to trust arbitrary new packages. [Bun metadata](https://registry.npmjs.org/bun/1.4.2), [native metadata](https://registry.npmjs.org/node-llama-cpp/3.20.0)

Tree-sitter0.27 includes WASM/parser changes; the selected0.26.13 patch limits migration scope. Retain the shipped grammar/WASM pairing and test actual parser loading plus chunk outputs. [Tree-sitter releases](https://github.com/tree-sitter/tree-sitter/releases), [selected metadata](https://registry.npmjs.org/web-tree-sitter/0.26.13)

## AI SDK and Evalite

The selected ai6.0.277/openai3.0.108 pair uses provider3.0.15 and provider-utils4.0.50. Both were published September4 under the maintained ai-v6 tags. OpenAI3.0.108 includes current model support; recent patches fix Responses errors/usage and malformed replayed tool arguments. Many desirable provider fixes are available without moving to SDK7. [AI6 changelog](https://github.com/vercel/ai/blob/ai%406.0.277/packages/ai/CHANGELOG.md), [provider3 changelog](https://github.com/vercel/ai/blob/%40ai-sdk/openai%403.0.108/packages/openai/CHANGELOG.md)

GNO's production AI imports inspected here are types in two AI-elements components. Runtime generateText/OpenAI use is the optional judge in evals/ask.eval.ts; native inference uses GNO's own adapters. Evalite beta16 declares optional ai^6 and its wrapAISDKModel uses V3 middleware. A green offline eval can skip the external judge and therefore does not prove that provider path. [Evalite published metadata](https://registry.npmjs.org/evalite/1.0.0-beta.16)

SDK7's standardized reasoning, per-operation timeouts, telemetry, durable agents and approvals could benefit a future SDK-driven agent feature. They do not automatically improve this release's native model lifetime. Migration includes ESM-only packages, a Node22 floor for Node consumers and API renames/removals. GNO already uses ESM/Bun, but its Evalite support boundary still needs deliberate migration. Core7's published LanguageModel type accepts V4/V3/V2, so upgrading core alone is not intrinsically an old-provider type error; conversely, installing provider4 alone beneath core6 is not a supported pair. [SDK7 overview](https://vercel.com/blog/ai-sdk-7), [migration source](https://github.com/vercel/ai/blob/main/content/docs/08-migration-guides/23-migration-guide-7-0.mdx)

## Dependabot disposition

- [PR207](https://github.com/gmickel/gno/pull/207), group23: **partially superseded by this sweep**, often with newer pins. Do not merge its historical lockfile wholesale. Pager, Vitest and tree-sitter selections deliberately differ. Latest inspected CI had macOS lint failure and canceled Ubuntu test. Error at src/cli/pager.ts:159: `TS2353: 'LESS' does not exist in type 'readonly PagerArg[]'`. New pager signature is `pager(input, args, env)`; a future migration can use an argument array while preserving terminal behavior, but Windows TTY proof is pending. [Failed run](https://github.com/gmickel/gno/actions/runs/33813430291), [pager API](https://github.com/dawsonhuang0/Less-Pager-Mini#usage)
- [PR181](https://github.com/gmickel/gno/pull/181), provider4: major deferred; maintained provider3 patch selected instead.
- [PR182](https://github.com/gmickel/gno/pull/182), core7: major deferred; maintained core6 patch selected instead.
- PR181/182 were conflicted at inspection and their older successful checks were not run against this sweep. No PR was closed, merged, rebased or commented on by this worker. Host can reconcile superseded PRs after final dependency acceptance.
- PR183 is outside this audit; its contributor work is neither assessed nor altered.

## Fresh-lock vulnerability findings: repairs in progress

The host's fresh-lock JSON contains **four package families and six advisories**, not a clean audit. Runtime/development classification below follows the host's dependency-path audit; this worker read the advisory JSON but did not independently run a second package-manager audit.

| Family | Host-classified scope | Fresh-lock finding | Disposition |
| --- | --- | --- | --- |
| image-size | Development graph | Two high-severity infinite-loop parser advisories, <=2.0.2 | Repair/verify development graph; do not silently erase from all-dependency report. |
| uuid | Development graph | Moderate missing buffer bounds checks, <11.1.1 | Repair/verify development graph and affected consumers. |
| pdfjs-dist | Runtime transitive graph | High malicious-PDF execution advisory, >=5.6.83 <6.2.108 | Runtime repair in progress. Direct6.3.289 alone does not prove nested vulnerable copies are absent. |
| xlsx | Runtime transitive graph | High prototype pollution <0.19.3 and high ReDoS <0.20.2 | Runtime repair in progress; accepted parser replacement/removal or consumer-valid safe dependency path required. |

Advisories: [image-size ICNS](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr), [image-size JXL/HEIF](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq), [uuid](https://github.com/advisories/GHSA-w5hq-g745-h8pq), [PDF.js](https://github.com/advisories/GHSA-hq66-cqwq-w95j), [SheetJS prototype pollution](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6), [SheetJS ReDoS](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9).

Observed root overrides were @fastify/static10.1.3 and file-type22.0.2. Root overrides constrain this checkout's install; **published consumers do not inherit dependency-package overrides**. A green root lockfile audit cannot prove the npm-installed GNO graph is safe. Validate a freshly packed consumer installation without copied root overrides or repository node_modules, inspect production dependency paths, and retain separate root/all-dependency and published-runtime reports. Repairs must propagate through the shipped dependency graph rather than rely solely on root overrides. [npm overrides semantics](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#overrides)

## Validation still required from host

This worker performed metadata/source/CI-log inspection only. It did not run or fabricate an install, audit, test, gate, package smoke, Windows TTY check, native test or browser pass for the changed dependency cohort.

Before release acceptance, append or link the final manifest/lock/package pins; fresh root and independent consumer audits; actual package installs; appropriate schema/parser/DOM/SDK gates; full configured release checks; regenerated CSS/SPA/clipper artifacts; packaged production browser/PDF checks; and the host's bounded native migration receipts. Retain failures and exact exclusions. Existing old-cohort test counts, package hashes and native receipts are historical controls, not substitute results. Resolve runtime PDF.js/XLSX findings before claiming a clean published dependency graph.
