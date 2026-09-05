# Final 2.0.0 release-candidate gates

All repository gates passed at test commit `76743bd616cbe723b0adab87da9f380cad1513ad`. Shipped product bytes remain those of `f64c41c97e196e3bffdba23bc1c006bca7489b28`; the intervening commit changes three test files and one fixture manifest only. Later Flow receipts do not change the package. This is release-candidate evidence, not a published release or complete physical acceptance.

| Gate | Observed result |
| --- | --- |
| `bun run lint:check` | Exit 0 |
| `bun run typecheck` | Exit 0 |
| `bun test` | 5,216 passed, two existing skips, zero failures; 41,596 assertions across 613 files |
| `bun run docs:verify` | Exit 0; 15 passed, two model-dependent skips |
| `bun run package:clipper` and `bun run verify:clipper-package` | Exit 0 |
| `bun run test:package` | Exit 0; seven real-GNO sentinel files, 380,866,604 bytes, unchanged |
| `bun run eval:memory` | 100%, unchanged 100% threshold; 200 latency samples, p95 1.60ms |
| `bun run eval:hybrid` | 86%, unchanged 70% threshold; 33 cases |
| `bun --bun evalite evals/vsearch.eval.ts` | 88%, unchanged 70% threshold; 25 BM25 cases |

Selected evaluations ran offline from an external archive of f64, with the existing repository dependency installation linked. This avoids discovering unrelated local notes as eval inputs. The vsearch-named suite measures BM25 ranking. These gates do not establish native-vector parity. `retrieval.log` retains a rejected two-positional-argument Evalite invocation; each supported single-file invocation then ran separately.

The initial full gate failed three tests. Two registration-only MCP fakes lacked the underlying server lifecycle hook. The packed native fixture expected an own `cause: undefined` property even though the wire contract omits non-JSON causes. Four fixture/test files were corrected, including the runner's SHA pin; strict error equality and write-disabled assertions remain. Initial logs, the exact rationale, focused checks and final successful full run are retained separately. No product fix or retrieval golden refresh was used to clear these failures.

The verified npm distribution contains 909 files, including all 754 source files from f64. Archive SHA256 is `56587f10c9969a795d6aa527c29fe8a057720a97d9f9e5de335daa996e706655`. The package report records clipper prepack, fresh production SPA and source/archive verification. Package smoke separately exercised its own packed artifact. Version 2.0.0 and the changelog are prepared; no tag, merge or publication occurred.

The winning GNO skill passed all 47 unchanged command-generation checks in a fresh GPT-6-Astra medium run. Its earlier 46/47 result remains in the sibling skill artifacts. All 15 canonical skill assets were installed and byte-verified in five user harness directories after backups. `verification.json` records those comparisons.

`SHA256SUMS.json` maps retained log/report bytes and losslessly compressed source bytes. Physical CUDA/Metal lifecycle reports remain separate evidence. The physical Metal auto-versus-sized allocation comparison for fn145 R3 is blocked and is not cleared by these gates.
