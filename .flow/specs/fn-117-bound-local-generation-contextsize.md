# Bound local generation contextSize (issue #189)

## Problem

Local GGUF generation (node-llama-cpp backend) never passes `contextSize` to
`createContext`. node-llama-cpp defaults to `contextSize: "auto"`, which grows
the context/KV cache to fill available VRAM up to the model's trained context
length. On small GPUs (reporter: 8 GB RTX 5060 Laptop) the gen model's KV
cache (~2.5 GB) exceeds its weights (~2.4 GB) and peak usage hits ~7.8/8 GB —
OOM risk with nothing else running.

Reported in https://github.com/gmickel/gno/issues/189 by @fightp86 with VRAM
measurements. Verified against HEAD:

- `src/llm/nodeLlamaCpp/generation.ts` passed `undefined` to `createContext`
  when no `contextSize` param was supplied.
- `src/pipeline/answer.ts` (grounded answers) passes no `contextSize`.
- `src/pipeline/claim-verifier.ts` (missed by the reporter) also passes none —
  second unbounded call site.
- Expansion (`expandContextSize`, default 2048) and embedding
  (`embeddingContextSize`) already bound their contexts; generation was the
  only unbounded family.

## Requirements

- R1: When no explicit `contextSize` is supplied, local generation must size
  the context to actual need — prompt tokens + output budget + margin — never
  node-llama-cpp "auto".
- R2: The computed size is floored (1024) and capped at the model's trained
  context size when known.
- R3: Explicit `contextSize` params (expansion path) keep prior behavior.
- R4: A flat default (e.g. 8192) is NOT acceptable — claim-verifier prompts
  may reach `MAX_PROMPT_BYTES` (256 KB ≈ ~65K tokens); sizing must be dynamic
  per prompt.
- R5: Regression test covering the sizing resolver (margin math, floor, cap,
  unknown/non-positive trained size).

## Approach

Adapter-level dynamic bound in `NodeLlamaCppGeneration.generate`: extract a
pure `resolveGenContextSize({promptTokenCount, maxTokens, trainContextSize})`
helper; compute prompt tokens via `llamaModel.tokenize(prompt).length`. Fixes
all callers (answer, claim-verifier) without config plumbing. A
`genContextSize` config knob was considered and deferred as YAGNI — dynamic
prompt-sized contexts are already minimal.

## Acceptance criteria

- `createContext` always receives an explicit bounded `contextSize`.
- `bun test` green; `bun run lint:check` clean.
- CHANGELOG entry crediting @fightp86.

## Tasks

1. Implement bounded context sizing in generation adapter + regression test +
   changelog. (satisfies: R1, R2, R3, R4, R5)
