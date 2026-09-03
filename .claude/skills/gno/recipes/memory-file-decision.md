# Memory: File A Decision

Use this recipe when a conversation settles one fact that may later change (a
decision, a preference, a standing rule) and the agent should be able to
recall it next session. Documents and long notes go through
`recipes/capture-and-file.md`; this recipe stores one fact.

## Inputs

- The fact, in one or two sentences, as it should be recalled later.
- One to eight explicit scopes (`project:gno`, `family`, `client/acme`).
  There is no implicit global scope; every call names its scopes.
- Source evidence when known (a meeting, a message, a URL — never a `gno://`
  URI, which the fence rejects as GNO-derived).
- The memory-managed collection when more than one is configured.

## Workflow

1. Recall first so a fact that already exists is not filed twice.

```bash
gno recall "<the topic>" --scope <scope> --json > /tmp/recall.json
```

2. Propose the fact. Without a decision `remember` writes nothing and returns
   `outcome: "candidates"` with likely and weak matches from the same scopes.

```bash
gno remember "<fact>" --scope <scope> --json
```

3. Decide from the candidates. GNO never adjudicates a likely match; the
   caller does.
   - No match, or the match is a different fact: add.
   - A match says the same thing: stop; `outcome: "existing"` means nothing
     is written and the record is already current.
   - A match is the same fact with stale content: switch to
     `recipes/memory-supersede-fact.md`.

```bash
gno remember "<fact>" --scope <scope> --add \
  --source "<where this came from>" --receipt /tmp/recall.json --json
```

4. Read the result. `outcome: "added"` plus `sync.status: "completed"` means
   the fact file exists and is retrievable now; a `failed` sync means the
   file exists and the index lags (`gno update <collection>`).

5. Verify by recalling it back and cite the returned `uri`.

```bash
gno recall "<distinctive phrase>" --scope <scope>
```

## Guardrails

- Store what the user said or decided, not GNO's own recall output. Pass the
  recall receipt (`--receipt`) so a recalled span cannot be re-filed as new;
  a paraphrase without lineage cannot be fenced, so do not paraphrase
  recalled facts into new ones.
- Never store a fact without an explicit `--add`; a question alone is
  read-only, and `remember` without a decision is a proposal.
- Scopes are visibility, not access control. Pick the scope the fact belongs
  to; use a shared scope name only when several callers agree on it.
- `remember` works only on a collection with `memoryManaged: true`; other
  collections fail with `MEMORY_COLLECTION_UNMANAGED`. Do not fall back to
  `gno capture` for a fact that may change.
- Keep the text self-contained; recall returns the fact without the
  conversation that produced it.

## Done

- `outcome: "added"` with a `gno://` URI, or `existing` with the current
  record.
- Recall in the same scope returns the fact.
- The user's wording, scopes, and source are preserved.
