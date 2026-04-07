# fn-70-embedding-compatibility-and-query-batching.1 Implement model-specific embedding formatting and compatibility profiles

## Description

Replace the one-size-fits-all embedding formatter with explicit compatibility
profiles.

Start here:

- `src/pipeline/contextual.ts`
- `src/llm/`
- `src/sdk/client.ts`
- `src/embed/backlog.ts`
- `src/sdk/embed.ts`

Requirements:

- default formatter remains unchanged for unknown models
- add explicit compatibility profile lookup by model URI
- support at least:
  - query formatting override
  - document formatting override
- first curated profile should cover the current Qwen embedding model path
- tests must prove:
  - default profile behavior
  - known-profile behavior
  - unknown models keep old behavior
- include smoke verification that the current Qwen profile still behaves
  correctly on at least one real fixture path

Important:

- if a profile changes how stored document vectors are created, docs must mark
  that as a re-embed-requiring change

Tests / smoke:

- unit tests for profile lookup and formatter output
- regression tests for current Qwen formatter behavior
- regression tests for unknown-model fallback
- smoke run on a Qwen-backed fixture path after the profile layer lands

## Acceptance

- [ ] GNO has explicit embedding compatibility profiles.
- [ ] Known models can override query/doc formatting.
- [ ] Unknown models retain the current generic formatter.
- [ ] Tests cover both profile and fallback behavior.
- [ ] Smoke verification proves the current Qwen path still works after the profile layer lands.

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
