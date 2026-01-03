# Evals

Evalite-based evaluation harness. See [README.md](README.md) for full documentation.

## Quick Reference

```bash
bun run evals              # Run all, update scores.md
bun run evals --include-llm  # Include LLM evals
bun run eval evals/vsearch.eval.ts # Single eval
```

## File Structure

```
evals/
├── fixtures/corpus/{de,en,fr,it}/  # Test docs
├── fixtures/queries.json           # Search test cases
├── fixtures/ask-cases.json         # Answer test cases
├── helpers/setup-db.ts             # Temp DB setup
├── scorers/ir-metrics.ts           # Recall, nDCG
├── *.eval.ts                       # Eval definitions
├── scores.md                       # Auto-generated results
└── README.md                       # Full documentation
```

## Eval Status

| Eval         | LLM Required | Status             |
| ------------ | ------------ | ------------------ |
| vsearch      | No           | ✅                 |
| query        | No           | ✅                 |
| expansion    | No           | ✅                 |
| thoroughness | No           | ✅                 |
| multilingual | No           | ⚠️ Placeholder     |
| ask          | Yes          | ⚠️ Model-dependent |

## Key Points

- **Local only** - not in CI, part of release DoD
- **70% threshold** - configurable in evalite.config.ts
- **LLM evals skipped by default** - use `--include-llm`
- **scores.md auto-updated** - by `bun run evals`

## Adding Evals

1. Create `new-feature.eval.ts`
2. Use `evalite()` + `getSharedEvalDb()`
3. Add 0-1 normalized scorers
4. Run `bun run evals`
5. Update README.md with status
