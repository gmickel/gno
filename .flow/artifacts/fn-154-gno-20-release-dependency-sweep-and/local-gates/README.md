# Local release gate evidence

Captured 2026-09-05. Product candidate `64400ffeffa59ddb58dfd10f1e6386a7eb81f6a6`; package SHA256 `94581ea58f100a6d1e50c311d14addb158b0defa3771e87aace603df4f52e224`, 1,011 members and 16,561,358 archive bytes. The package comparison receipt confirms identical selected/smoke archives and no changed members. Host reports subsequent `54b50692` changes concern unshipped CI workflows; these receipts retain their original product identity.

## Archive inventory

| Group | Payload files | Original bytes | Gzip bytes |
| --- | ---: | ---: | ---: |
| gates | 12 | 576,057 | 141,625 |
| consumers | 19 | 9,712 | 3,728 |
| evalite | 11 | 25,840 | 6,846 |
| frontend | 135 | 8,637,015 | 6,743,290 |
| Total | 177 | 9,248,624 | 6,895,489 |

Counts cover archived payloads, excluding manifests, this README and the curation script. Every payload, including PNGs and empty logs, has a gzip file with mtime zero. Each group manifest records original source path, raw byte count/SHA256 and gzip byte count/SHA256. Curation decompressed every file and compared it byte-for-byte with the original. `manifest.json` holds aggregate counts. To inspect a receipt, use `gzip -dc gates/gno-release-64400ffe-tests.log.gz`; decompress PNGs into a scratch directory for viewing. `curate.py` records the precise selection and reproduction procedure.

Sources are `/home/gordon/.cache/agent-tmp/`: the twelve explicitly named gate files; all nineteen immediate files of `gno-final-consumers-6cp7uhwr`; immediate Evalite evidence plus its generated PNG under `fn154-evalite-compat`; and the ordinary evidence files of `fn154-frontend-qa`. Consumer installations, node_modules, Evalite's scoped symlink project, copied source trees, native QA and earlier release-cohort artifacts are excluded. Original failed attempts remain present. A credential-pattern scan of 127 text files covering these evidence roots and release logs found no matches for private keys, GitHub/OpenAI tokens or AWS access keys. Gate logs were inspected; package sentinel logs intentionally redact credential-bearing config contents. This is a bounded evidence inspection, not a general secret-detection guarantee.

## Gate observations

These are host-executed gates, curated without rerunning them. Exit success is host-observed; the logs supply the following detail:

- Full tests: 5,222 pass, 2 skip, 0 fail, 41,723 assertions; 5,224 tests across 615 files. Skips are the Windows detach case and opt-in headed Chromium clipper E2E.
- Final lint/format: zero errors, 26 warnings; format check passed. The earlier lint log is retained alongside final2.
- Typecheck passed. Documentation verification: 15 pass, 2 skip, 0 fail; model-dependent vsearch/hybrid checks skipped because that context had no cached embedding model.
- Root frozen install passed under Bun1.4.2. Maintained Electrobun-shell frozen install passed with its existing1.3.11 declarations and Electrobun1.16.0.
- Browser clipper build and archive verification passed. Archive SHA256 `cb9a683d5e8bddd30f0a2aaf00e252065c85e7779ff3da50e9e87636a855fd8d`.
- Isolated installed-package smoke passed: actual installed serve process, PDF worker/CMap/font GET/HEAD byte equality, packed fault contracts, daemon shutdown and unchanged isolation sentinel. Host verified exit0 with an explicit embedding model, so actual embedding warm was enabled; there is no separate warm-success line in the log.

Host's successful package command was `bun run test:package`, with repository `node_modules/.bin` first in PATH, `TMPDIR=/home/gordon/.cache/agent-tmp`, `HOME=/home/gordon/.cache/agent-tmp/gno-release-package-parent/home`, XDG_CONFIG_HOME/XDG_DATA_HOME/XDG_CACHE_HOME set to that same parent's `config`/`data`/`cache`, `GNO_PACKAGE_SMOKE_EMBED_MODEL=/home/gordon/.cache/gno/models/hf_Qwen_Qwen3-Embedding-0.6B-Q8_0.gguf`, and `GNO_PACKAGE_SMOKE_KEEP_TEMP=1`. Retained run directory: `/home/gordon/.cache/agent-tmp/gno-package-smoke-QuFo4Z`. Package-smoke script SHA256 at curation: `9f9f3cf8bff80d98315fc8670bf1a4b1b5622f38bb8aee0c7d814b797a611da3`. The host's executed invocation and exit, together with the log, are the warm acceptance evidence; reading source alone is not a QA result.

The first package-smoke run failed its real-user-state sentinel: config/data or receipt state changed. The host observed concurrent tests, but the cause of that change is **not proven**. That failure is preserved; the later isolated run proves its own unchanged empty parent state. The earlier run also skipped optional model warm because no explicit model was supplied.

## Consumer, Evalite and frontend boundaries

The consumer receipt contains actual independent full-GNO npm11.17.0 and Bun1.4.2 installs, all99 upstream vendor hashes, actual parser resolutions, XLSX/PPTX/PDF converter checks and production audits0 under both managers. Scripts were disabled; this does not prove native postinstall. Scripts, exit files, stdout/stderr and receipts are included, not installed dependency trees.

Evalite includes the actual server/WebSocket/file-type smoke, results, script and logs. Memory100% at threshold100; hybrid86% and BM25/vsearch88% at threshold70; all exited0. No remote model judge or native inference ran. Initial Bun1.3.14 cleanup timeouts remain; the successful Bun1.4.2 run also changed request cleanup, so runtime-version causality is not established.

Frontend's own verdict is **NEEDS_WORK**, with no open P0/P1 and three inherited P2 findings reproduced on baseline and candidate: relative Markdown link404, idle event-stream disconnect, and mobile graph overflow. The archived receipt retains exact baseline/candidate package versions and asset hashes. Successful editor/Markdown/graph/code-rendering checks and the22-screenshot PDF pass do not erase those findings. PDF CLEAN and INTERCEPTION observations remain separately named; intercepted error behavior is not a claim of unmodified production responses. Screenshots, scripts, request/console logs, metrics and initial failed attempts are included. Some frontend evidence preceded the final archive freeze; its recorded source/runtime identities remain authoritative rather than being relabeled as an independent final-package rerun.

No new tests, browser sessions or native execution were performed during curation. Local gate success does not replace the host's remaining native/platform QA or release decision. Root development image-size/uuid findings remain separate from the zero-vulnerability production consumer graphs.
