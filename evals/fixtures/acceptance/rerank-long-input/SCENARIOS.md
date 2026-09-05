# Paired reranker scenarios

`evals/acceptance/rerank-scenarios.ts` replays all 69 frozen historical pairs in
their original A/B order. `scenario-manifest.json` separately pins the complete
schedule and five additions; the original four fixture files and manifest remain
unchanged. The historical 45 cells include 122 scores, EN/DE/CJK, 12 CJK cells
above 2K tokens, and already-prepared oversized custom chunks. Ordinary 1000 and
4000-character fixtures are intact; preparation previously clipped larger custom
chunks to 4000 characters plus `...`, sometimes deduplicating away their evidence.
The scenario runner does not add clipping or recover evidence already removed.

New cases score the entire 6025-token long-query pair, shrink to the short input,
retain duplicate ties, use an unsupported template, and restart the loaded model
before repeating the short input. The unsupported-template executor must actually
change the native template and record auto allocation; changing a backend label
does not establish this coverage. Exact token streams come from native formatting,
not the capacity estimator. Only elapsed timing belongs outside exact equality.

`runRerankScenarioSchedule` serializes the fixed schedule, checkpoints each result,
and aborts on its per-observation deadline. Its executor must own the native child
and terminate only that child in `stop`; a cleanup timeout forbids GPU-slot reuse.
An external owned-process watchdog is still required for native memory pressure
and abrupt process termination. Failed runs retain their partial checkpoints.

`compareRerankScenarios` uses the fn-143 comparator and additionally detects
bilateral changes to prepared inputs, historical scores, expected ranking order
and complete-pair token counts. It retains every slower pair. The focused tests
use mock observations to test the comparator and timeout contract; they do not
establish native readiness. Real hybrid/Ask, citations, actual model reload and
physical Metal/CUDA measurements require separate captured execution receipts.
