# Frozen reranker long-input oracle

`fixtures.json`, `token-matrix.json` and `results.json` preserve every JSON value
from the synthetic 2026-09-04 audit's `evidence/long-inputs/` artifacts (JSON whitespace normalized with repository Oxfmt). The
manifest pins each file independently; these additions do not change fn-143
fixture identities. Never regenerate these files to accommodate a mismatch.

The 45 EN/DE/CJK cases preserve original documents and exact production-prepared
text, including existing clipping and deduplication. The historical results
contain 69 paired runs (45 cells plus two repeats of 12 cells), with 122 exact
scores and 69 exact orders. They are historical evidence, not a fresh QA pass.
Twelve prepared CJK cases exceed 2,048 formatted tokens. `long-query.json`
reconstructs the audit's exact 6,000-character CJK query and selected document:
**6,025 is the full formatted pair count**, not the query-only count. That pair
was tokenized in the audit but not scored.

The capacity adapter supports only node-llama-cpp 3.19.1, Qwen3 BPE and the
audited builtin template. Unknown versions/models/templates use native auto
sizing. Supported over-model input raises an error; padding beyond the model
limit uses auto. No additional text is clipped. The 256-token margin and
256-token rounding follow the audit and native `contextSizePad`; mock tests
check arithmetic and formatter boundaries, not physical allocation safety.

`test/llm/node-rerank-format.test.ts` invokes the installed native formatter
without constructing a context. Its deterministic tokenizer proves the exact
segments, special-token flags and complete input stream. It does not certify
fresh native token counts, score parity, latency, CUDA or Metal allocation.
Those remain later native acceptance work using these immutable inputs.
