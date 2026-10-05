---
title: serve /api/ask native crash (pure virtual) in temp-home fixture env
date: "2026-08-30"
track: bug
category: runtime-errors
module: src/llm/nodeLlamaCpp
tags: [native, node-llama-cpp, serve, ask, fn-121, fn-132]
problem_type: runtime-error
symptoms: POST /api/ask aborts serve with 'pure virtual method called' during generation; llama.cpp GGML_ASSERT seen same day in standalone query
root_cause: Unconfirmed; same abort signature as the documented fn-132 concurrent native-worker crash
resolution_type: fix
last_audited: "2026-10-05"
---

During fn-121 docs-example regeneration (2026-08-30, gno 1.36.1), `POST /api/ask` crashed the `gno serve` process with a native `pure virtual method called` abort during answer generation. Environment: throwaway GNO home (`GNO_CONFIG_DIR`/`GNO_DATA_DIR`/`GNO_CACHE_DIR` in /tmp), 9-doc fixture corpus, models symlinked from `~/.cache/gno/models`. Search/query/get/docs/collections endpoints on the same instance kept working. It was not reproduced against a normal home.

## Current understanding
The same abort signature was later reproduced with a core dump during fn-132 (combined `gno index`): `pure virtual method called` in `llama_model::build_graph` during `llama_init_from_model` while a second node-llama-cpp worker was still in `llama_model_load`. GNO deduplicates model loads and creates contexts only after the load resolves (`src/llm/nodeLlamaCpp/lifecycle.ts`), so the overlap is inside Bun's Node-API async-work path or the addon, not GNO's call order. The canonical write-up is `docs/CLI.md`, "Combined-run crash (field report 2026-09-01)".

Whether the `/api/ask` crash shares that exact cause is unconfirmed. If it recurs, keep the stderr tail and `coredumpctl info` output for an upstream report, as docs/CLI.md describes.
