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

Primary use:

```bash
bun scripts/code-embedding-benchmark.ts --candidate bge-m3-incumbent --write
```
