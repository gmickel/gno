# Citation And Provenance

Use this recipe when accuracy, traceability, or auditability matters.

## Inputs

- Claim or answer to verify.
- Candidate local documents, URIs, or search terms.
- Required citation style: file path, `gno://` URI, document id, line range, or prose source list.

## Workflow

1. Choose the verification contract.

For an explicit local answer checked against one closed evidence set:

```bash
gno ask "<question>" --verify --show-sources
```

Through MCP, call `gno_ask` with the literal boolean `verify: true`. The tool
rejects implicit verification. It returns a closed Capsule, freshness receipt,
four-state claim verdicts, exact evidence IDs/line spans, gaps, semantic
capability state, and explicit abstention.

Use the manual path below when the client should synthesize itself, when you
need retrieval control, or when no generation model is available.

2. Search for evidence, then retrieve exact passages.

```bash
gno query "<claim>" --json
gno get <uri> --from <line> -l <count> --line-numbers
```

3. Prefer direct evidence over inference. Use graph/link expansion only to find supporting context, not to replace primary evidence.

```bash
gno backlinks <uri>
gno graph --from <uri-a> --to <uri-b>
```

4. Label claim status:

- supported by exact local evidence
- contradicted by exact local evidence
- insufficient local evidence
- uncertain because verification could not resolve the claim

5. When writing a new note, include source kind, source URL/path, author/person if known, and capture date.

6. Verify post-write retrieval when the citation note should be searchable.

```bash
gno index
gno search "<citation note title>"
```

## Guardrails

- Do not cite a snippet you did not retrieve.
- Do not collapse multiple sources into one citation.
- Do not hide uncertainty behind confident synthesis.
- Do not invent line ranges, URLs, IDs, or source dates.
- Treat verified Ask as support classification against its retained Capsule,
  not a general factual guarantee. It cannot prove corpus completeness or
  source truth.
- If the semantic verifier is unavailable, incapable, failed, or malformed,
  preserve `uncertain` and abstention; never upgrade a claim from guesswork.
- Contradiction requires conflicting evidence. Missing evidence is
  `insufficient`, not contradicted.

## Done

- Every important claim has evidence or an explicit gap.
- Citations are specific enough for a user to reopen the source.
- New provenance-bearing notes are findable.
