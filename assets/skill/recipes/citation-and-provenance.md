# Citation And Provenance

Use this recipe when accuracy, traceability, or auditability matters.

## Inputs

- Claim or answer to verify.
- Candidate local documents, URIs, or search terms.
- Required citation style: file path, `gno://` URI, document id, line range, or prose source list.

## Workflow

1. Search for evidence, then retrieve exact passages.

```bash
gno query "<claim>" --json
gno get <uri> --from <line> -l <count> --line-numbers
```

2. Prefer direct evidence over inference. Use graph/link expansion only to find supporting context, not to replace primary evidence.

```bash
gno backlinks <uri>
gno graph path --from <uri-a> --to <uri-b>
```

3. Label claim status:

- confirmed by local evidence
- partially supported
- contradicted
- not found locally

4. When writing a new note, include source kind, source URL/path, author/person if known, and capture date.

5. Verify post-write retrieval when the citation note should be searchable.

```bash
gno index
gno search "<citation note title>"
```

## Guardrails

- Do not cite a snippet you did not retrieve.
- Do not collapse multiple sources into one citation.
- Do not hide uncertainty behind confident synthesis.
- Do not invent line ranges, URLs, IDs, or source dates.

## Done

- Every important claim has evidence or an explicit gap.
- Citations are specific enough for a user to reopen the source.
- New provenance-bearing notes are findable.
