# fn-30-ask-query-mode-parity-in-webapi.2 Add explicit query negation support across CLI, API, and Web

## Description

TBD

## Acceptance

- Add explicit exclusion inputs to retrieval requests, without overloading raw query text.
- CLI query/search/ask expose negation option(s) (e.g. `--exclude <terms>` comma-separated or repeatable) and pass through pipeline.
- Web Search + Ask advanced controls expose exclusion terms and keep URL/state roundtrip parity.
- API `/api/query` and `/api/ask` accept exclusion field(s), validate shape, and pass through to retrieval.
- Retrieval pipeline applies exclusion as hard filter on candidate docs (title/snippet/body metadata per defined spec), with deterministic behavior.
- MCP surface updated if relevant schema mirrors query/ask inputs.
- Tests added/updated: parser/validation, route handlers, pipeline behavior, and at least one end-to-end parity test for CLI vs API.
- Docs/spec updated (README/docs/spec schemas) including examples and caveats.

## Done summary
Implemented explicit exclusion filters across CLI, API, Web, and MCP retrieval surfaces. Exclusions now hard-prune candidate docs by title/path/body text in BM25, vector, hybrid, and ask flows. Added parser/state/route/pipeline coverage and verified live CLI/API smoke for intent + candidateLimit + exclude.
## Evidence
- Commits:
- Tests: bun run lint:check, bun test, bun /Users/gordon/work/gno/src/index.ts query "performance" --intent "web performance and latency" --exclude "reviews" --candidate-limit 8 --limit 5 --json, bun /Users/gordon/work/gno/src/index.ts search "performance" --intent "web performance and latency" --exclude "reviews" --limit 5 --json, bun /Users/gordon/work/gno/src/index.ts ask "performance" --intent "web performance and latency" --exclude "reviews" --candidate-limit 8 --limit 3 --no-answer --json, curl -sS -X POST http://127.0.0.1:3314/api/query ..., curl -sS -X POST http://127.0.0.1:3314/api/search ..., curl -sS -X POST http://127.0.0.1:3314/api/ask ...
- PRs: