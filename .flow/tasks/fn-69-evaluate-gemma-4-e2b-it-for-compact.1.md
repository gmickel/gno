# fn-69-evaluate-gemma-4-e2b-it-for-compact.1 Extend compact answer benchmark lane for local `gen` challengers

## Description

Extend the answer benchmark path so GNO can evaluate compact answer-model
challengers cleanly.

Start here:

- `evals/ask.eval.ts`
- `evals/fixtures/ask-cases.json`
- `evals/helpers/retrieval-candidate-benchmark.ts`
- `docs/CONFIGURATION.md`

Requirements:

- benchmark the real answer-generation path, not a detached chat prompt
- keep retrieval fixed or mocked in a way that isolates answer quality
- make challenger-vs-incumbent comparison easy to repeat
- include latency in the output
- include cases that matter for GNO specifically:
  - grounded answers with citations
  - markdown-heavy content
  - structured/table-like content
  - code-ish technical content

Deliverables:

- new or extended benchmark helper for compact `gen` candidates
- durable result artifact format
- at least one test covering the new benchmark path

## Acceptance

- [ ] GNO has a repeatable compact answer benchmark lane for `gen` challengers.
- [ ] The lane exercises the real answer-generation flow.
- [ ] Output includes answer-quality and latency signal.
- [ ] Benchmark coverage includes structured/technical answer cases.

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
