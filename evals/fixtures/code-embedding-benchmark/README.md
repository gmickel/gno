# Code Embedding Benchmark Fixtures

Small multi-language benchmark for comparing candidate embedding models on code retrieval.

Corpus:

- TypeScript / JavaScript
- Python
- Go
- Rust

Query types:

- natural language to code (`nl2code`)
- identifier-oriented lookups (`identifier`)

Fixtures:

- `canonical` - fixed small multi-language corpus
- `repo-serve` - real GNO code slice under `src/serve`

Primary use:

```bash
bun scripts/code-embedding-benchmark.ts --candidate bge-m3-incumbent --write
bun scripts/code-embedding-benchmark.ts --candidate bge-m3-incumbent --fixture repo-serve --write
```
