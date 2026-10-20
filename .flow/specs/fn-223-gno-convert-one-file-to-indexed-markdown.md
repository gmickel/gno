# gno convert: one file to indexed Markdown

## Conversation Evidence

> user (turn 2): "Assume we'll build the pure wins (#313 multi-collection search, #314 gno convert, #316 audit link/path rules) ourselves"
> user (turn 2): "reference the original PR(s) and say it supersedes them"
> user (turn 2): "if a shape looks wrong for gno (API surface, config keys, limits like the 1024 bound, naming), redesign it and say why"
> user (turn 3): "Just say the spec supersedes the referenced PR(s) and uses them as reference for the intended outcome."

## Goal & Context
<!-- scope: business -->

<!-- Source: 10% user / 30% [paraphrase] / 60% [inferred] -->

This spec supersedes #314 and uses it as reference for the intended outcome. Its CHANGELOG entry credits @ArnauvGilotra for the idea and the original pull request.

Getting the Markdown GNO would index for a PDF, Office file or other supported format currently means adding the file to a collection, running `gno update`, then reading the mirror back. Tools and people who build notes from such files want that exact Markdown without touching config or the index. `gno convert <file>` runs one file through the indexing conversion path and prints the result. Because it uses the same path, its output matches what indexing stores for the same bytes.

## Architecture & Data Models
<!-- scope: technical -->

<!-- Source: 100% [inferred] -->

- Conversion goes through the same entry point indexing uses: mime detection, then the converter pipeline, then canonicalization and the mirror hash. It uses the same default size, time and output limits indexing uses.
- No config, store, index, cache or model state is read or written. The command works with no GNO config present.
- Single-document formats (Markdown, plain text, PDF, Office and the other one-file-one-document converters) are supported. Formats whose adapters split one file into several records (mail archives, calendars, JSONL, transcripts, browser exports) derive record identity from the collection and path, so a collection-less conversion would not match indexing. They are refused (see API Contracts).
- The SDK exposes the same operation as a function, for embedding without a subprocess.

## API Contracts
<!-- scope: technical -->

<!-- Source: 100% [inferred] -->

```bash
gno convert <file> [--json]
```

- **Terminal output:** the Markdown only, on stdout. Conversion warnings go to stderr.
- **`--json`:** `convert@1.0`, validated by `spec/output-schemas/convert.schema.json`:

```json
{
  "schemaVersion": "convert@1.0",
  "source": { "path": "/abs/report.pdf", "mime": "application/pdf", "ext": ".pdf", "sizeBytes": 48213 },
  "converter": { "id": "pdf", "version": "1.2.0" },
  "title": "Quarterly report",
  "languageHint": "en",
  "markdown": "# Quarterly report\n...",
  "mirrorHash": "sha256:…",
  "warnings": [{ "code": "…", "message": "…" }]
}
```

- **SDK:** `convertFile(path)` returns the same object.
- **Errors** use the standard CLI error envelope, with `details.reason` set to the conversion code:

| Case | `details.reason` | Exit |
|---|---|---|
| Path missing or not a regular file | `NOT_FOUND` | 1 |
| Larger than the indexing size limit (checked before reading) | `TOO_LARGE` | 1 |
| No converter for the type | `UNSUPPORTED` | 1 |
| Multi-record format | `MULTI_DOCUMENT` | 1 |
| Converter failure, timeout, corrupt input | the converter's code | 2 |

## Edge Cases & Constraints
<!-- scope: technical -->

<!-- Source: 100% [inferred] -->

- Directories, symlinks to directories and special files are `NOT_FOUND`. A symlink to a regular file is converted.
- An oversized file is never loaded into memory.
- Output on stdout is exactly the Markdown, with no banner or trailing summary, so it can be piped.
- Docs: `spec/cli.md`, the new output schema and its contract test, `docs/CLI.md`, `docs/SDK.md`, CHANGELOG and the hosted gno.sh CLI reference ship with the change.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** `gno convert <file>` prints the Markdown GNO would index for that file. For a fixture of each single-document converter type, the Markdown and `mirrorHash` equal the mirror that `gno update` stores for the same bytes. [paraphrase] Errors: the table in API Contracts.
- **R2:** The command reads and writes no GNO config, index, store or cache. It succeeds on a machine with no GNO config, and leaves the data directory byte-identical when one exists. [paraphrase] Errors: no error surface beyond R1.
- **R3:** `--json` output validates against `convert@1.0` and contains exactly the fields shown. [inferred] Errors: no error surface beyond R1.
- **R4:** Each error case in the table produces its `details.reason` and exit code. A file over the size limit is refused without being read. [inferred] Errors: as stated.
- **R5:** Multi-record formats are refused with `MULTI_DOCUMENT`, naming the detected format, and produce no partial output. [inferred] Errors: as stated.
- **R6:** The SDK `convertFile` returns the same object as `--json` for the same file and raises the same reasons as typed errors. [inferred] Errors: as R4.

## Boundaries
<!-- scope: business -->

- No MCP tool and no REST endpoint. [inferred]
- No batch or directory conversion, no output-file flag, no conversion options beyond what indexing uses. [inferred]
- No support for multi-record formats in this spec. [inferred]

## Decision Context
<!-- scope: both — conditionally substructured -->

The intended outcome follows #314: one file, the same Markdown indexing would store, nothing persisted. These shape changes from #314 are deliberate: [inferred]

- **No `--max-bytes`.** The point is "what indexing would store", and indexing's limit is the meaningful one. A second, lower cap adds a flag with no use case in gno. Callers that want a lower cap can check the size first.
- **Multi-record formats refused.** #314 converted them with an empty collection and the file name as path. Their record identity then differs from indexing's, so the "same as indexing" promise would quietly not hold. Refusing keeps the promise exact. Supporting them later means returning several documents, which is a different output shape.
- **SDK function added.** Cross-surface parity is a strategy metric, and the SDK is how programs embed GNO without a subprocess. MCP and REST are left out because they would read arbitrary host paths on behalf of a remote or browser caller, which cuts against GNO's host-path redaction and explicit egress posture.

## Strategy Alignment

- Local knowledge lifecycle: one dependable conversion path for heterogeneous files, usable before anything is indexed. [strategy:Local knowledge lifecycle]
- Coherent agent and application surfaces: CLI and SDK share one contract. MCP and REST are left out with the reason recorded. [strategy:Coherent agent and application surfaces]
