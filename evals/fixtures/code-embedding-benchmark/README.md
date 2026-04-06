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
- `oss-slices` - pinned public OSS repo slices materialized from local checkouts at run time

Result pages:

- [canonical.md](./canonical.md)
- [repo-serve.md](./repo-serve.md)

Primary use:

```bash
bun scripts/code-embedding-benchmark.ts --candidate bge-m3-incumbent --write
bun scripts/code-embedding-benchmark.ts --candidate bge-m3-incumbent --fixture repo-serve --write
bun scripts/code-embedding-benchmark.ts --candidate bge-m3-incumbent --fixture oss-slices --write
```

If a code-specific winner emerges on `repo-serve`, document it as a per-collection `models.embed` recommendation for code collections rather than immediately replacing the global default.
