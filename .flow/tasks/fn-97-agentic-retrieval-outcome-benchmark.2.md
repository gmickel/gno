---
satisfies: [R2, R3, R5]
---
# fn-97-agentic-retrieval-outcome-benchmark.2 Instrument the current GNO agent workflow adapter

## Description
Deliver instrument the current gno agent workflow adapter as one implementation-sized increment.

**Size:** M
**Files:** `evals/agentic/adapters/gno-current.ts`, `evals/agentic/runner.ts`, `assets/skill/SKILL.md`, `test/evals/gno-current-adapter.test.ts`

### Approach
- Execute the documented query/search then get/multi_get workflow through the real CLI/MCP contract in an isolated corpus.
- Capture normalized tool trajectories, exact bytes read, evidence spans, filter selection, premature stopping, and warm/cold model lifecycle.
- Meter tokens through the pinned tokenizer when available; otherwise record a deterministic byte-derived estimate and safety margin rather than inventing precision.

### Investigation targets
**Required** (read before coding):
- `assets/skill/SKILL.md`
- `docs/MCP.md:37-100`
- `src/mcp/tools/query.ts`
- `src/mcp/tools/multi-get.ts`
- `src/cli/commands/query.ts`

**Optional** (reference as needed):
- `src/cli/commands/get.ts`
## Acceptance
- [ ] The adapter follows the shipped skill/MCP workflow and records every call/read without hidden shortcuts.
- [ ] Warm and cold runs have distinct lifecycle/timing receipts.
- [ ] Token/byte accounting is reproducible and discloses fallback estimation.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
