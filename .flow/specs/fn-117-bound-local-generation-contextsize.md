# fn-117 Bound local generation contextSize (issue #189)

## Goal & Context

Local GGUF generation (node-llama-cpp backend) never passes `contextSize` to
`createContext`. node-llama-cpp defaults to `contextSize: "auto"`, which grows
the context/KV cache to fill available VRAM up to the model's trained context
length. On small GPUs (reporter: 8 GB RTX 5060 Laptop) the gen model's KV
cache (~2.5 GB) exceeds its weights (~2.4 GB) and peak usage hits ~7.8/8 GB —
OOM risk with nothing else running.

Reported in https://github.com/gmickel/gno/issues/189 by @fightp86 with VRAM
measurements. Verified against HEAD: `src/llm/nodeLlamaCpp/generation.ts`
passed `undefined` to `createContext` when no `contextSize` param was
supplied; `src/pipeline/answer.ts` (grounded answers) passes no `contextSize`;
`src/pipeline/claim-verifier.ts` (missed by the reporter) also passes none —
a second unbounded call site. Expansion (`expandContextSize`, default 2048)
and embedding (`embeddingContextSize`) already bound their contexts;
generation was the only unbounded family.

## Architecture & Data Models

Adapter-level dynamic bound in `NodeLlamaCppGeneration.generate`
(`src/llm/nodeLlamaCpp/generation.ts`): a pure exported helper
`resolveGenContextSize({promptTokenCount, maxTokens, trainContextSize})`
computes prompt tokens + output budget + 512-token margin, floored at 1024
and capped at the model's trained context size when known. Prompt tokens come
from `llamaModel.tokenize(prompt).length`. Fixes all callers (answer,
claim-verifier) without config plumbing. A `genContextSize` config knob was
considered and deferred as YAGNI — dynamic prompt-sized contexts are already
minimal.

## Edge Cases & Constraints

- A flat default (e.g. 8192) is NOT acceptable — claim-verifier prompts may
  reach `MAX_PROMPT_BYTES` (256 KB ≈ ~65K tokens); sizing must be dynamic per
  prompt.
- Unknown or non-positive `trainContextSize` → use the uncapped dynamic size.
- Explicit `contextSize` params (expansion path) keep prior behavior.

## Acceptance Criteria

- **R1:** When no explicit `contextSize` is supplied, local generation sizes the
  context to actual need (prompt tokens + output budget + margin) — never
  node-llama-cpp "auto"; `createContext` always receives an explicit bounded
  `contextSize`.
- **R2:** The computed size is floored at 1024 tokens and capped at the model's
  trained context size when known; unknown/non-positive trained size falls
  back to the uncapped dynamic value.
- **R3:** Explicit `contextSize` params (expansion path) keep prior behavior.
- **R4:** Regression tests cover the sizing resolver: margin math, floor, cap,
  unknown and non-positive trained size.
- **R5:** CHANGELOG [Unreleased] entry credits @fightp86 and links issue #189;
  `bun test` and `bun run lint:check` green.

## Boundaries

- No `genContextSize` config knob in this change — deferred as YAGNI; dynamic
  prompt-sized contexts are already minimal. Revisit only if users need a hard
  ceiling below prompt size.
- No changes to the expansion or embedding context sizing paths — they are
  already bounded.
- No HTTP/remote generation changes — remote backends manage their own
  context.

## Decision Context

Chose adapter-level dynamic sizing over the issue's suggested flat 8192
default because claim-verifier prompts can reach ~65K tokens — a flat cap
would break large verifier runs, while per-prompt sizing bounds VRAM without
regressing capability.
