# CJK Lexical Degradation Benchmark Fixtures

Small, deterministic Chinese, Japanese, and Korean corpus for measuring GNO's
lexical fallback before changing any production tokenizer or normalizer.

## Contents

- `manifest.json` — fixture version, coverage minimums, license review, and
  Unicode policy
- `sources.json` — one provenance record and SHA-256 digest per corpus document
- `queries.json` — same-language cases with explicit diagnostic categories
- `qrels.json` — graded relevance judgments on a 0–3 scale
- `corpus/{zh,ja,ko}/` — seven opaque Markdown documents per language
- `2026-07-22.{json,md}` — immutable production and diagnostic baseline
- `latest.{json,md}` — convenience copies of the current baseline
- `promotion-gates.{json,md}` — machine-readable and human-readable `fn-109`
  quality, non-regression, and cost contract

The document paths (`d001.md`, and so on) and query IDs are deliberately opaque.
Queries may name a filename that appears **inside** a document, but never the
benchmark document path or ID. This lets later benchmark lanes measure content
and filename-token behavior without winning from answer-bearing fixture paths.

## Provenance and license

All documents, queries, judgments, and metadata in this directory are original
synthetic material authored for the GNO project on 2026-07-22. No upstream or
web corpus text was copied. They are distributed under the repository's MIT
license; `manifest.json` records the license scope and review result, while
`sources.json` freezes each document's digest.

The corpus is intentionally a controlled regression fixture, not a representative
sample of Chinese, Japanese, Korean, regional usage, or production relevance.
Synthetic prose cannot establish broad language quality on its own.

## Coverage

Each language has at least eight independently reported queries covering:

- exact multi-character terms
- ASCII identifiers
- mixed Latin/CJK strings
- token-boundary and spacing changes
- punctuation changes
- content-level filenames
- Unicode normalization variants

Chinese includes simplified and traditional prose. Japanese includes kana and
kanji. Korean includes composed Hangul. The corpus is stored as UTF-8 NFC;
specific queries deliberately use NFD or NFKC-equivalent text to expose degraded
lexical behavior.

## Validation

The standard offline test suite validates licenses, hashes, shapes, per-language
minimums, required categories, qrel integrity, Unicode variants, opaque paths,
and query/path leakage:

```bash
bun test test/bench/cjk*.test.ts
bun run bench:cjk-lexical
```

The benchmark is deterministic and model-free. Timings remain machine-specific,
so promotion compares candidate and production analyzers in the same run. All
positive qrels currently use relevance `3`; nDCG measures rank placement but not
differences among positive gain grades. Production tokenization and
normalization remain unchanged.
