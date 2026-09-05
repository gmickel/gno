# Ivan original-scope R5 proof — incomplete

Candidate `2beb8aaeafd0fd84d16111cbda3d8ec35a44ee6e`, source archive SHA256 `f5373e3a2d881bca3d4a0ea3c26edb3d4f761529d80f246e0ddbcb59c8fc8743`. All742 product source files verified against that archive. Scratch Bun1.3.14, live1.3.11 unchanged. Full original143-document corpus verified per-file and indexed independently on Ivan;143vectors embedded,0errors. Original270c pressure failure remains immutable.

Exact public command:

```text
bun --preload <owned>/parent-preload.ts <selected-source>/src/index.ts query 'what retry budget did we decide and why' -n 5 --json
```

No corpus narrowing, query change, fast/noExpand/noRerank option, context reduction, model substitution, manual truncation or generation-budget change. Original explicit `audit-default-equivalent` config, tokenizer snowball english, allfourcollections, TTL300000, unchanged cached role URIs. Historical1.45.1 exact preset is unknown; this remains the explicitly pinned default-equivalent stratum.

First attempt: exit0,4.2204seconds whole CLI cost,5results, `vectorsUsed:true`, `reranked:true`, **`expanded:false`**. Default graph expansion enabled. Reported queryLanguage `nl`. Actual child PID94600/generation1 beneath public PID94598 records `getLlama().gpu='metal'`, successful embedding and rerank inputs/outputs and actual loadModel paths. No generation call observed; approved bootstrap contained only embedding/rerank roles. Peak owned-group RSS2525MiB, pressure1 throughout; no watchdog stop/native crash.

R5 requires usable expansion, not just successful exit or enabled defaults. Therefore **not passed3/3**. Stopped at the first capability failure as instructed; attempts2/3 and the separate retained-SDK embedding-primer/same-generation3query precondition were not executed. No retry or alternative options substituted for missing expansion.

Read-only follow-up proves the exact cause: `core/depth-policy.ts` enables balanced expansion only for preset IDs `slim` and `slim-tuned`. The custom ID `audit-default-equivalent` resolves the exact public CLI defaults to `noExpand:true,noRerank:false` before entering the pipeline. Thus the retained configuration is role/model-equivalent but **not CLI depth-policy-equivalent** to slim-tuned. This setup limitation applies to its expansion claim; embedding/rerank evidence remains actual. No generation ran, so malformed JSON is not this failure.

Offline parent `createExpansionPort` succeeds with NativeGenerationPort at the exact cached expansion URI. Bun.spawn was replaced with a throwing guard for that diagnostic; all lifecycle counters remained zero. Therefore missing cache/approval failure is ruled out for the diagnostic. The CLI depth resolver alone proves the observed suppression. A separate read-only FTS diagnostic could not evaluate BM25 because openReadOnly did not register the snowball tokenizer (`no such tokenizer: snowball`); its empty derived score list is not a real lexical-strength measurement and is not used as evidence. The original query never reached the BM25 expansion decision.

Needed separate full-expansion proof: new frozen config/run ID with activePreset and the explicit role-override preset ID changed to `slim-tuned`, retaining the exact same four file URIs, all143documents, query, TTL300000 and context/default candidate limits. Registry overrides built-in slim-tuned with those explicit role files; balanced policy then resolves noExpand:false/noRerank:false. This is a corrected configuration stratum, not a revision of the failed run or proof of the unknown historical preset. Do not use --thorough as a shortcut because it also changes the default candidate limit. Separately, SDK explicit noExpand:false/noRerank:false can prove same-session loaded-embedding behavior, but does not replace the public CLI case. No new GPU run authorized/executed in this diagnostic follow-up.

## Evidence

- Remote root `/tmp/fn1445-ivan-original-2beb8aae`; selected source under `source/`.
- `raw/pins.json`: source/runtime/config/model/full143file corpus pins; `source-verification.json` contains742source checks and postrun index hash.
- `raw/query-1.{stdout,stderr,receipt.json}`: complete public result, raw errors, exact command/exit/whole time and process-tree RSS/pressure.
- `raw/query-1-parent94598-generation1.native.jsonl`: actual child load/backend and full native embedding/rerank arguments/results. This limited proof hook is not the full shared fn144.5 acceptance harness.
- `raw/children.jsonl`: parent/child/generation and strict production bootstrap receipt.
- `raw/index.*`, `raw/embed.*`: complete independent index/embedding setup evidence.
- `raw/cli-result.json`: failed usable-stage requirement and stopped attempt count.
- `raw/expansion-parent-diagnostic.json`, `raw/depth-parent-diagnostic.json`: exact successful offline port creation and exact preset-dependent CLI noExpand resolution; native child spawning forbidden.
- `raw/owned-processes-after.txt`: selected public/native PIDs absent after cleanup (`ps` exit1/no rows). GPU released.

Scratch `parent-preload.ts` intercepts only exact selected native entry launch, adds child-only preload and private evidence paths to the already-sanitized child environment; native argv/bootstrap/inference args unchanged. `child-preload.ts` observes actual selected native classes inside the child. No production/harness files edited; no credentials, vault/live state, model downloads or Git/Flow mutations.

Reproduction script `run.py` refuses existing setup directories; use a new scratch root with the same archive, immutable original-config.json and fixtures-manifest.json. Do not overwrite this evidence or run further native attempts without owner coordination. The full source archive, model files and SQLite payload are excluded from curated artifacts.
