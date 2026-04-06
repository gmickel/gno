# Code Embedding Search Policy

Optimize for code retrieval quality first.

Guardrails:

- keep product runtime/defaults fixed
- benchmark on the fixed code corpus
- prefer vector quality improvements first
- treat hybrid gains as secondary support, not the main objective
- latency is a soft penalty, not an automatic rejection by itself

Strong keep signal:

- meaningful `vector.ndcgAt10` lift
- no collapse in `vector.recallAt5`
- no surprising hybrid regression

Weak or discard signal:

- no measurable vector gain
- vector quality regresses
- huge latency regression with no retrieval benefit
