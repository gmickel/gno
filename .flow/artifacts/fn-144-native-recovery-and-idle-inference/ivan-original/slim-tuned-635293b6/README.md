# Corrected original-scope Ivan stratum: incomplete

Frozen source `635293b6c309cf3be34facf30b4fbc1802167cae`, unpatched existing node-llama-cpp 3.19.1, scratch Bun 1.3.14. Full source/runtime/model/config/corpus identities are in `pins.json.gz`; source archive stays in notes and is not bundled. The only configuration change from the previous original-scope receipt is activePreset and custom preset ID `slim-tuned`, enabling balanced CLI expansion. Same four role files, 143 physical synthetic files, query, default candidateLimit20, expansion context2048, maxTokens512, and TTL300000. Historical exact preset remains unknown.

First query stopped at warning pressure2 after5.244 seconds (owned watchdog SIGTERM, exit-15). Peak sampled owned RSS4452.61MiB. Actual child96079 generation1 selected Metal, loaded embedding and expansion models, and entered expansion generate with the full original prompt. Last event: expansion model load succeeded. No generation output, rerank invocation, public JSON response, or native fatal stderr. Context2048 is captured as the actual generation argument; context allocation itself was not hooked, so allocation completion is unknown. Existing swap usage3267.81MiB preceded the query and remained unchanged at stop.

0/3 required expanded+reranked successes. No second/third attempt or same-session SDK primer after the first failure. Earlier fixture-policy-limited result remains immutable in the parent artifact directory. This does not satisfy original-scope R5 or full child-capture acceptance.

Public parent96077 and native child96079 were absent after termination; pressure returned1, free percentage56. No unrelated applications modified. `postflight-memory.txt` records bounded process-name/RSS context without argument contents. GPU released.

## Reproduction

Existing remote isolated root: `/tmp/fn1445-ivan-slim-635293b6` (canonical `/private/tmp/...`). Exact child environment and watchdog are in `run.py`; exact query argv and all samples are in `query-1.receipt.json.gz`. The public command under that isolated environment is:

```sh
/tmp/gno-native-tools-1314.KrONBb/bun-darwin-aarch64/bun --preload /private/tmp/fn1445-ivan-slim-635293b6/parent-preload.ts /private/tmp/fn1445-ivan-slim-635293b6/source/src/index.ts query 'what retry budget did we decide and why' -n 5 --json
```

To repeat as a separately authorized new stratum, create a new empty scratch root, copy the retained source.tar, original-config.json, fixtures-manifest.json, run.py and both preloads, then execute run.py there. Never overwrite this run. Script validates143 corpus files and all four role hashes, builds an independent local index, applies only corrected preset ID, and stops at first failed enabled-stage query. Models, database payloads and full archive are deliberately excluded here. No model download or live state mutation.
