## Goal & Context

While recording the gno.sh Fig. 3 run on ivan (macOS, Metal, gno 1.45.1), the expanded and reranked `gno query "<question>" --json` aborted twice with a native `GGML_ASSERT(buft)` from node-llama-cpp; `gno query --fast` on the same index succeeded, and fn-135.1 had already seen one transient `GGML_ASSERT(buft)` on a direct `gno recall`. The crash takes the whole process down, so an agent calling the CLI gets no JSON and no error code.

## What

- Reproduce on ivan: hybrid query with expansion + rerank against the Fig. 1 demo vault (`fixtures/index-trace-vault` in gno.sh) after the embed model has been loaded in the same process.
- Identify the buffer-type path (likely the rerank or generation context sharing a Metal buffer type with the embedding context) and pin node-llama-cpp / context settings accordingly, or serialize the model loads.
- Fail closed: when a native abort is unavoidable, surface a JSON error with a stable code instead of a process abort (worker isolation or a guarded child process for the rerank stage).

## Acceptance Criteria

- R1: the recorded query runs to completion on ivan 3/3 times with expansion and rerank enabled.
- R2: a regression note or test pins the configuration that avoids the assert.
- R3: `docs/TROUBLESHOOTING.md` (or the closest existing page) documents the symptom and the fix.

## Supersession record

Superseded on 2026-09-05 by fn-144-native-recovery-and-idle-inference after the performance and retrieval audit. Original R1 and R2 map to successor R5. Original R3 maps to successor R7. Native failure containment maps to successor R6.

This record closes the overlapping scope as superseded, not implemented or fixed. The original evidence and criteria above remain preserved. The successor must demonstrate their acceptance before claiming the defect resolved.
