# fts5-snowball Vendored Binaries

Prebuilt [fts5-snowball](https://github.com/abiliojr/fts5-snowball) SQLite extension for multilingual FTS5 stemming.

## Supported Platforms

| Platform | File                             | Architecture          |
| -------- | -------------------------------- | --------------------- |
| Linux    | `linux-x64/fts5stemmer.so`       | x86_64                |
| macOS    | `darwin-arm64/fts5stemmer.dylib` | ARM64 (Apple Silicon) |
| macOS    | `darwin-x64/fts5stemmer.dylib`   | x86_64 (Intel)        |
| Windows  | `windows-x64/fts5stemmer.dll`    | x86_64                |

## Build Provenance

Built via GitHub Actions: `.github/workflows/build-fts5-snowball.yml`

Source: https://github.com/abiliojr/fts5-snowball (commit from main branch)

## Supported Languages

The Snowball stemmer supports: Arabic, Basque, Catalan, Danish, Dutch, English, Finnish, French, German, Greek, Hindi, Hungarian, Indonesian, Irish, Italian, Lithuanian, Nepali, Norwegian, Porter, Portuguese, Romanian, Russian, Serbian, Spanish, Swedish, Tamil, Turkish, Yiddish.

## Usage

```typescript
import { Database } from "bun:sqlite";

// Load extension
db.loadExtension("vendor/fts5-snowball/darwin-arm64/fts5stemmer.dylib");

// Create FTS table with snowball tokenizer
db.exec(
  `CREATE VIRTUAL TABLE docs USING fts5(content, tokenize='snowball english')`
);
```

## License

BSD-3-Clause. See LICENSE file.
