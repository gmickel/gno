# Upgrade node-llama-cpp to autoAttempt build path

## Goal

Upgrade GNO from node-llama-cpp 3.14.5 to a current release that supports `build: "autoAttempt"`, then switch the runtime to that path to improve GPU/backend selection and fallback behavior.

## Scope

- Upgrade dependency and lockfile.
- Update `getLlama()` initialization to use `build: "autoAttempt"`.
- Verify no API breakage across embedding, generation, and rerank flows.
- Add targeted coverage and docs/changelog updates if behavior changes.
- Include current local skill/agent files requested by Gordon in the next commit.

## Acceptance

- `package.json` uses a node-llama-cpp version that exposes `build: "autoAttempt"`.
- `ModelManager.getLlama()` uses `build: "autoAttempt"` and preserves existing logging behavior.
- Full lint/test/eval and package smoke pass.
- CLI/API model-backed smoke checks still work.
- Local skill/agent files currently untracked are included in the commit as requested.
