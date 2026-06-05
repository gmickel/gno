# Fix Evalite eval runner ergonomics

## Problem

The Evalite suites are useful for retrieval-quality work, but they are no longer safe as a standard release gate on Gordon's machine. During the v1.9.0 release attempt, `bun run eval` picked up duplicate eval files under `.claude/worktrees/awesome-wright/evals`, then ask-mode generation failed with a node-llama-cpp VRAM/context error. A focused canonical `ask.eval.ts` rerun also failed because generated answers had zero citations.

## Goals

- Make Evalite invocations deterministic so they only run canonical `evals/*.eval.ts` files from the repo root.
- Make ask-mode evals resource-aware and able to run without killing the local machine.
- Restore citation-bearing answers in ask eval fixtures or update the expectations if behavior changed intentionally.
- Keep Evalite local-only and opt-in unless Gordon explicitly asks for it.

## Non-Goals

- Do not re-add Evalite to CI or the standard release workflow.
- Do not weaken retrieval-quality thresholds just to get a pass.

## Proposed Approach

- Audit Evalite discovery/config so ignored worktrees and `.claude/worktrees/**` are excluded.
- Add a low-resource ask eval profile or skip path for native local generation when hardware cannot satisfy context requirements.
- Reproduce the zero-citation ask outputs with a minimal fixture and fix the root cause.
- Document the opt-in command and expected machine requirements.

## Acceptance Criteria

- `bun run eval:hybrid` runs only canonical repo evals.
- A focused ask eval command either passes on supported hardware or skips with a clear reason on unsupported hardware.
- No standard release checklist requires `bun run eval`.
- The failure mode from the v1.9.0 release attempt is documented in this spec/task context.

## Risks

- Evalite CLI discovery behavior may require a wrapper script rather than config-only changes.
- Ask-mode failures may expose a real citation regression beyond runner ergonomics.
