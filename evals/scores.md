# Eval Scores

Last updated: 2026-02-23

## Summary

| Metric        | Value        |
| ------------- | ------------ |
| Total Evals   | 79           |
| Average Score | 80%          |
| Status        | Some Failing |

## Results by File

| Eval         | Score | Status | Cases | Duration |
| ------------ | ----- | ------ | ----- | -------- |
| expansion    | 100%  | PASS   | 15    | 4ms      |
| hybrid       | 89%   | PASS   | 1     | 40ms     |
| thoroughness | 88%   | PASS   | 24    | 21ms     |
| vsearch      | 84%   | PASS   | 25    | 21ms     |
| query        | 83%   | PASS   | 10    | 21ms     |
| multilingual | 38%   | FAIL   | 4     | 21ms     |

## Breakdown by Level

### thoroughness

| Level    | Score |
| -------- | ----- |
| fast     | 88%   |
| balanced | 88%   |
| thorough | 88%   |

## Thresholds

- **Pass threshold**: 70%
- **LLM evals (ask)**: Skipped by default, run with `--include-llm`

## Running Evals

```bash
# Run all evals and update scores.md
bun run evals

# Include LLM evals (slower)
bun run evals --include-llm

# Run individual eval
bun run eval evals/vsearch.eval.ts
```
