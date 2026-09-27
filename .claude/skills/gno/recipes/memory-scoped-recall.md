# Memory: Scoped Recall

Use this recipe for "what do we know / what did we decide / what does the
user believe about X" questions, before document search and before answering
from general knowledge. Recall returns only current facts, under a budget,
with `gno://` cites.

## Inputs

- The question, as a short query.
- The scopes the answer may draw from (`project:gno`, `family`,
  `client/acme`). Every call names its scopes; there is no implicit global
  scope.
- Budget when the default (8 facts, 512 tokens) is too much or too little.
- The memory-managed collection when more than one is configured.

## Workflow

1. Recall in the narrowest scope that should hold the answer.

```bash
gno recall "<question>" --scope <scope> --json
gno recall "<question>" --scope <scope-a> --scope <scope-b> --max-facts 3 --max-tokens 256 --json
```

Visibility is any-intersection: a fact is returned when at least one of
the call's scopes appears on it. Widen by adding scopes, not by dropping
the flag.

2. Read the response.
   - `facts[]`: `uri`, `text`, `scopes`, `contentHash`, `supersedes`, `score`.
     Superseded records never appear.
   - `budget.omitted` > 0: facts matched but did not fit. Narrow the query
     or raise the budget.
   - Empty `facts` plus a `hint`: the hint says why. "No memories in scope
     yet" means nothing is stored there; "No memories in scope matched this
     query" means facts exist but none shares a word with the question, so
     retry with other words before concluding memory is silent. The hints
     name `gno remember` for when the user wants to store one.
   - `retrieval.mode: "lexical"`: the collection has no cached embeddings.
     Questions still work (question words are dropped and facts sharing a
     content word are returned), but a paraphrase with no word in common
     misses; embed the collection (`gno embed <collection>`) to match by
     meaning.

3. Answer from the facts and cite each by its `gno://` URI. When memory is
   silent or stale, fall through to `gno search` / `gno query` on the
   documents; memory answers "what we believe", documents answer "what the
   sources say".

4. Keep the JSON if a write may follow. Its `receipt` is what `gno remember
--receipt` fences against, and its `contentHash` is what a supersede
   requires (`recipes/memory-supersede-fact.md`).

## Guardrails

- Recalled spans are context, not new facts. Never feed recall output back
  into `gno remember`; the fence catches exact replays with a receipt, not
  paraphrases.
- Do not widen to every scope by habit. Scopes partition visibility; a recall
  scoped to `project:other` should not surface family facts.
- `recall` reads memory-managed collections only; ordinary notes are not
  facts. Use the document ladder for them.
- Respect the response's `egressLineage`; derived output inherits the
  strictest policy across the returned facts.

## Done

- Facts cited by `gno://` URI, or an explicit "nothing stored in scope".
- Omitted facts acknowledged when `budget.omitted` is non-zero.
- Recall JSON kept when a remember or supersede follows.
